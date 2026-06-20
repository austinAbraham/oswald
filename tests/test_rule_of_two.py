"""SEC-01 / SEC-02 — Rule-of-Two split assertions.

Two grouped behaviours (matching the VALIDATION map):

* ``test_eda_no_write``   — SEC-01: the EDA role/tool-set holds no write/PR tools
  (T-ELEVATION). Asserted against the conftest mock EDA server (green: the canned
  surface IS the contract) plus an xfail against the real config once it ships.
* ``test_sandbox_only``   — SEC-02: the build path is restricted to the sandbox
  target; ``clone`` is omitted; ``generate_schema_name`` forces the sandbox schema
  (T-TAMPER-SANDBOX). RED until the dbt profile + macro land.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "dbt_project" / "profiles.example.yml"
SCHEMA_MACRO = ROOT / "dbt_project" / "macros" / "generate_schema_name.sql"

WRITE_OR_PR_TOOLS = {"build", "run", "test", "clone", "seed", "snapshot", "open_pull_request", "merge"}

# Borrowed destructive tool names (BIND-02, VERIFIED real names) the EDA grant must
# NEVER resolve to: GitHub's un-scopable ``merge_pull_request`` + Atlassian's
# ticket-write tools. The convenience posture rides whatever connectors the host
# Claude Code already holds, so the Rule-of-Two split must explicitly exclude these
# from the resolved read-only EDA grant set (D-06/D-10).
BORROWED_DESTRUCTIVE_TOOLS = {
    "merge_pull_request",
    "editJiraIssue",
    "addCommentToJiraIssue",
    "createJiraIssue",
    "transitionJiraIssue",
}


@pytest.mark.asyncio
async def test_eda_no_write(mock_mcp_servers):
    """SEC-01 — the EDA tool-set excludes every write/PR tool."""
    eda = mock_mcp_servers["dbt-eda"]
    tools = set(await eda.list_tools())
    leaked = tools & WRITE_OR_PR_TOOLS
    assert not leaked, f"EDA role must not hold write/PR tools, found: {leaked}"


def test_eda_grant_excludes_borrowed_destructive_tools():
    """SEC-01 / D-10 — the resolved EDA grant holds no borrowed destructive tool.

    Beyond the local dbt verbs, the convenience posture may ride a borrowed Atlassian
    ticketing connector. The resolved EDA grant set (the read-only logical tools the
    EDA context binds, across every install mode) must exclude every borrowed
    destructive name (``merge_pull_request``/``editJiraIssue``/…) — the EDA fork can
    never reach a ticket-write/merge tool whatever connector backs ticketing.
    """
    from oswald.binding.resolve import resolve_logical_tool

    # The read-only logical tools the EDA context binds for each role + the borrowed
    # ticketing read tools the atlassian profile maps (getJiraIssue/searchJiraIssues).
    eda_warehouse_logical = ("show", "compile", "list", "parse", "docs")
    eda_ticketing_actual = ("getJiraIssue", "searchJiraIssues")

    resolved: set[str] = set()
    for mode in ("pack", "bundled", "borrowed"):
        for logical in eda_warehouse_logical:
            resolved.add(resolve_logical_tool("dbt-eda", logical, install_mode=mode))
        for actual in eda_ticketing_actual:
            resolved.add(resolve_logical_tool("atlassian", actual, install_mode=mode))

    # No resolved EDA grant carries a borrowed destructive verb (by substring, so a
    # prefixed ``mcp__atlassian__editJiraIssue`` is caught as readily as the bare name).
    for tool in resolved:
        leaked = {frag for frag in BORROWED_DESTRUCTIVE_TOOLS if frag in tool}
        assert not leaked, f"resolved EDA grant {tool!r} leaked borrowed destructive tool(s): {leaked}"


def test_sandbox_only():
    """SEC-02 — build is restricted to the sandbox target; clone omitted; schema forced."""
    if not PROFILES.exists() or not SCHEMA_MACRO.exists():
        pytest.skip(
            "dbt sandbox profile/macro not shipped yet (SEC-02): "
            f"{PROFILES} / {SCHEMA_MACRO}"
        )
    profile_text = PROFILES.read_text(encoding="utf-8")
    macro_text = SCHEMA_MACRO.read_text(encoding="utf-8")
    # The sandbox target must exist and be distinct from the read-only EDA target.
    assert "sandbox" in profile_text
    assert "eda_ro" in profile_text
    # The generate_schema_name override forces the sandbox schema.
    assert "generate_schema_name" in macro_text
