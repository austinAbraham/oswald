"""Headless scripted harness — M1 test harness only (PIPE-01/04/05/06, D-11).

M1 test harness only — the production orchestrator is the Claude Code skill
(D-10); the Python service arrives in M2. ``run_one_ticket`` drives the
oswald-controlled data surfaces end-to-end for one fixture ticket through the five
exposed stage boundaries (intake+EDA → plan → model → build → PR), over the
read-only duckdb fixture warehouse and the mocked git surface — the **headless
scripted harness**, NOT the interactive Claude Code session (D-11).

This is the surface the SEC-04 egress-allowlist test rides: it exercises the
real model-gateway path (the LiteLLM SDK — wired in :func:`run_one_ticket` via the
``model_gateway`` seam, made non-vacuous by the egress test) plus the read-only
warehouse and git surfaces, asserting only configured endpoints are contacted.
The build + PR steps are deterministic glue (CODE, not LLM tool-calls).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from tests.harness import model_gateway, stages
from tests.harness.stages import STAGES, StageContext

# The DEMO-1 fixture ticket + the seeded read-only duckdb warehouse (plan 02).
_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"
_DEMO_TICKET = _FIXTURES_DIR / "DEMO-1.md"
_WAREHOUSE_DB = _FIXTURES_DIR / "warehouse.duckdb"

# DEMO-1's declared sources + grain (the harness drives these data surfaces).
_DEMO_SOURCES = ["orders", "customers"]
_DEMO_GRAIN = ["customer_id", "order_date"]


@dataclass
class RunResult:
    """The outcome of one scripted run — the ordered stages executed + artifacts.

    ``stages`` is the ordered list of stage boundaries the run walked
    (test_pipeline_stages asserts it equals ``STAGES``). The rest are the
    per-stage artifacts useful for assertions (the PR opened, the model built).
    """

    ticket_id: str
    stages: list[str] = field(default_factory=list)
    branch: str = ""
    profiles: dict[str, Any] = field(default_factory=dict)
    open_questions: list[str] = field(default_factory=list)
    models_written: list[str] = field(default_factory=list)
    build_succeeded: bool = False
    pr: dict[str, Any] | None = None
    model_gateway_response: Any = None

    def __iter__(self):  # allow `list(result)` to yield the stages (test convenience)
        return iter(self.stages)


def _open_readonly_warehouse() -> Any:
    """Open the read-only duckdb fixture warehouse (the read-only EDA role analogue)."""
    import duckdb  # local import: duckdb is a dev/test dependency

    return duckdb.connect(str(_WAREHOUSE_DB), read_only=True)


def run_one_ticket(
    ticket_id: str,
    config: Any = None,
    *,
    warehouse: Any = None,
    github: Any = None,
    model_gateway_call: Callable[[StageContext], Any] | None = None,
    model_endpoint: str | None = None,
    exporter: tuple[str, int] | None = None,
    run_build: Callable[[str, str], bool] | None = None,
) -> RunResult:
    """Drive one fixture ticket through all five stage boundaries, headless.

    Args:
        ticket_id: the fixture ticket to run (``"DEMO-1"`` in M1).
        config: the loaded OswaldConfig (optional in M1 — the harness drives the
            fixture surfaces directly; the seam exists for the M2 service).
        warehouse: an injected read-only warehouse handle; opened on the fixture
            duckdb warehouse when omitted.
        github: an injected git fake (the PR-only bot — never merges); the harness
            uses a deterministic in-memory PR when omitted.
        model_gateway_call: an injected callable that performs the model-gateway
            round trip; when omitted but ``model_endpoint`` is given, the harness
            uses the REAL LiteLLM SDK via :mod:`tests.harness.model_gateway` (the
            non-vacuous SEC-04 path). Invoked once during the PLAN stage — planning
            is the LLM-driven step, so that is where sensitive data would egress.
        model_endpoint: the model-gateway ``api_base`` (e.g.
            ``http://model.endpoint.internal:<port>/v1``) for the REAL LiteLLM call.
            Telemetry is enforced off + asserted before the call (Pitfall 1).
        exporter: an optional ``(host, port)`` for a telemetry exporter emission —
            modeled SYNCHRONOUSLY during the PLAN stage. The negative-control test
            passes a NON-allowlisted host here to prove the egress guard blocks it.
        run_build: an injected ``dbt build`` runner (deterministic stub in tests).

    Returns:
        A :class:`RunResult` whose ``stages`` is the ordered list of executed stage
        boundaries (equals :data:`STAGES`).
    """
    result = RunResult(ticket_id=ticket_id)
    ctx = StageContext(ticket_id=ticket_id)
    ctx.ticket_text = _DEMO_TICKET.read_text(encoding="utf-8") if _DEMO_TICKET.exists() else ""
    result.branch = stages.branch_for_ticket(ticket_id)

    owns_warehouse = warehouse is None
    warehouse = warehouse if warehouse is not None else _open_readonly_warehouse()
    try:
        # Stage 1 — INTAKE + EDA (read-only).
        ctx = stages.intake_eda(
            ctx, warehouse=warehouse, sources=_DEMO_SOURCES, grain_keys=_DEMO_GRAIN
        )
        result.stages.append("intake_eda")
        result.profiles = dict(ctx.profiles)
        result.open_questions = list(ctx.open_questions)

        # Stage 2 — PLAN. The model-gateway round trip (real LiteLLM SDK in the
        # egress test) happens here: planning is the LLM-driven step, so this is
        # where sensitive data would egress — exactly what SEC-04 polices. A
        # telemetry exporter (if configured) emits synchronously here too, so a
        # non-allowlisted exporter host is blocked by the egress guard.
        ctx = stages.plan(ctx)
        if model_gateway_call is not None:
            result.model_gateway_response = model_gateway_call(ctx)
        elif model_endpoint is not None:
            result.model_gateway_response = model_gateway.call_model_gateway(
                api_base=model_endpoint
            )
        if exporter is not None:
            model_gateway.emit_via_exporter(*exporter)
        result.stages.append("plan")

        # Stage 3 — MODEL (build role; acts on the approved plan).
        ctx = stages.model(ctx)
        result.stages.append("model")
        result.models_written = list(ctx.models_written)

        # Stage 4 — BUILD + VALIDATE (deterministic glue, sandbox only).
        ctx = stages.build(ctx, run_build=run_build, target="sandbox")
        result.stages.append("build")
        result.build_succeeded = ctx.build_succeeded

        # Stage 5 — PR (deterministic glue, idempotent, PR-only).
        ctx = stages.pr(ctx, github=github)
        result.stages.append("pr")
        result.pr = ctx.pr
    finally:
        if owns_warehouse:
            warehouse.close()

    return result


__all__ = ["run_one_ticket", "RunResult", "STAGES"]
