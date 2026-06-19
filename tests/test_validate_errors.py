"""CLI-02 — `oswald validate` fails with a SPECIFIC error per misconfiguration.

Each failure names the exact misconfiguration (T-ERROR-HANDLING) and leaks no
secret. RED until the ``validate`` CLI lands under ``src/oswald``; xfail-marked so
the module collects and runs.
"""

from __future__ import annotations

import importlib

import pytest


def _load_cli():
    """Lazily import the Typer CLI app if it exists yet."""
    try:
        module = importlib.import_module("oswald.cli")
    except ModuleNotFoundError:
        return None
    return getattr(module, "app", None)


@pytest.mark.xfail(reason="awaiting validate CLI plan (CLI-02)", strict=False)
def test_validate_names_missing_mcp_server():
    """An unreachable MCP server yields an error that names that specific server."""
    app = _load_cli()
    if app is None:
        pytest.fail("oswald.cli not implemented yet (CLI-02)")
    from typer.testing import CliRunner

    result = CliRunner().invoke(app, ["validate"])
    assert result.exit_code != 0
    # The error must name the exact misconfigured component, not a generic message.
    assert "mcp" in result.output.lower()


@pytest.mark.xfail(reason="awaiting validate CLI plan (CLI-02)", strict=False)
def test_validate_does_not_leak_secrets():
    """A validation failure must never echo a secret value (T-ERROR-HANDLING)."""
    app = _load_cli()
    if app is None:
        pytest.fail("oswald.cli not implemented yet (CLI-02)")
    from typer.testing import CliRunner

    result = CliRunner().invoke(app, ["validate"])
    # No obvious secret pattern surfaces in the error output.
    assert "BEGIN PRIVATE KEY" not in result.output
    assert "password=" not in result.output.lower()


# --------------------------------------------------------------------------- #
# D-08 — model-capability probe (representative of the modeling skill's hardest
# structured demand). The probe issues ONE structured-tool-call round-trip and is
# NON-LENIENT: a reachable-but-too-weak model FAILs with a specific "capability"
# error naming what was missing. ``completion`` is injectable so these run with no
# live model call (the --disable-socket default is the backstop).
# --------------------------------------------------------------------------- #
from types import SimpleNamespace  # noqa: E402


def _fake_tool_response(arguments):
    """Build a LiteLLM-shaped completion response carrying one plan tool call."""
    import json

    args = arguments if isinstance(arguments, str) else json.dumps(arguments)
    tool_call = SimpleNamespace(function=SimpleNamespace(name="submit_dbt_model_plan", arguments=args))
    message = SimpleNamespace(tool_calls=[tool_call], content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _fake_prose_response(text="here is some SQL..."):
    """A too-weak model: prose reply, no structured tool call."""
    message = SimpleNamespace(tool_calls=None, content=text)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _example_config():
    from oswald.config import load_config

    return load_config()


def test_model_capability_probe_passes_on_wellformed_plan():
    """A model that returns a well-formed structured plan tool call PASSES."""
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model

    def completion(**_kwargs):
        return _fake_tool_response(
            {
                "model_name": "fct_customer_orders",
                "grain_keys": ["customer_id"],
                "sources": ["raw.orders", "raw.customers"],
                "join_key": "customer_id",
            }
        )

    result = probe_model(_example_config(), completion=completion)
    assert result.status is CheckStatus.PASS


def test_model_capability_probe_fails_specifically_on_too_weak_model():
    """A reachable-but-too-weak model FAILS with a specific 'capability' error."""
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import probe_model

    def completion(**_kwargs):
        return _fake_prose_response()  # no tool call -> too weak

    result = probe_model(_example_config(), completion=completion)
    assert result.status is CheckStatus.FAIL
    assert "capability" in result.message.lower()
    # Names what was missing, not a generic "failed".
    assert "structured" in result.message.lower() or "plan" in result.message.lower()


def test_model_capability_probe_asserts_structured_shape_not_a_ping():
    """The probe demands the dbt-model plan shape (sources + grain + join key)."""
    from oswald.preflight import CheckStatus
    from oswald.preflight.model_probe import PLAN_TOOL_SCHEMA, probe_model

    # The tool schema itself encodes the structured demand (not a string ping).
    required = set(PLAN_TOOL_SCHEMA["function"]["parameters"]["required"])
    assert {"model_name", "grain_keys", "sources", "join_key"} <= required

    # A response missing a source is rejected with a specific reason.
    def completion(**_kwargs):
        return _fake_tool_response(
            {
                "model_name": "fct_x",
                "grain_keys": ["customer_id"],
                "sources": ["raw.orders"],  # only one of two declared sources
                "join_key": "customer_id",
            }
        )

    result = probe_model(_example_config(), completion=completion)
    assert result.status is CheckStatus.FAIL
    assert "capability" in result.message.lower()


def test_model_probe_sends_no_warehouse_data():
    """The probe payload uses a SYNTHETIC schema only — never warehouse data (T-05-02)."""
    from oswald.preflight.model_probe import SYNTHETIC_SOURCES, probe_model

    captured = {}

    def completion(**kwargs):
        captured.update(kwargs)
        return _fake_tool_response(
            {
                "model_name": "fct_customer_orders",
                "grain_keys": ["customer_id"],
                "sources": list(SYNTHETIC_SOURCES),
                "join_key": "customer_id",
            }
        )

    probe_model(_example_config(), completion=completion)
    prompt = captured["messages"][0]["content"]
    # Only the synthetic source names appear; telemetry/message-logging is off.
    assert all(src in prompt for src in SYNTHETIC_SOURCES)
    assert captured.get("turn_off_message_logging") is True
