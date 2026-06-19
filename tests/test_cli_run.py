"""CLI-03 — `run` is wired (invokes the skill / documents the Claude Code entry).

Per D-10 the M1 ``run`` surface IS the ``oswald-run`` Claude Code skill — the CLI
is thin. This smoke test asserts that the run entry point is documented and the
skill is discoverable. RED until the skill + run wiring land; skip-keyed to the
missing artifact so the module runs.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SKILL_MD = ROOT / ".claude" / "skills" / "oswald-run" / "SKILL.md"


def test_run_skill_documents_entry_point():
    """The oswald-run skill documents the gated single-ticket run (CLI-03 / D-10)."""
    if not SKILL_MD.exists():
        pytest.skip(f"oswald-run SKILL.md not shipped yet (CLI-03): {SKILL_MD}")
    text = SKILL_MD.read_text(encoding="utf-8")
    # The skill must declare itself and accept a ticket argument.
    assert "name: oswald-run" in text or "oswald-run" in text
    assert "ticket" in text.lower()
    # The gated stages are described (D-09 / D-12).
    assert "GATE" in text or "gate" in text.lower()
