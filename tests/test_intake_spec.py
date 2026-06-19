"""PACK-03 — intake_spec.md has exactly the 4 hard fields; testable-bullet AC.

The intake-spec ships as a markdown template (D-01) with EXACTLY the four hard
fields (Intent, Grain, Source(s), Acceptance criteria — D-03) and a
testable-bullet Acceptance Criteria section (D-02). RED until the pack ships
``pack/intake_spec.md``; skip-keyed to the missing artifact so the module runs.
"""

from __future__ import annotations

from pathlib import Path

import pytest

INTAKE_SPEC = Path(__file__).resolve().parents[1] / "pack" / "intake_spec.md"

# The four hard fields, in canonical order (D-03). "Source(s)" may render as
# "Source(s)" or "Sources" — match on the stem.
HARD_FIELD_STEMS = ["Intent", "Grain", "Source", "Acceptance"]


def _require_intake_spec() -> str:
    if not INTAKE_SPEC.exists():
        pytest.skip(f"pack/intake_spec.md not shipped yet (PACK-03): {INTAKE_SPEC}")
    return INTAKE_SPEC.read_text(encoding="utf-8")


def test_intake_spec_has_exactly_four_hard_fields():
    """The template has exactly the four hard fields and no second-tier sections."""
    text = _require_intake_spec()
    headers = [line for line in text.splitlines() if line.startswith("## ")]
    assert len(headers) == 4, f"expected exactly 4 hard fields, found {len(headers)}: {headers}"
    joined = "\n".join(headers)
    for stem in HARD_FIELD_STEMS:
        assert stem in joined, f"missing hard field: {stem}"


def test_intake_spec_has_testable_bullet_ac():
    """The Acceptance Criteria section uses the testable-bullet convention (D-02)."""
    text = _require_intake_spec()
    assert "Acceptance" in text
    # At least one bullet under the AC section (loose check; the template itself
    # carries example testable bullets).
    assert any(line.lstrip().startswith(("-", "*")) for line in text.splitlines())
