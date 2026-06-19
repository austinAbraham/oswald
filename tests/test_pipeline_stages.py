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
