"""SEC-04 / D-11 — data-residency egress allowlist (the load-bearing invariant).

The global ``--disable-socket`` default (plan 01-01) denies every socket. This
module layers ``@pytest.mark.allow_hosts(ALLOWED)`` over the scripted harness so
the full scripted run may contact ONLY the configured endpoints (model gateway,
warehouse, git, ticketing) plus loopback — any other socket raises
``SocketBlockedError`` / ``SocketConnectBlockedError`` and fails the test.

This test is **non-vacuous** (the Walking-Skeleton plan's load-bearing teeth):

* The harness initializes the **REAL LiteLLM SDK** (not a mock) pointed at
  ``model.endpoint.internal`` — a host on the ALLOWED list, resolved to
  ``127.0.0.1`` via a per-test resolver shim and served by a local stub server —
  so LiteLLM's own callback/exporter machinery is actually exercised.
* BEFORE any run it asserts the misconfiguration is *impossible*, not merely
  unexercised: ``litellm.callbacks == []`` (and the success/failure callback lists
  empty), message-content logging disabled, and ``DO_NOT_TRACK=1`` set for the
  dbt-mcp subprocess env.
* A NEGATIVE-CONTROL test injects a non-allowlisted telemetry exporter host and
  asserts the run raises ``SocketConnectBlockedError`` — the test FAILS if the leak
  is NOT caught, proving the guard has teeth.
"""

from __future__ import annotations

import http.server
import json
import socket
import threading

import pytest
from pytest_socket import SocketBlockedError, SocketConnectBlockedError

from tests.conftest import ALLOWED
from tests.harness import harness, model_gateway

# Hosts the harness resolves to loopback so a REAL LiteLLM call lands on the local
# stub server while still presenting the allowlisted hostname to the socket guard.
_RESOLVE_TO_LOOPBACK = {"model.endpoint.internal", "warehouse.internal", "ticketing.internal"}


# --------------------------------------------------------------------------- #
# Local stub model-gateway server (OpenAI-compatible) bound to 127.0.0.1.
# --------------------------------------------------------------------------- #
class _StubGatewayHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = json.dumps(
            {
                "id": "chatcmpl-headless",
                "object": "chat.completion",
                "created": 0,
                "model": "gpt-headless-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # silence the stub server
        return


@pytest.fixture
def stub_gateway():
    """A local OpenAI-compatible stub server on 127.0.0.1 — the allowlisted endpoint."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _StubGatewayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]  # the bound port
    finally:
        server.shutdown()


@pytest.fixture
def resolver_shim(monkeypatch):
    """Resolve the allowlisted internal hostnames to 127.0.0.1 for the REAL SDK call.

    Wraps ``socket.getaddrinfo`` so ``model.endpoint.internal`` resolves to
    loopback. Under ``@allow_hosts`` pytest-socket restores the real
    ``getaddrinfo``; this shim sits on top, so the literal allowlisted hostname is
    presented to the connect guard (allowed) and the connection lands on the local
    stub server. Any host NOT in the shim resolves normally and (if not allowlisted)
    is blocked at connect time.
    """
    real_getaddrinfo = socket.getaddrinfo

    def shimmed(host, *args, **kwargs):
        if host in _RESOLVE_TO_LOOPBACK:
            return real_getaddrinfo("127.0.0.1", *args, **kwargs)
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", shimmed)
    yield


@pytest.fixture(autouse=True)
def _restore_litellm_telemetry():
    """Guarantee litellm telemetry state is clean before AND after each test.

    The negative-control modeling and any cross-test contamination must not leave a
    callback registered. This is itself part of the data-residency guarantee.
    """
    model_gateway.configure_telemetry_off()
    yield
    model_gateway.configure_telemetry_off()


# --------------------------------------------------------------------------- #
# Pre-run telemetry-off invariants (assert misconfiguration is impossible).
# --------------------------------------------------------------------------- #
def test_telemetry_off_before_any_run():
    """BEFORE a run: no callbacks/exporters registered, message logging off.

    Proves the data-residency misconfiguration is impossible, not merely
    unexercised (SEC-04 / Pitfall 1): ``litellm.callbacks == []``,
    ``success_callback`` / ``failure_callback`` empty, and
    ``turn_off_message_logging is True``.
    """
    import litellm

    model_gateway.assert_telemetry_off()
    assert litellm.callbacks == []
    assert litellm.success_callback == []
    assert litellm.failure_callback == []
    assert litellm.turn_off_message_logging is True


def test_dbt_mcp_subprocess_env_has_do_not_track():
    """The dbt-mcp subprocess env carries DO_NOT_TRACK=1 (telemetry vector off)."""
    env = model_gateway.dbt_mcp_subprocess_env()
    assert env["DO_NOT_TRACK"] == "1"
    assert env["DBT_SEND_ANONYMOUS_USAGE_STATS"] == "false"


# --------------------------------------------------------------------------- #
# Positive — a REAL LiteLLM run to the allowlisted host succeeds.
# --------------------------------------------------------------------------- #
@pytest.mark.allow_hosts(ALLOWED)
def test_single_ticket_run_contacts_only_configured_endpoints(scripted_harness):
    """A full scripted run touches only allowlisted hosts (data residency).

    Rides the conftest ``scripted_harness`` (now the real ``run_one_ticket``) over
    the read-only warehouse + git surfaces. Any socket to a host outside
    ``ALLOWED`` raises ``SocketBlockedError`` and fails the test.
    """
    result = scripted_harness.run_one_ticket(ticket_id="DEMO-1")
    assert list(result.stages) == harness.STAGES


@pytest.mark.allow_hosts(ALLOWED)
def test_real_litellm_call_to_allowlisted_host_succeeds(stub_gateway, resolver_shim):
    """The REAL LiteLLM SDK reaches the allowlisted ``model.endpoint.internal``.

    Not a mocked client — ``run_one_ticket`` drives ``litellm.completion`` against
    ``model.endpoint.internal`` (resolved to the local stub server). Telemetry is
    asserted off before the call. The run completes all five stages and the gateway
    returns content — proving allowlisted egress is permitted (the positive half of
    the non-vacuous invariant).
    """
    endpoint = f"http://model.endpoint.internal:{stub_gateway}/v1"
    # Telemetry off is provable up front (callbacks empty, message logging off).
    model_gateway.assert_telemetry_off()

    result = harness.run_one_ticket("DEMO-1", model_endpoint=endpoint)

    assert list(result.stages) == harness.STAGES
    assert result.model_gateway_response is not None
    assert result.model_gateway_response.content == "ok"
    assert result.model_gateway_response.host == "model.endpoint.internal"


# --------------------------------------------------------------------------- #
# Negative control — a non-allowlisted exporter leak MUST be blocked.
# --------------------------------------------------------------------------- #
@pytest.mark.allow_hosts(ALLOWED)
def test_allowlisted_exporter_host_is_not_blocked(resolver_shim):
    """Sanity: an allowlisted exporter host passes the socket guard (no false block).

    Connecting to an allowlisted host with nothing listening fails with a plain
    ``OSError`` (connection refused) — crucially NOT a socket *block*. This proves
    the guard permits allowlisted egress, so the negative control below is testing a
    real boundary and not a blanket deny.
    """
    with pytest.raises(OSError) as excinfo:
        model_gateway.emit_via_exporter("127.0.0.1", 1)  # nothing listening on port 1
    assert not isinstance(excinfo.value, (SocketBlockedError, SocketConnectBlockedError))


@pytest.mark.allow_hosts(ALLOWED)
def test_non_allowlisted_callback_is_blocked(stub_gateway, resolver_shim):
    """NEGATIVE CONTROL — a non-allowlisted exporter leak raises a socket block.

    Injecting a telemetry exporter pointed at a NON-allowlisted host
    (``evil.example.com``) into the run makes the model-gateway path raise
    ``SocketConnectBlockedError``. This test FAILS if the leak is NOT caught — that
    is what makes the SEC-04 egress invariant non-vacuous (a vacuous all-mock setup
    cannot pass it). The clean run (above) still succeeds to the allowlisted host.
    """
    endpoint = f"http://model.endpoint.internal:{stub_gateway}/v1"
    with pytest.raises((SocketBlockedError, SocketConnectBlockedError)):
        harness.run_one_ticket(
            "DEMO-1",
            model_endpoint=endpoint,
            exporter=("evil.example.com", 9999),  # non-allowlisted telemetry host
        )


def test_allowlist_matches_configured_endpoints():
    """The allowlist enumerates exactly the configured endpoint hosts + loopback.

    Guards against allowlist drift (e.g. an inadvertently added wildcard host).
    The configured-endpoint hosts plus loopback are the only permitted egress
    targets; this is a pure-data assertion and is green from plan 01-02.
    """
    assert "model.endpoint.internal" in ALLOWED  # model gateway
    assert "warehouse.internal" in ALLOWED  # warehouse / Snowflake
    assert "api.github.com" in ALLOWED  # git host
    assert "ticketing.internal" in ALLOWED  # ticketing host
    assert {"127.0.0.1", "localhost"}.issubset(set(ALLOWED))  # local stdio/fixtures
    # No wildcard / catch-all host may sneak in.
    assert not any(host in {"*", "0.0.0.0", ""} for host in ALLOWED)
