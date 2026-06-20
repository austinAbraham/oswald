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

from tests.conftest import (
    ALLOWED,
    PERIPHERAL_CONNECTOR_HOSTS,
    POSTURES,
    WAREHOUSE_AND_MODEL_LOCAL,
)
from tests.harness import harness, model_gateway

# Hosts the harness resolves to loopback so a REAL LiteLLM call lands on the local
# stub server while still presenting the allowlisted hostname to the socket guard.
# ``api.github.com`` is included so the convenience-posture peripheral-egress probe
# lands on loopback (connection-refused) instead of making a real external connect
# — it still presents the peripheral hostname to the connect guard (permitted under
# convenience, blocked under locked-down), proving the boundary without real egress.
_RESOLVE_TO_LOOPBACK = {
    "model.endpoint.internal",
    "warehouse.internal",
    "ticketing.internal",
    "api.github.com",
}


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

    EXTENDED (Plan 04 / D-08): also assert the posture split is *exhaustive* — the
    union of ``WAREHOUSE_AND_MODEL_LOCAL`` and ``PERIPHERAL_CONNECTOR_HOSTS`` is
    exactly ``ALLOWED`` (no host is silently dropped or added) — and that the
    no-wildcard guarantee holds across both halves of the split.
    """
    assert "model.endpoint.internal" in ALLOWED  # model gateway
    assert "warehouse.internal" in ALLOWED  # warehouse / Snowflake
    assert "api.github.com" in ALLOWED  # git host
    assert "ticketing.internal" in ALLOWED  # ticketing host
    assert {"127.0.0.1", "localhost"}.issubset(set(ALLOWED))  # local stdio/fixtures
    # No wildcard / catch-all host may sneak in.
    assert not any(host in {"*", "0.0.0.0", ""} for host in ALLOWED)

    # D-08 posture split is exhaustive and wildcard-free across both halves.
    assert set(WAREHOUSE_AND_MODEL_LOCAL) | set(PERIPHERAL_CONNECTOR_HOSTS) == set(ALLOWED)
    # The residency-critical half carries the warehouse + model + loopback only.
    assert {"model.endpoint.internal", "warehouse.internal"}.issubset(
        set(WAREHOUSE_AND_MODEL_LOCAL)
    )
    assert {"127.0.0.1", "localhost"}.issubset(set(WAREHOUSE_AND_MODEL_LOCAL))
    # The peripheral half carries ONLY the relaxable git/ticketing SaaS hosts — the
    # warehouse-data path is never a peripheral host (D-08, load-bearing).
    assert "warehouse.internal" not in PERIPHERAL_CONNECTOR_HOSTS
    assert "model.endpoint.internal" not in PERIPHERAL_CONNECTOR_HOSTS
    assert not any(
        host in {"*", "0.0.0.0", ""}
        for host in (*WAREHOUSE_AND_MODEL_LOCAL, *PERIPHERAL_CONNECTOR_HOSTS)
    )


# --------------------------------------------------------------------------- #
# D-08 — posture-aware data-residency invariant.
#
# The warehouse/model-SQL path is asserted LOCAL in BOTH postures; convenience
# relaxes ONLY peripheral connector hosts (tickets/git/docs SaaS whose data
# already lives there), NEVER the warehouse. The warehouse-data leak negative
# control (``evil.example.com``) is IDENTICAL in both postures.
# --------------------------------------------------------------------------- #
def _posture_allow(posture: str) -> list[str]:
    """The egress allowlist a given posture permits (D-08).

    * ``locked-down`` — ONLY the residency-critical warehouse/model/loopback half.
    * ``convenience`` — that half PLUS the relaxable peripheral connector hosts.

    The warehouse-data path is local in BOTH; convenience never adds the
    warehouse-leak target.
    """
    if posture == "locked-down":
        return list(WAREHOUSE_AND_MODEL_LOCAL)
    return list(WAREHOUSE_AND_MODEL_LOCAL) + list(PERIPHERAL_CONNECTOR_HOSTS)


@pytest.mark.allow_hosts(ALLOWED)
@pytest.mark.parametrize("posture", ["convenience", "locked-down"])
def test_warehouse_path_local_in_both_postures(posture, stub_gateway, resolver_shim):
    """D-08 — the warehouse-data negative control raises in BOTH postures.

    Computes the posture's ``allow`` set (locked-down = warehouse/model/loopback
    only; convenience = that PLUS peripheral hosts), applies it dynamically via
    ``socket_allow_hosts`` (carving out the AF_UNIX self-pipe like the suite-wide
    addopts), then drives the scripted run with a warehouse-data leak injected to a
    NON-configured host (``evil.example.com``). The leak MUST raise a socket block
    in BOTH postures — convenience only relaxes *peripheral* egress, never the
    warehouse path (D-08, load-bearing). This reuses the exact M1 negative-control
    shape (``exporter=("evil.example.com", 9999)`` →
    ``(SocketBlockedError, SocketConnectBlockedError)``).

    The ``@allow_hosts(ALLOWED)`` marker enables socket *creation* (the
    ``--disable-socket`` default blocks ``socket.socket()`` itself); the in-test
    ``socket_allow_hosts(allow, ...)`` then NARROWS the permitted connect targets to
    the posture's set, so locked-down genuinely forbids the peripheral hosts while
    ``evil.example.com`` is blocked in both.
    """
    from pytest_socket import socket_allow_hosts

    # Posture-aware allowlist; evil.example.com is in NEITHER posture's set.
    allow = _posture_allow(posture)
    assert "evil.example.com" not in allow
    # The warehouse path is local in both postures (the residency-critical half is
    # always present, regardless of posture).
    assert set(WAREHOUSE_AND_MODEL_LOCAL).issubset(set(allow))

    socket_allow_hosts(allow, allow_unix_socket=True)
    # Telemetry off is provable up front (the non-vacuous backbone is unchanged).
    model_gateway.assert_telemetry_off()

    endpoint = f"http://model.endpoint.internal:{stub_gateway}/v1"
    with pytest.raises((SocketBlockedError, SocketConnectBlockedError)):
        harness.run_one_ticket(
            "DEMO-1",
            model_endpoint=endpoint,
            exporter=("evil.example.com", 9999),  # warehouse-data leak target
        )


@pytest.mark.allow_hosts(ALLOWED)
def test_convenience_allows_peripheral(stub_gateway, resolver_shim):
    """convenience permits (documents) a peripheral host while the warehouse stays local.

    Under ``convenience`` a peripheral-connector host (``api.github.com`` from
    ``PERIPHERAL_CONNECTOR_HOSTS``) is permitted through the socket guard — a plain
    connection-refused (``OSError``), NOT a socket *block* — proving convenience
    relaxes (documents) peripheral egress. A warehouse-data leak to a non-configured
    host (``evil.example.com``) is STILL blocked, proving convenience never relaxes
    the warehouse path (D-08).
    """
    from pytest_socket import socket_allow_hosts

    allow = _posture_allow("convenience")
    assert "api.github.com" in allow  # peripheral host permitted under convenience
    assert "evil.example.com" not in allow

    socket_allow_hosts(allow, allow_unix_socket=True)
    model_gateway.assert_telemetry_off()

    # A peripheral host is permitted: it fails only on connection-refused, NOT a block.
    with pytest.raises(OSError) as excinfo:
        model_gateway.emit_via_exporter("api.github.com", 1)  # nothing listening on port 1
    assert not isinstance(excinfo.value, (SocketBlockedError, SocketConnectBlockedError))

    # The warehouse-data leak to a non-configured host is STILL blocked under convenience.
    with pytest.raises((SocketBlockedError, SocketConnectBlockedError)):
        model_gateway.emit_via_exporter("evil.example.com", 9999)


# --------------------------------------------------------------------------- #
# MODE-01 / D-07 — locked-down requires a self-hosted model endpoint.
#
# probe_model_residency FAILs (naming the endpoint host) when posture==locked-down
# and the model endpoint is a public/off-boundary host; it PASSes under convenience
# (the trust boundary is documented, not enforced). The probe is deterministic and
# offline — it inspects the configured endpoint string only (no DNS, no call) — so
# these tests need no live model and no socket.
# --------------------------------------------------------------------------- #
_PUBLIC_MODEL_ENDPOINT = "https://api.anthropic.com/v1"
_INTERNAL_MODEL_ENDPOINT = "https://model.endpoint.internal/v1"


def _config_with(*, posture: str, endpoint: str):
    """Load the shipped example config and override posture + the model endpoint."""
    from oswald.config import load_config

    cfg = load_config()
    new_model = cfg.model.model_copy(update={"endpoint": endpoint})
    return cfg.model_copy(update={"posture": posture, "model": new_model})


def test_locked_down_requires_self_hosted_model():
    """locked-down: a public model endpoint FAILs (naming it); an internal one PASSes."""
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model_residency

    # Public endpoint under locked-down → FAIL naming the endpoint host.
    fail = probe_model_residency(_config_with(posture="locked-down", endpoint=_PUBLIC_MODEL_ENDPOINT))
    assert len(fail) == 1
    assert fail[0].status is CheckStatus.FAIL
    assert "api.anthropic.com" in fail[0].message  # the probe NAMES the endpoint host
    assert "self-hosted" in fail[0].message.lower()
    # The probe never echoes a secret (the api_key resolves to "" from env here, but
    # the message must not carry any secret-looking value regardless).
    assert "BEGIN PRIVATE KEY" not in fail[0].message
    assert "${" not in fail[0].message

    # Internal/self-hosted endpoint under locked-down → PASS.
    ok = probe_model_residency(_config_with(posture="locked-down", endpoint=_INTERNAL_MODEL_ENDPOINT))
    assert len(ok) == 1
    assert ok[0].status is CheckStatus.PASS
    assert "model.endpoint.internal" in ok[0].message


def test_convenience_does_not_enforce_model_residency():
    """convenience: the SAME public endpoint does NOT FAIL (documented boundary, D-07)."""
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model_residency

    results = probe_model_residency(_config_with(posture="convenience", endpoint=_PUBLIC_MODEL_ENDPOINT))
    assert len(results) == 1
    assert results[0].status is not CheckStatus.FAIL  # PASS/WARN — never a FAIL


# WR-02 — the residency classifier must use exact label/suffix matching and must
# NOT trust a public domain embedded under an attacker-registrable internal suffix.
# A public model domain buried as a deeper label of `.internal`/`.local` is the
# self-inflicted-misconfig vector the conservative locked-down check must catch.
_SPOOFED_PUBLIC_ENDPOINTS = [
    "https://api.anthropic.com.evil.internal/v1",  # public domain + .internal suffix
    "https://api.openai.com.attacker.local/v1",  # public domain + .local suffix
    "https://api.anthropic.com.svc.cluster.local/v1",  # buried under k8s suffix
    "http://openrouter.ai.intranet/v1",  # public domain + .intranet
]


@pytest.mark.parametrize("endpoint", _SPOOFED_PUBLIC_ENDPOINTS)
def test_locked_down_rejects_public_domain_under_internal_suffix(endpoint):
    """WR-02 — a public model domain embedded under an internal suffix FAILs locked-down.

    These hosts END in a recognized internal suffix, so the original
    ``host.endswith(suffix)`` heuristic classified them on-boundary and PASSED —
    silently allowing prompts/EDA/ticket text to egress to a public provider. The
    label-aware classifier must now FAIL them (non-vacuous: PASSed pre-fix).
    """
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model_residency

    results = probe_model_residency(_config_with(posture="locked-down", endpoint=endpoint))
    assert len(results) == 1
    assert results[0].status is CheckStatus.FAIL, (
        f"locked-down must FAIL a public domain embedded under an internal suffix: {endpoint}"
    )


def test_legit_internal_suffix_host_still_passes_locked_down():
    """WR-02 — a genuine internal-suffixed host (no embedded public domain) still PASSES.

    The hardening must not over-reject: an honest ``vllm.internal`` /
    ``litellm.svc.cluster.local`` stays on-boundary so air-gapped deployments work.
    """
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model_residency

    for endpoint in (
        "https://vllm.internal/v1",
        "https://litellm.svc.cluster.local/v1",
        "https://ollama:11434/v1",  # single-label intranet short name
        "http://10.0.0.5:8000/v1",  # RFC1918 literal
    ):
        results = probe_model_residency(_config_with(posture="locked-down", endpoint=endpoint))
        assert results[0].status is CheckStatus.PASS, f"legit internal endpoint must PASS: {endpoint}"


def test_is_self_hosted_host_uses_exact_label_matching():
    """WR-02 — direct classifier unit cases: exact label/suffix, no substring trust."""
    from oswald.preflight.model_probe import _is_self_hosted_host as f

    # On-boundary
    assert f("localhost")
    assert f("127.0.0.1")
    assert f("10.0.0.5")  # RFC1918
    assert f("192.168.1.10")
    assert f("169.254.169.254")  # link-local (benign — no call made)
    assert f("ollama")  # single label
    assert f("vllm.internal")
    assert f("svc.svc.cluster.local")
    assert f("anthropic-mirror.internal")  # benign: not the public-domain label seq

    # Off-boundary
    assert not f("")  # fail closed
    assert not f("api.anthropic.com")  # public registrable
    assert not f("evil.example.com")
    assert not f("api.anthropic.com.evil.internal")  # WR-02 embedded public domain
    assert not f("api.openai.com.attacker.local")
    assert not f("8.8.8.8")  # public IP


def test_validate_surfaces_locked_down_public_endpoint(tmp_path):
    """oswald validate surfaces the locked-down residency FAIL — the probe is WIRED in.

    Writes a locked-down config pointing at a public model endpoint, invokes
    ``oswald validate`` via Typer's ``CliRunner`` (mirroring the M1
    ``tests/test_validate_errors.py`` invocation style), and asserts the command
    surfaces a FAIL naming the model endpoint host and exits non-zero — proving
    ``probe_model_residency`` is aggregated into ``validate()`` (not just callable
    directly). The ``--disable-socket`` default blocks the live capability probe's
    model call, so this never makes a real request; the residency FAIL is what the
    test asserts on.
    """
    import yaml
    from typer.testing import CliRunner

    from oswald.cli import app
    from oswald.config.schema import DEFAULT_CONFIG_PATH

    # Build a locked-down + public-endpoint config file from the shipped example.
    raw = yaml.safe_load(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["posture"] = "locked-down"
    raw["model"]["endpoint"] = _PUBLIC_MODEL_ENDPOINT
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(yaml.safe_dump(raw), encoding="utf-8")

    result = CliRunner().invoke(app, ["validate", "--config", str(cfg_path)])

    assert result.exit_code != 0  # a residency FAIL drives a non-zero exit
    out = result.output
    assert "model:residency" in out  # the residency check is in the report
    assert "FAIL" in out
    assert "api.anthropic.com" in out  # the FAIL NAMES the endpoint host (CLI-02)
    # No secret leaks into the validate output (T-05-01).
    assert "BEGIN PRIVATE KEY" not in out
    assert "password=" not in out.lower()
