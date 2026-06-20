"""PIPE-01 / PIPE-04 / PIPE-05 / PIPE-06 — end-to-end stage progression.

Grouped per the VALIDATION map (these four requirements share one module): a
scripted run on the DEMO-1 fixture ticket progresses through the orchestrator
stages — intake+EDA (PIPE-01), model-on-branch (PIPE-04), sandbox build + tests
(PIPE-05), PR open (PIPE-06). RED until the scripted harness lands under
``tests.harness`` (D-10); the harness fixture skips until then so the module
collects and runs.
"""

from __future__ import annotations

import importlib

import pytest

# The ordered stage boundaries the orchestrator must expose (D-12). M3 converts
# each into a formal blocking gate.
EXPECTED_STAGES = ["intake_eda", "plan", "model", "build", "pr"]


def _load_harness():
    """Lazily import the headless harness module if it exists yet."""
    try:
        return importlib.import_module("tests.harness.harness")
    except ModuleNotFoundError:
        return None


def test_scripted_run_progresses_through_stages(scripted_harness, demo_ticket):
    """A scripted run on DEMO-1 walks intake→EDA→plan→model→build→PR (PIPE-01/04/05/06).

    Rides the conftest ``scripted_harness`` stub, which skips until the
    Walking-Skeleton plan wires ``run_one_ticket``. ``demo_ticket`` asserts the
    fixture ticket text is available to the run.
    """
    assert "Acceptance" in demo_ticket  # fixture ticket present
    result = scripted_harness.run_one_ticket(ticket_id="DEMO-1")
    # Once the harness lands it returns the ordered stages it executed.
    stages = getattr(result, "stages", None) or result
    assert list(stages) == EXPECTED_STAGES


@pytest.mark.xfail(reason="awaiting orchestrator stage definitions (PIPE-01/04/05/06)", strict=False)
def test_orchestrator_exposes_stage_boundaries():
    """The orchestrator exposes named stage boundaries (D-12, M3 gate seams)."""
    harness = _load_harness()
    if harness is None:
        pytest.fail("tests.harness.harness not implemented yet (PIPE-01/04/05/06)")
    assert getattr(harness, "STAGES", None) == EXPECTED_STAGES


# --------------------------------------------------------------------------- #
# GATE-01 — three explicit human gates on the existing stage seams (D-09)
# --------------------------------------------------------------------------- #

# The three Phase-1.1 gates, seated on the seams after intake_eda / plan / build.
EXPECTED_GATES = ["refine", "plan", "build"]


def test_three_gates_sequence():
    """The three gates fire in order on the named seams; an unapproved gate blocks (D-09).

    Gate 1 (refine→approve, after ``intake_eda``) → Gate 2 (plan→approve, after
    ``plan``) → Gate 3 (build→approve-before-PR, after ``build``). An ``approved=False``
    gate raises ``GateError`` and blocks progression — the pipeline is fail-closed
    at every gate. ``STAGES``/``EXPECTED_STAGES`` are unchanged (gates add no stage).
    """
    from tests.harness import stages

    assert stages.GATES == EXPECTED_GATES, "the three gates seat on the named seams"
    # STAGES stays in lock-step (gates are between-stage markers, not a 6th stage).
    assert stages.STAGES == EXPECTED_STAGES

    fired: list[str] = []
    for name in stages.GATES:
        stages.gate(name, approved=True)  # a human approval lets the gate pass
        fired.append(name)
    assert fired == EXPECTED_GATES, "the three gates fire in refine→plan→build order"

    # An unapproved gate blocks progression (fail-closed, naming the gate).
    with pytest.raises(stages.GateError) as exc:
        stages.gate("build", approved=False)
    assert "build" in str(exc.value), "the GateError must name the blocked gate"

    # A truthy-but-not-True value (e.g. a string) does not pass the gate.
    with pytest.raises(stages.GateError):
        stages.gate("refine", approved="yes")  # type: ignore[arg-type]


def test_gate1_writeback_is_deterministic_glue(mock_ticketing_write):
    """Gate-1 approval invokes the deterministic spec-level write-back glue (D-10/D-11).

    The write-back consumes only the EDA-PROPOSED spec (intent/grain/sources/AC),
    never ``ctx.ticket_text``, and posts a spec-only body — no warehouse-derived key.
    It is orchestrator glue (``write_spec_back``), not an EDA tool-call.
    """
    from tests.harness import stages

    ctx = stages.StageContext(
        ticket_id="DEMO-1",
        ticket_text="raw untrusted ticket body — MUST NOT be written back",
        inferred_grain=["customer_id", "date_day"],
        proposed_intent="daily customer revenue mart",
        proposed_sources=["raw.orders", "raw.customers"],
        proposed_acceptance_criteria=["one row per customer per day"],
    )

    # Fails closed before approval — nothing is posted (defense-in-depth backstop).
    with pytest.raises(stages.GateError):
        stages.refine_gate_writeback(ctx, approved=False, ticketing=mock_ticketing_write)
    assert mock_ticketing_write.calls == [], "no write-back may occur before approval (D-10)"

    result = stages.refine_gate_writeback(ctx, approved=True, ticketing=mock_ticketing_write)
    assert result["ticket_id"] == "DEMO-1"
    assert len(mock_ticketing_write.calls) == 1
    body = mock_ticketing_write.calls[0]["body"]
    assert set(body) == {"intent", "grain", "sources", "acceptance_criteria"}
    # Raw ticket text never crosses into the write-back body (trusted-handoff rule).
    assert ctx.ticket_text not in str(body)


def test_pr_is_terminal(mock_github_api):
    """The PR stage opens a PR but the bot never merges — PR-terminal preserved (SEC-03).

    Drives the ``pr`` stage with the conftest ``mock_github_api`` (the injected fake
    raises on ``merge_pull_request``). There is no Gate 4 / merge step; the bot is
    PR-only. This guards the M1 no-merge guarantee against the gate additions.
    """
    from tests.harness import stages

    ctx = stages.StageContext(ticket_id="DEMO-1", build_succeeded=True)
    ctx = stages.pr(ctx, github=mock_github_api)
    assert ctx.pr["head"] == stages.branch_for_ticket("DEMO-1")
    assert mock_github_api.opened_prs, "the bot opens the PR (PR-only path works)"
    # The bot cannot merge — merge is a human-only step (no Gate 4 exists).
    with pytest.raises(PermissionError):
        mock_github_api.merge_pull_request(ctx.pr["number"])

    # Idempotent re-open: a second pr() for the same branch reuses the existing PR.
    ctx2 = stages.StageContext(ticket_id="DEMO-1", build_succeeded=True)
    ctx2 = stages.pr(ctx2, github=mock_github_api)
    assert len(mock_github_api.opened_prs) == 1, "re-open is a no-op (idempotent)"
