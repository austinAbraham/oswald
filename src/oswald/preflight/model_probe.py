"""Model-capability probe (D-08) — a structured-tool-call round-trip via LiteLLM.

Reachability alone is not enough: a model can answer ``ping`` yet be too weak to
produce the structured output the modeling skill depends on. This probe catches
"reachable but too weak" BEFORE a wasted end-to-end run (D-08, threat T-05-04) by
issuing ONE structured-tool-call request representative of the modeling skill's
*hardest* structured demand (RESEARCH Open Q4): return a well-formed **dbt-model
plan object** (model name + grain key + the two source refs + the join key) for a
SYNTHETIC trivial 2-source join.

Non-lenient (RESEARCH Assumption A4): the probe PASSES only if the model returns a
tool call whose arguments parse into the expected schema with all required fields
present and the two declared sources referenced. Anything short of that FAILs with
a specific ``"model capability floor not met: <what was missing>"`` message — never
a generic "failed" (CLI-02).

Data residency: the probe sends only a synthetic schema (two tiny made-up source
tables) — never warehouse data — so it stays inside the egress allowlist (threat
T-05-02). LiteLLM is invoked with telemetry off
(``turn_off_message_logging=True``, ``callbacks=[]``) so no prompt leaves the
boundary (CLAUDE.md §(c)).

Reusable floor-study hook: :func:`run_capability_probe` returns a structured
:class:`CapabilityProbeResult` for any (model, endpoint, api_key) triple, so the
empirical BYO-LLM floor study (D-07) can drive the same probe across candidate
models and record pass/fail for the published capability matrix.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from oswald.preflight import CheckResult, CheckStatus

if TYPE_CHECKING:  # pragma: no cover
    from oswald.config import OswaldConfig

# --------------------------------------------------------------------------- #
# The synthetic trivial 2-source join the probe asks the model to plan.
# NO warehouse data — two made-up source tables only (threat T-05-02).
# --------------------------------------------------------------------------- #
SYNTHETIC_SOURCES: tuple[str, str] = ("raw.orders", "raw.customers")
SYNTHETIC_JOIN_KEY = "customer_id"

#: The tool the model MUST call — its parameter schema is the structured demand.
#: Mirrors the modeling skill's hardest structured output (a dbt-model plan).
PLAN_TOOL_NAME = "submit_dbt_model_plan"
PLAN_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": PLAN_TOOL_NAME,
        "description": (
            "Return a dbt model plan for a marts model joining two sources on a key."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "model_name": {
                    "type": "string",
                    "description": "snake_case dbt model name, e.g. fct_customer_orders",
                },
                "grain_keys": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Column(s) defining one row of the model's grain",
                },
                "sources": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The two source tables the model reads (schema.table)",
                },
                "join_key": {
                    "type": "string",
                    "description": "The column the two sources are joined on",
                },
            },
            "required": ["model_name", "grain_keys", "sources", "join_key"],
        },
    },
}

_REQUIRED_FIELDS = ("model_name", "grain_keys", "sources", "join_key")

_PROMPT = (
    "You are a dbt modeling assistant. Plan a single marts model that joins two "
    f"sources, {SYNTHETIC_SOURCES[0]} and {SYNTHETIC_SOURCES[1]}, on "
    f"'{SYNTHETIC_JOIN_KEY}'. Call {PLAN_TOOL_NAME} with the model name, grain "
    "key(s), the two source tables, and the join key. Do not write SQL; only "
    "return the plan via the tool call."
)


@dataclass(frozen=True)
class CapabilityProbeResult:
    """Structured outcome of one capability probe — the D-07 floor-study record.

    Attributes:
        passed: True iff the model returned a well-formed plan tool call.
        model: The model name probed (no secret).
        missing: What the structured output lacked (empty on pass) — drives the
            specific FAIL message.
        plan: The parsed plan arguments on success (synthetic; no warehouse data).
    """

    passed: bool
    model: str
    missing: str = ""
    plan: dict[str, Any] | None = None


def _extract_tool_call_args(response: Any) -> dict[str, Any] | None:
    """Pull the first tool-call arguments dict from a LiteLLM completion response.

    Returns ``None`` when the response carries no usable structured tool call —
    the signal of a too-weak model (it replied with prose, not a tool call).
    """
    try:
        message = response.choices[0].message
    except (AttributeError, IndexError, TypeError):
        return None
    tool_calls = getattr(message, "tool_calls", None)
    if not tool_calls:
        return None
    first = tool_calls[0]
    raw_args = getattr(getattr(first, "function", None), "arguments", None)
    if raw_args is None:
        return None
    if isinstance(raw_args, dict):
        return raw_args
    try:
        parsed = json.loads(raw_args)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _evaluate_plan(args: dict[str, Any]) -> str:
    """Return '' if the plan is well-formed, else a specific 'what was missing' string."""
    missing_fields = [f for f in _REQUIRED_FIELDS if not args.get(f)]
    if missing_fields:
        return "required plan fields missing: " + ", ".join(missing_fields)
    sources = args.get("sources")
    if not isinstance(sources, list) or len(sources) < 2:
        return "plan must reference both synthetic sources (got fewer than two)"
    referenced = {str(s).strip().lower() for s in sources}
    expected = {s.lower() for s in SYNTHETIC_SOURCES}
    if not expected.issubset(referenced):
        absent = sorted(expected - referenced)
        return "plan did not reference the declared source(s): " + ", ".join(absent)
    grain = args.get("grain_keys")
    if not isinstance(grain, list) or not grain:
        return "plan must declare at least one grain key"
    return ""


def run_capability_probe(
    *,
    model: str,
    endpoint: str | None = None,
    api_key: str | None = None,
    completion: Any = None,
) -> CapabilityProbeResult:
    """Drive ONE structured-tool-call probe against ``model``; return a floor-study record.

    This is the reusable hook the D-07 empirical-floor study calls per candidate
    model. ``completion`` is injectable so tests (and the floor study's recorded
    fixtures) supply a stubbed LiteLLM ``completion`` callable without a live call.
    """
    if completion is None:  # pragma: no cover — exercised live, mocked in tests
        import litellm

        completion = litellm.completion

    try:
        response = completion(
            model=model,
            api_base=endpoint,
            api_key=api_key,
            messages=[{"role": "user", "content": _PROMPT}],
            tools=[PLAN_TOOL_SCHEMA],
            tool_choice={"type": "function", "function": {"name": PLAN_TOOL_NAME}},
            temperature=0,
            # Data residency — keep telemetry off (CLAUDE.md §(c) / T-05-02).
            turn_off_message_logging=True,
        )
    except Exception as exc:  # noqa: BLE001 — categorise without leaking api_key
        return CapabilityProbeResult(
            passed=False,
            model=model,
            missing=f"model endpoint unreachable or rejected the request ({type(exc).__name__})",
        )

    args = _extract_tool_call_args(response)
    if args is None:
        return CapabilityProbeResult(
            passed=False,
            model=model,
            missing="model returned no structured tool call (prose only) — "
            "it cannot produce the structured dbt-model plan the modeling skill requires",
        )
    problem = _evaluate_plan(args)
    if problem:
        return CapabilityProbeResult(passed=False, model=model, missing=problem)
    return CapabilityProbeResult(passed=True, model=model, plan=args)


def probe_model(config: OswaldConfig, completion: Any = None) -> CheckResult:
    """Run the capability probe against the configured model; one named CheckResult.

    PASS iff the model returns a well-formed structured plan tool call. Otherwise
    FAIL with ``"model capability floor not met: <what was missing>"`` — specific,
    actionable, and secret-free (CLI-02). ``completion`` is injectable for tests.
    """
    result = run_capability_probe(
        model=config.model.name,
        endpoint=config.model.endpoint,
        api_key=config.model.api_key,
        completion=completion,
    )
    if result.passed:
        return CheckResult(
            name="model:capability",
            status=CheckStatus.PASS,
            message=(
                f"model '{config.model.name}' meets the capability floor "
                "(returned a well-formed dbt-model plan tool call)"
            ),
        )
    return CheckResult(
        name="model:capability",
        status=CheckStatus.FAIL,
        message=f"model capability floor not met: {result.missing}",
    )


__all__ = [
    "probe_model",
    "run_capability_probe",
    "CapabilityProbeResult",
    "PLAN_TOOL_SCHEMA",
    "PLAN_TOOL_NAME",
    "SYNTHETIC_SOURCES",
]
