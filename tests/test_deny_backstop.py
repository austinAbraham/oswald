"""CR-02 — the deny-list / EDA disallowed-tools backstop covers borrowed destructive tools.

The convenience posture rides whatever GitHub/Atlassian connectors the host Claude
Code already holds, so those connectors' un-scopable destructive tools ARE present
in the session. The project's stated model is that ``.claude/settings.json`` deny
(project-wide) and the ``oswald-eda`` SKILL.md ``disallowed-tools`` are the
defense-in-depth backstop under the per-fork ``allowed-tools`` allowlist.

The review (CR-02) found the backstop enumerated only ``merge_pull_request`` +
four Atlassian write tools — leaving ``create_pull_request``, ``create_branch``,
``push``, ``create_or_update_file``, ``delete_file``, ``fork_repository``,
``deleteJiraIssue``, ``updateJiraIssue``, ``addAttachmentToJiraIssue`` undenied.
These tests PROVE the broadened coverage: each borrowed destructive tool must be
denied by an explicit literal entry OR a wildcard prefix pattern (non-vacuous —
they fail against the pre-fix 9-entry deny list).
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

import pytest

import yaml

from tests.conftest import GITHUB_BORROWED_TOOLS, PREVIOUSLY_MISSED_DESTRUCTIVE

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_JSON = ROOT / ".claude" / "settings.json"
EDA_SKILL_MD = ROOT / ".claude" / "skills" / "oswald-eda" / "SKILL.md"

# The borrowed destructive tools the backstop MUST cover, as fully-qualified
# ``mcp__<server>__<tool>`` names (the namespace the deny patterns are written in).
GITHUB_DESTRUCTIVE_QUALIFIED = [
    "mcp__github__create_pull_request",
    "mcp__github__merge_pull_request",
    "mcp__github__create_branch",
    "mcp__github__push",
    "mcp__github__push_files",
    "mcp__github__create_or_update_file",
    "mcp__github__delete_file",
    "mcp__github__fork_repository",
]
ATLASSIAN_DESTRUCTIVE_QUALIFIED = [
    "mcp__atlassian__editJiraIssue",
    "mcp__atlassian__updateJiraIssue",
    "mcp__atlassian__deleteJiraIssue",
    "mcp__atlassian__createJiraIssue",
    "mcp__atlassian__transitionJiraIssue",
    "mcp__atlassian__addCommentToJiraIssue",
    "mcp__atlassian__addAttachmentToJiraIssue",
]
ALL_BORROWED_DESTRUCTIVE_QUALIFIED = (
    GITHUB_DESTRUCTIVE_QUALIFIED + ATLASSIAN_DESTRUCTIVE_QUALIFIED
)


def _deny_list() -> list[str]:
    if not SETTINGS_JSON.exists():
        pytest.skip(f".claude/settings.json not present: {SETTINGS_JSON}")
    data = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    return data.get("permissions", {}).get("deny", [])


def _is_denied(tool: str, deny: list[str]) -> bool:
    """A tool is denied if a deny entry equals it OR matches it as a glob pattern."""
    return any(fnmatch.fnmatchcase(tool, pattern) for pattern in deny)


@pytest.mark.parametrize("tool", ALL_BORROWED_DESTRUCTIVE_QUALIFIED)
def test_settings_deny_covers_borrowed_destructive(tool):
    """CR-02 — every borrowed destructive tool is denied (literal or wildcard)."""
    deny = _deny_list()
    assert _is_denied(tool, deny), (
        f"borrowed destructive tool {tool!r} is NOT covered by the settings.json "
        "deny list (CR-02: the always-on backstop has a hole)"
    )


@pytest.mark.parametrize("name", PREVIOUSLY_MISSED_DESTRUCTIVE)
def test_settings_deny_covers_previously_missed(name):
    """CR-02 — the specific names the original deny list missed are now covered."""
    deny = _deny_list()
    # Try both connector namespaces — the name belongs to github or atlassian.
    candidates = [f"mcp__github__{name}", f"mcp__atlassian__{name}"]
    assert any(_is_denied(c, deny) for c in candidates), (
        f"previously-missed destructive tool {name!r} is still undenied (CR-02)"
    )


def test_eda_disallowed_tools_covers_borrowed_destructive():
    """CR-02 — the EDA SKILL.md disallowed-tools backstop names the borrowed families."""
    if not EDA_SKILL_MD.exists():
        pytest.skip(f"oswald-eda SKILL.md not present: {EDA_SKILL_MD}")
    text = EDA_SKILL_MD.read_text(encoding="utf-8")
    frontmatter = text.split("---")[1]
    data = yaml.safe_load(frontmatter)
    disallowed = set(data.get("disallowed-tools", []))

    # A representative slice of the borrowed destructive surface the EDA fork must
    # explicitly deny (beyond the authoritative allowlist) — the names CR-02 added.
    required = {
        "mcp__github__create_pull_request",
        "mcp__github__create_branch",
        "mcp__github__push",
        "mcp__github__create_or_update_file",
        "mcp__github__delete_file",
        "mcp__github__fork_repository",
        "mcp__atlassian__updateJiraIssue",
        "mcp__atlassian__deleteJiraIssue",
        "mcp__atlassian__addAttachmentToJiraIssue",
    }
    missing = required - disallowed
    assert not missing, (
        f"EDA disallowed-tools backstop is missing borrowed destructive tools: {sorted(missing)} (CR-02)"
    )


def test_eda_allowlist_is_authoritative_and_read_only():
    """CR-02 — the EDA allowlist (the PRIMARY scope) grants only read-only tools.

    The deny list is a backstop; the allowlist is what actually scopes the fork.
    It must hold exactly the nine read tools and NO write/destructive verb, so a
    borrowed write tool not enumerated in the denylist is still unreachable.
    """
    if not EDA_SKILL_MD.exists():
        pytest.skip(f"oswald-eda SKILL.md not present: {EDA_SKILL_MD}")
    text = EDA_SKILL_MD.read_text(encoding="utf-8")
    frontmatter = text.split("---")[1]
    data = yaml.safe_load(frontmatter)
    allowed = data.get("allowed-tools", [])

    from oswald.mcp.toolsets import is_write_tool

    write_in_allowlist = [t for t in allowed if is_write_tool(t)]
    assert not write_in_allowlist, (
        f"the EDA allowlist (authoritative scope) leaked a write tool: {write_in_allowlist}"
    )
    # The allowlist is genuinely the read-only nine (not silently widened).
    assert len(allowed) == 9, f"EDA allowlist must be the nine read tools, got {len(allowed)}"


def test_github_destructive_surface_fully_denied():
    """CR-02 — the github connector's destructive surface (conftest) is fully denied."""
    deny = _deny_list()
    write_tools = [t for t in GITHUB_BORROWED_TOOLS if not _looks_read_only(t)]
    undenied = [
        t for t in write_tools if not _is_denied(f"mcp__github__{t}", deny)
    ]
    assert not undenied, (
        f"github destructive tools not covered by the deny backstop: {undenied} (CR-02)"
    )


def _looks_read_only(tool: str) -> bool:
    """A conservative read-only check mirroring the EDA-safe github read tools."""
    return bool(re.match(r"^(get|list|search)_", tool))
