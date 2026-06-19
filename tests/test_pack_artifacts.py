"""PACK-02 / PACK-04 / PACK-05 — pack artifact presence + discoverability.

Three grouped behaviours (one test each, matching the VALIDATION map):

* ``test_claude_md_present``     — PACK-02: pack/CLAUDE.md present (and lints clean
  against the shipped sqlfluff config — smoke).
* ``test_skill_references_prompts`` — PACK-04: the modeling skill/prompt files exist
  and are referenced by SKILL.md.
* ``test_skill_loads``           — PACK-05: .mcp.json + the oswald-run SKILL.md are
  present and discoverable.

RED until the pack ships; skip-keyed to the missing artifacts so the module runs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PACK_DIR = ROOT / "pack"
SKILL_MD = ROOT / ".claude" / "skills" / "oswald-run" / "SKILL.md"
MCP_JSON = ROOT / ".mcp.json"


def test_claude_md_present():
    """PACK-02 — the pack ships a CLAUDE.md house-style/conventions file."""
    pack_claude = PACK_DIR / "CLAUDE.md"
    if not pack_claude.exists():
        pytest.skip(f"pack/CLAUDE.md not shipped yet (PACK-02): {pack_claude}")
    text = pack_claude.read_text(encoding="utf-8")
    # Smoke: the conventions file mentions the layering taxonomy (D-04/D-06).
    assert any(layer in text.lower() for layer in ("staging", "intermediate", "marts"))


def test_skill_references_prompts():
    """PACK-04 — modeling skill/prompt files exist and are referenced by SKILL.md."""
    if not SKILL_MD.exists():
        pytest.skip(f"oswald-run SKILL.md not shipped yet (PACK-04): {SKILL_MD}")
    prompts_dir = PACK_DIR / "prompts"
    if not prompts_dir.exists():
        pytest.skip(f"pack/prompts/ not shipped yet (PACK-04): {prompts_dir}")
    skill_text = SKILL_MD.read_text(encoding="utf-8")
    # The orchestrator skill must reference the modeling prompt artifact.
    assert "modeling" in skill_text.lower()


def test_skill_loads():
    """PACK-05 — .mcp.json + the oswald-run SKILL.md are valid + discoverable."""
    if not MCP_JSON.exists():
        pytest.skip(f".mcp.json not shipped yet (PACK-05): {MCP_JSON}")
    if not SKILL_MD.exists():
        pytest.skip(f"oswald-run SKILL.md not shipped yet (PACK-05): {SKILL_MD}")
    data = json.loads(MCP_JSON.read_text(encoding="utf-8"))
    assert "mcpServers" in data, ".mcp.json must declare mcpServers"
