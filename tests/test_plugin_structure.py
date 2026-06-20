"""PLUG-01 / PLUG-02 — Claude Code plugin packaging + pack-mode backward compat.

Mirrors ``tests/test_pack_artifacts.py``'s ``json.loads(...) → assert key present``
shape, skip-keyed to the not-yet-shipped manifests so the module collects RED and
runs without an ImportError. Each behaviour maps to a VALIDATION Per-Task row:

* ``test_plugin_manifest_schema``  — PLUG-01: ``.claude-plugin/plugin.json`` valid
  (name ``oswald``, license ``Apache-2.0``, skills/mcpServers path fields present).
* ``test_marketplace_schema``      — PLUG-02: ``.claude-plugin/marketplace.json``
  valid; single plugin ``source: "."``; marketplace name/owner present.
* ``test_skills_namespaced``       — PLUG-01: the three SKILL.md ``name:`` fields
  resolve to the ``oswald:run/eda/model`` namespacing (``run``/``eda``/``model``).
* ``test_pack_mode_preserved``     — PLUG-02 / D-02: pack discovery intact — the
  ``.claude/skills/oswald-run/SKILL.md`` + ``.mcp.json`` still exist.
* ``test_claude_plugin_validate``  — PLUG-01 smoke: ``claude plugin validate .``
  passes (skipped if the ``claude`` CLI is absent on PATH).

RED until the plugin manifests + skill ``name`` rename land (Plans 02/05).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_JSON = ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE_JSON = ROOT / ".claude-plugin" / "marketplace.json"
SKILLS_DIR = ROOT / ".claude" / "skills"
MCP_JSON = ROOT / ".mcp.json"

# The three M1 skill directories and the namespaced ``name:`` each must declare so
# Claude Code loads them as ``oswald:run`` / ``oswald:eda`` / ``oswald:model``
# (RESEARCH Pitfall 2: the frontmatter ``name`` is renamed for namespacing).
_SKILL_NAMESPACE = {
    "oswald-run": "run",
    "oswald-eda": "eda",
    "oswald-model": "model",
}


def _frontmatter_name(skill_md: Path) -> str | None:
    """Parse the ``name:`` field from a SKILL.md YAML frontmatter block."""
    text = skill_md.read_text(encoding="utf-8")
    match = re.search(r"^name:\s*(.+)$", text, flags=re.MULTILINE)
    return match.group(1).strip() if match else None


def test_plugin_manifest_schema():
    """PLUG-01 — plugin.json declares name=oswald, Apache-2.0, skills + mcpServers."""
    if not PLUGIN_JSON.exists():
        pytest.skip(f".claude-plugin/plugin.json not shipped yet (PLUG-01): {PLUGIN_JSON}")
    data = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
    assert data.get("name") == "oswald", "plugin manifest name must be 'oswald'"
    assert data.get("license") == "Apache-2.0", "license must match dbt-core (CLAUDE.md)"
    # The manifest bundles the existing skills + the templated .mcp.json (D-01).
    assert "skills" in data, "plugin.json must declare a 'skills' path field"
    assert "mcpServers" in data, "plugin.json must declare an 'mcpServers' path field"


def test_marketplace_schema():
    """PLUG-02 — marketplace.json: the repo is its own marketplace, single plugin."""
    if not MARKETPLACE_JSON.exists():
        pytest.skip(
            f".claude-plugin/marketplace.json not shipped yet (PLUG-02): {MARKETPLACE_JSON}"
        )
    data = json.loads(MARKETPLACE_JSON.read_text(encoding="utf-8"))
    assert data.get("name"), "marketplace.json must declare a 'name'"
    assert data.get("owner"), "marketplace.json must declare an 'owner'"
    plugins = data.get("plugins")
    assert plugins, "marketplace.json must list at least one plugin"
    assert plugins[0].get("source") == ".", "the single plugin's source must be '.' (D-01)"


def test_skills_namespaced():
    """PLUG-01 — the three skills declare names that namespace to oswald:run/eda/model."""
    for directory, expected in _SKILL_NAMESPACE.items():
        skill_md = SKILLS_DIR / directory / "SKILL.md"
        if not skill_md.exists():
            pytest.skip(f"{directory}/SKILL.md not present: {skill_md}")
        name = _frontmatter_name(skill_md)
        assert name == expected, (
            f"{directory}/SKILL.md name must be {expected!r} for oswald:{expected} "
            f"namespacing (RESEARCH Pitfall 2), got {name!r}"
        )


def test_pack_mode_preserved():
    """PLUG-02 / D-02 — pack discovery intact: the M1 skills + .mcp.json still exist."""
    run_skill = SKILLS_DIR / "oswald-run" / "SKILL.md"
    assert run_skill.exists(), (
        f"pack mode broken: {run_skill} missing — the plugin manifest must be "
        "ADDITIVE (D-02), never move/remove the M1 pack skills"
    )
    assert MCP_JSON.exists(), (
        f"pack mode broken: {MCP_JSON} missing — the bundled .mcp.json must stay "
        "discoverable as a plain project pack (D-02)"
    )


def test_claude_plugin_validate():
    """PLUG-01 smoke — the official validator accepts the plugin (skip if CLI absent)."""
    if not PLUGIN_JSON.exists():
        pytest.skip(f".claude-plugin/plugin.json not shipped yet (PLUG-01): {PLUGIN_JSON}")
    claude = shutil.which("claude")
    if claude is None:
        pytest.skip("`claude` CLI not on PATH — plugin-validate smoke is opt-in")
    result = subprocess.run(  # noqa: S603 — fixed argv, no shell
        [claude, "plugin", "validate", "."],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, (
        f"`claude plugin validate .` failed: {result.stdout}\n{result.stderr}"
    )
