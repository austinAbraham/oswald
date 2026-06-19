"""Model-gateway path for the headless harness — M1 test harness only (SEC-04).

M1 test harness only — the production orchestrator is the Claude Code skill
(D-10); the Python service arrives in M2. This module is the load-bearing
data-residency surface (SEC-04 / D-11, Pitfall 1): it initializes the **REAL**
LiteLLM SDK (not a mock) with telemetry OFF and exercises a real model-gateway
round trip, so the egress-allowlist test catches an actual callback/exporter
leak rather than passing trivially.

What it guarantees, up front and at runtime:

* ``LITELLM_LOCAL_MODEL_COST_MAP=True`` is set BEFORE importing litellm so the SDK
  never fetches its remote model-cost map (a stray off-boundary GET).
* ``assert_telemetry_off()`` proves the misconfiguration is impossible, not merely
  unexercised: ``litellm.callbacks == []`` and ``success_callback`` /
  ``failure_callback`` are empty (no Langfuse/OTel exporter registered), and
  message-content logging is disabled (``turn_off_message_logging is True``).
* ``dbt_mcp_subprocess_env()`` carries ``DO_NOT_TRACK=1`` for the dbt-mcp launch
  env (the dbt-mcp telemetry vector).
* The real LiteLLM call targets ``model.endpoint.internal`` (resolved to
  ``127.0.0.1`` by the egress test's resolver shim, and on the pytest-socket
  ALLOWED list), so any socket to a NON-allowlisted host raises
  ``SocketBlockedError`` / ``SocketConnectBlockedError``.
* A telemetry exporter is modeled as a **synchronous** emission
  (:func:`emit_via_exporter`) on the calling thread, so the negative-control test
  can inject a non-allowlisted exporter host and assert the leak is blocked
  deterministically (LiteLLM runs its own success callbacks in a thread and
  swallows their exceptions, so a callback-based leak would not surface on the
  caller — the synchronous exporter models the exporter egress faithfully and with
  teeth).
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from typing import Any

# Disable LiteLLM's remote model-cost-map fetch BEFORE importing litellm. Without
# this, importing/using litellm performs a background GET to raw.githubusercontent
# — a stray off-boundary socket the data-residency invariant must not depend on.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

# The configured, allowlisted model-gateway host (on the egress ALLOWED list). The
# egress test installs a resolver shim mapping it to 127.0.0.1 + a local stub server.
ALLOWLISTED_MODEL_HOST = "model.endpoint.internal"


@dataclass(frozen=True)
class GatewayCallResult:
    """The outcome of a real model-gateway round trip (no warehouse data)."""

    content: str
    host: str


def assert_telemetry_off() -> None:
    """Prove the data-residency misconfiguration is impossible, not just unexercised.

    Asserts, against the REAL litellm module: no callbacks/exporters are registered
    and message-content logging is disabled. Raises ``AssertionError`` if any
    telemetry vector is live — this runs BEFORE any model-gateway call so a leak is
    caught up front (SEC-04 / Pitfall 1).
    """
    import litellm

    assert litellm.callbacks == [], (
        f"litellm.callbacks must be [] (no exporter registered); got {litellm.callbacks!r}"
    )
    assert litellm.success_callback == [], (
        f"litellm.success_callback must be empty; got {litellm.success_callback!r}"
    )
    assert litellm.failure_callback == [], (
        f"litellm.failure_callback must be empty; got {litellm.failure_callback!r}"
    )
    assert litellm.turn_off_message_logging is True, (
        "litellm.turn_off_message_logging must be True (message-content logging off)"
    )


def configure_telemetry_off() -> None:
    """Set the telemetry-off invariants on the real litellm module (callbacks-off)."""
    import litellm

    litellm.callbacks = []
    litellm.success_callback = []
    litellm.failure_callback = []
    litellm.turn_off_message_logging = True
    # Keep the SDK on its local cost map (no remote fetch) for the run.
    litellm.disable_aiohttp_transport = True


def dbt_mcp_subprocess_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """The env the dbt-mcp subprocess is launched with — DO_NOT_TRACK=1 (telemetry off).

    Mirrors the ``.mcp.json`` dbt-mcp env blocks (plan 04). The harness never
    actually spawns dbt-mcp in M1 tests, but the egress test asserts this env
    carries ``DO_NOT_TRACK=1`` so the dbt-mcp telemetry vector is provably off.
    """
    env = dict(base_env or os.environ)
    env["DO_NOT_TRACK"] = "1"
    env["DBT_SEND_ANONYMOUS_USAGE_STATS"] = "false"
    return env


def call_model_gateway(
    *,
    api_base: str,
    api_key: str = "sk-headless-test",
    model: str = "openai/gpt-headless-test",
    prompt: str = "Return the single word ok.",
) -> GatewayCallResult:
    """Perform a REAL LiteLLM model-gateway round trip (no mock client).

    Telemetry is enforced off first (``configure_telemetry_off`` +
    ``assert_telemetry_off``). The call targets ``api_base`` (the allowlisted host
    in the egress test). Any socket to a non-allowlisted host raised by the SDK or a
    registered callback surfaces as a pytest-socket error and fails the run.
    """
    configure_telemetry_off()
    assert_telemetry_off()
    import litellm

    response = litellm.completion(
        model=model,
        api_base=api_base,
        api_key=api_key,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        turn_off_message_logging=True,
    )
    content = response.choices[0].message.content
    host = api_base.split("://", 1)[-1].split(":", 1)[0].split("/", 1)[0]
    return GatewayCallResult(content=content, host=host)


def emit_via_exporter(host: str, port: int) -> None:
    """Model a telemetry exporter emitting to ``host:port`` — SYNCHRONOUS, on this thread.

    This is what a Langfuse/OTel exporter callback would do: open a socket to its
    configured host. Doing it synchronously (rather than via a LiteLLM success
    callback, which the SDK runs in a thread and whose exceptions it swallows) makes
    the negative-control deterministic: an allowlisted exporter host is permitted
    through the socket guard (it then fails only on connection-refused, which is
    not a block), while a NON-allowlisted host raises
    ``SocketConnectBlockedError`` — proving the egress guard has teeth.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(1.0)
        sock.connect((host, port))
    finally:
        sock.close()


__all__ = [
    "ALLOWLISTED_MODEL_HOST",
    "GatewayCallResult",
    "assert_telemetry_off",
    "configure_telemetry_off",
    "dbt_mcp_subprocess_env",
    "call_model_gateway",
    "emit_via_exporter",
]
