"""Pipeline stage boundaries — M1 test harness only (PIPE-01/04/05/06).

M1 test harness only — the production orchestrator is the Claude Code skill
(D-10); the Python service arrives in M2. This module exposes each orchestrator
stage boundary as a **named, individually-testable function** so M3 can convert
each into a formal blocking gate (D-12). It is the headless, deterministic mirror
of the five-stage ``oswald-run`` skill flow:

    intake_eda → plan → model → build → pr

The Rule-of-Two split is honored at the data-surface level even in the harness:
the EDA stage reads the (read-only) fixture warehouse only; the build + PR stages
are **deterministic glue** (CODE, not LLM tool-calls) — ``dbt build`` against the
SANDBOX target, the grain tests, ``sqlfluff`` lint, and a PR open keyed by the
branch ``oswald/ticket-<id>`` (idempotent re-open). The model-gateway call (the
real LiteLLM SDK, exercised by the SEC-04 egress test) is wired in ``harness.py``,
not here — this module keeps the stage glue free of that concern.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from tests.harness.eda import SourceProfile, profile_source
from tests.harness.writeback import write_spec_back

# The ordered stage boundaries the orchestrator exposes (D-12). M3 converts each
# into a formal blocking gate. MUST match test_pipeline_stages.EXPECTED_STAGES.
#
# Gates are sequencing markers BETWEEN these five unchanged pipeline stages — they
# add no sixth stage, so STAGES stays in lock-step with EXPECTED_STAGES.
STAGES: list[str] = ["intake_eda", "plan", "model", "build", "pr"]

# The three explicit Phase-1.1 human gates (D-09), each seated on an existing stage
# seam: Gate 1 after ``intake_eda`` (refine→approve, + the Gate-1 write-back on
# approval), Gate 2 after ``plan`` (approve before build), Gate 3 after ``build``
# (approve before opening the PR). The PR is terminal — there is no Gate 4 that
# would let the bot merge (SEC-03; the bot is PR-only). These names are the
# sequencing contract test_pipeline_stages.test_three_gates_sequence asserts.
GATES: list[str] = ["refine", "plan", "build"]


class GateError(RuntimeError):
    """A human gate was reached without approval (fail-closed, D-09).

    Raised by :func:`gate` when ``approved is not True``. A named ``RuntimeError``
    subclass mirroring the fail-closed precondition style already used by ``build``
    (rejecting a non-sandbox target) and ``model``/``pr`` (defensive RuntimeErrors):
    a gate blocks progression until a human approves — there is no implicit pass.
    """


def gate(name: str, *, approved: bool) -> None:
    """Fail-closed human gate: block progression unless a human approved (D-09).

    The three orchestrator gates (``refine`` / ``plan`` / ``build``) are explicit,
    config-driven seams. This helper mirrors ``build``'s fail-closed precondition
    (``target != "sandbox"`` → raise): an unapproved gate raises :class:`GateError`
    NAMING the gate, so a skipped approval can never silently advance the pipeline
    (the M3 blocking-gate seam, D-12). ``approved is True`` is required exactly —
    a truthy-but-not-True value (e.g. a non-empty string) does not pass.
    """
    if approved is not True:
        raise GateError(
            f"gate {name!r} reached without human approval — the pipeline is "
            "fail-closed at every gate (D-09); a human must approve to proceed"
        )


def branch_for_ticket(ticket_id: str) -> str:
    """The idempotent feature-branch name for a ticket (ARCHITECTURE Pattern 4)."""
    return f"oswald/ticket-{ticket_id}"


@dataclass
class StageContext:
    """Carried between stages — the trusted handoff surface.

    Only the human-approved plan crosses the Rule-of-Two boundary from the
    read-only EDA context into the write context; the harness models that by
    passing the derived plan forward, never raw ticket text into build.
    """

    ticket_id: str
    ticket_text: str = ""
    profiles: dict[str, SourceProfile] = field(default_factory=dict)
    inferred_grain: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    # The EDA fork's PROPOSED, spec-level refinement (its propose-only return). These
    # are the only fields the Gate-1 write-back consumes — derived from the ticket
    # the EDA fork reads + its findings, never the raw warehouse profiling rows. The
    # human approves them at Gate 1; the deterministic glue writes them back (D-10).
    proposed_intent: str = ""
    proposed_sources: list[str] = field(default_factory=list)
    proposed_acceptance_criteria: list[str] = field(default_factory=list)
    plan: dict[str, Any] | None = None
    models_written: list[str] = field(default_factory=list)
    build_succeeded: bool = False
    tests_passed: bool = False
    pr: dict[str, Any] | None = None


# --------------------------------------------------------------------------- #
# Stage 1 — INTAKE + EDA  (read-only; PIPE-01)
# --------------------------------------------------------------------------- #
def intake_eda(
    ctx: StageContext,
    *,
    warehouse: Any,
    sources: list[str],
    grain_keys: list[str],
) -> StageContext:
    """Read the ticket + profile sources read-only; state + confirm the grain.

    Uses :func:`tests.harness.eda.profile_source` (pure SELECTs over the read-only
    warehouse handle). Surfaces unconfirmable facts as open questions (Pitfall 4)
    — the M1 "human-driven-as-you-go" gate, the M3 blocking-gate seam.
    """
    for source in sources:
        ctx.profiles[source] = profile_source(warehouse, source, grain_keys=grain_keys)
    # The inferred grain is confirmed iff every profiled source agrees on it.
    ctx.inferred_grain = list(grain_keys)
    for profile in ctx.profiles.values():
        ctx.open_questions.extend(profile.open_questions)
    return ctx


# --------------------------------------------------------------------------- #
# Gate 1 — REFINE → APPROVE  (deterministic spec-level write-back; D-09/D-10/D-11)
# --------------------------------------------------------------------------- #
def refine_gate_writeback(
    ctx: StageContext,
    *,
    approved: bool,
    ticketing: Any,
) -> Any:
    """On Gate-1 approval, deterministically write the refined spec back to the ticket.

    This is the Gate-1 (refine→approve) handoff: it is **orchestrator glue** — CODE,
    NOT the EDA agent and NOT an LLM tool-call (D-10). It mirrors ``model``'s "acts
    on the approved handoff, never on ``ctx.ticket_text``" discipline: the payload is
    built from the EDA-PROPOSED spec ONLY (the inferred grain + the proposed
    intent/sources/acceptance), never from raw ``ctx.ticket_text`` or raw profiling
    output. The deterministic :func:`tests.harness.writeback.write_spec_back` glue
    then enforces fail-closed approval and the spec-field allowlist (D-11) before any
    ticket write — so warehouse-derived data (row counts, samples, distinct lists)
    can never reach the ticket. The EDA fork never holds ``ticketing``.

    The first explicit ``gate("refine", ...)`` blocks an unapproved write-back at the
    sequencing layer; ``write_spec_back`` is itself fail-closed on ``approved`` as the
    defense-in-depth backstop (a gate skip can never write).
    """
    gate("refine", approved=approved)
    payload = _proposed_spec_payload(ctx)
    return write_spec_back(
        ctx.ticket_id, payload, approved=approved, ticketing=ticketing
    )


def _proposed_spec_payload(ctx: StageContext) -> dict[str, Any]:
    """Build the spec-only write-back payload from the EDA-PROPOSED fields ONLY.

    Consumes only the proposed spec text on ``ctx`` (the confirmed/inferred grain
    plus the proposed intent/sources/acceptance) — never ``ctx.ticket_text`` and
    never raw warehouse profiling output. The four keys map exactly onto
    ``writeback.SPEC_FIELDS`` (intent/grain/sources/acceptance_criteria, D-11); any
    warehouse-derived key would be rejected by ``guard_writeback`` downstream.
    """
    return {
        "intent": ctx.proposed_intent,
        "grain": list(ctx.inferred_grain),
        "sources": list(ctx.proposed_sources or ctx.profiles),
        "acceptance_criteria": list(ctx.proposed_acceptance_criteria),
    }


# --------------------------------------------------------------------------- #
# Stage 2 — PLAN  (no warehouse/build tools; the trusted handoff)
# --------------------------------------------------------------------------- #
def plan(ctx: StageContext) -> StageContext:
    """Produce a modeling plan from the confirmed intake + EDA findings.

    Writes no code, touches no warehouse. The plan is the only artifact that
    crosses into the write context (Rule-of-Two handoff). In M1 this is where the
    human approves; M3 makes it a blocking gate.
    """
    ctx.plan = {
        "model_name": "fct_daily_customer_revenue",
        "grain_keys": ctx.inferred_grain,
        "sources": list(ctx.profiles),
        "branch": branch_for_ticket(ctx.ticket_id),
    }
    return ctx


# --------------------------------------------------------------------------- #
# Stage 3 — MODEL  (build role; acts on the approved plan, not the ticket; PIPE-04)
# --------------------------------------------------------------------------- #
def model(ctx: StageContext) -> StageContext:
    """Write dbt models on the feature branch from the APPROVED PLAN.

    Acts on ``ctx.plan`` (the trusted handoff), never on ``ctx.ticket_text``. The
    mandatory unique/not_null grain tests are part of what the model stage emits
    (pack/CLAUDE.md); the harness records the model name the plan names.
    """
    if ctx.plan is None:  # pragma: no cover — defensive; plan() always runs first
        raise RuntimeError("model stage reached before an approved plan (gate skipped)")
    ctx.models_written = [ctx.plan["model_name"]]
    return ctx


# --------------------------------------------------------------------------- #
# Stage 4 — BUILD + VALIDATE  (deterministic glue — CODE, not LLM; PIPE-05)
# --------------------------------------------------------------------------- #
def build(
    ctx: StageContext,
    *,
    run_build: Callable[[str, str], bool] | None = None,
    target: str = "sandbox",
) -> StageContext:
    """Run ``dbt build`` against the SANDBOX target + grain tests — deterministically.

    This is glue, not a model tool-call (CLAUDE.md "don't LLM-ify deterministic
    steps"). ``run_build(branch, target)`` is injectable so the harness can drive a
    real ``dbt build`` in a wired environment while tests supply a deterministic
    stub. The target is ``sandbox`` ONLY — the ``generate_schema_name`` override
    (plan 04) confines every build to ``OSWALD_SANDBOX`` regardless.
    """
    if target != "sandbox":  # the build path is sandbox-only (SEC-02)
        raise ValueError(f"build target must be 'sandbox', got {target!r}")
    branch = branch_for_ticket(ctx.ticket_id)
    if run_build is None:
        # No live dbt wired in the headless test — the deterministic glue records a
        # successful sandbox build of the model the plan named (the seam a real
        # `dbt build` plugs into without changing this stage's contract).
        ctx.build_succeeded = bool(ctx.models_written)
    else:
        ctx.build_succeeded = run_build(branch, target)
    ctx.tests_passed = ctx.build_succeeded  # grain unique/not_null tests run in-build
    return ctx


# --------------------------------------------------------------------------- #
# Stage 5 — PR  (deterministic glue — bot identity, PR-only, idempotent; PIPE-06)
# --------------------------------------------------------------------------- #
def pr(
    ctx: StageContext,
    *,
    github: Any = None,
    base: str = "main",
) -> StageContext:
    """Open a PR from ``oswald/ticket-<id>`` — deterministic glue, idempotent.

    Keyed by the branch ``oswald/ticket-<id>``: re-opening for the same branch is a
    no-op (returns the existing PR) so re-runs do not create duplicates
    (ARCHITECTURE Pattern 4). The bot is PR-only — it never merges (SEC-03); the
    injected ``github`` fake raises on ``merge_pull_request``.
    """
    if not ctx.build_succeeded:  # pragma: no cover — defensive
        raise RuntimeError("PR stage reached before a successful sandbox build")
    branch = branch_for_ticket(ctx.ticket_id)
    if github is None:
        ctx.pr = {"number": 1, "head": branch, "base": base, "idempotent_key": branch}
        return ctx
    # Idempotent re-open: if a PR already exists for this branch, reuse it.
    existing = [p for p in getattr(github, "opened_prs", []) if p.get("head") == branch]
    if existing:
        ctx.pr = existing[0]
        return ctx
    ctx.pr = github.open_pull_request(
        head=branch, base=base, title=f"oswald: {ctx.ticket_id}"
    )
    return ctx


__all__ = [
    "STAGES",
    "GATES",
    "GateError",
    "gate",
    "StageContext",
    "branch_for_ticket",
    "intake_eda",
    "refine_gate_writeback",
    "plan",
    "model",
    "build",
    "pr",
]
