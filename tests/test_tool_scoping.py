"""MCP-03 — per-role tool scoping (EDA read-only vs build sandbox).

The EDA env exposes only show/compile/list/parse/docs; the build env exposes
build/run/test (and never ``clone``). The threat is privilege elevation
(T-ELEVATION): a write tool on the EDA role breaks the Rule of Two. This module
asserts the canned tool surfaces from the conftest mock MCP servers (green from
plan 01-02, since the canned split IS the contract the real wiring must honour),
plus an xfail check against the real ``.mcp.json`` tool config once it ships.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

WRITE_VERBS = {"build", "run", "test", "clone", "seed", "snapshot"}
# Borrowed destructive tool names (BIND-02) a resolved EDA grant must never contain,
# whatever connector backs the role under the convenience posture (D-06/D-10).
BORROWED_WRITE_TOOLS = {
    "merge_pull_request",
    "editJiraIssue",
    "addCommentToJiraIssue",
    "createJiraIssue",
    "transitionJiraIssue",
}
MCP_JSON = Path(__file__).resolve().parents[1] / ".mcp.json"


@pytest.mark.asyncio
async def test_eda_env_exposes_only_read_only_tools(mock_mcp_servers):
    """The EDA role's tool surface contains no write verbs (MCP-03 / SEC-01)."""
    eda = mock_mcp_servers["dbt-eda"]
    tools = set(await eda.list_tools())
    assert tools == {"show", "compile", "list", "parse", "docs"}
    assert not (tools & WRITE_VERBS), f"EDA role must not expose write verbs: {tools & WRITE_VERBS}"


@pytest.mark.asyncio
async def test_build_env_exposes_build_run_test_not_clone(mock_mcp_servers):
    """The build role exposes build/run/test against sandbox; never ``clone``."""
    build = mock_mcp_servers["dbt-build"]
    tools = set(await build.list_tools())
    assert {"build", "run", "test"}.issubset(tools)
    assert "clone" not in tools, "clone has the highest blast radius — omit it in M1"


def test_resolved_eda_grant_honors_logical_actual_no_borrowed_write():
    """A resolved EDA grant (logical→actual rename + prefix) holds no borrowed write tool.

    The binding resolver renames a logical tool to its vendor name then prefixes the
    install mode. Even when the EDA context's ticketing read tools are mapped onto a
    borrowed Atlassian connector, the resolved grant set must contain ONLY read tools
    — never a borrowed write/merge verb (MCP-03 / SEC-01 / D-10).
    """
    from oswald.binding.resolve import resolve_logical_tool

    # The atlassian profile maps the EDA ticketing reads logical→actual.
    eda_ticketing_tool_map = {"get_issue": "getJiraIssue", "search_issues": "searchJiraIssues"}
    resolved = {
        resolve_logical_tool(
            "atlassian", logical, tool_map=eda_ticketing_tool_map, install_mode=mode
        )
        for logical in eda_ticketing_tool_map
        for mode in ("pack", "bundled", "borrowed")
    } | {
        resolve_logical_tool("dbt-eda", verb, install_mode=mode)
        for verb in ("show", "compile", "list", "parse", "docs")
        for mode in ("pack", "bundled", "borrowed")
    }

    for tool in resolved:
        leaked = {frag for frag in BORROWED_WRITE_TOOLS if frag in tool}
        assert not leaked, f"resolved EDA grant {tool!r} must not contain a borrowed write tool: {leaked}"
        assert not (set(WRITE_VERBS) & {tool}), f"resolved EDA grant leaked a write verb: {tool}"


# Every read tool the project uses — the import-time toolsets/profiles asserts and
# the EDA allowlist depend on NONE of these tripping the broadened write detector.
READ_ONLY_TOOL_NAMES = [
    "show", "compile", "list", "parse", "docs", "query", "describe",
    "get_issue", "search_issues", "getJiraIssue", "searchJiraIssues",
    "get_pull_request", "list_pull_requests",
    "mcp__dbt-eda__show", "mcp__warehouse-ro__query",
    "mcp__warehouse-ro__describe", "mcp__ticketing__get_issue",
    "mcp__ticketing__search_issues", "mcp__atlassian__getJiraIssue",
]

# The full borrowed destructive surface the verb-stem detector must catch
# (CR-01/WR-03) — including the names the original enumeration missed and
# camelCase/case variants.
WRITE_TOOL_NAMES = [
    "build", "run", "test", "clone", "seed", "snapshot", "merge",
    "create_pull_request", "merge_pull_request", "create_branch", "push",
    "push_files", "create_or_update_file", "delete_file", "fork_repository",
    "deleteJiraIssue", "updateJiraIssue", "editJiraIssue", "createJiraIssue",
    "transitionJiraIssue", "addCommentToJiraIssue", "addAttachmentToJiraIssue",
    "mergePullRequest", "EditJiraIssue", "editjiraissue",
    "mcp__github__create_pull_request", "mcp__atlassian__deleteJiraIssue",
]


def test_is_write_tool_detector_is_sound():
    """CR-01/WR-03 — the single classifier flags every write tool and no read tool.

    This is the load-bearing detector both the binding probe (EDA-context FAIL +
    destructive WARN) and the import-time asserts rely on. It must (a) classify
    every real destructive borrowed tool — including the names the old 5-name/
    7-fragment enumeration missed and camelCase/case variants — as write, and
    (b) classify every read verb the project uses as read-only, or the EDA
    allowlist and the toolsets/profiles import asserts would break.
    """
    from oswald.mcp.toolsets import is_read_only_tool, is_write_tool

    for tool in WRITE_TOOL_NAMES:
        assert is_write_tool(tool), f"{tool!r} must classify as a WRITE tool (CR-01/WR-03)"
        assert not is_read_only_tool(tool), f"{tool!r} must NOT classify as read-only"

    for tool in READ_ONLY_TOOL_NAMES:
        assert not is_write_tool(tool), (
            f"read tool {tool!r} wrongly classified as write — the verb stems are "
            "too broad and would break the EDA allowlist / import asserts"
        )


@pytest.mark.xfail(reason="awaiting .mcp.json tool config (MCP-03)", strict=False)
def test_real_mcp_json_scopes_tools_per_role():
    """The shipped .mcp.json registers two dbt-mcp roles with the scoped tool lists."""
    if not MCP_JSON.exists():
        pytest.fail(".mcp.json not shipped yet (MCP-03)")
    import json

    data = json.loads(MCP_JSON.read_text(encoding="utf-8"))
    servers = data.get("mcpServers", {})
    eda_env = servers.get("dbt-eda", {}).get("env", {})
    build_env = servers.get("dbt-build", {}).get("env", {})
    assert "build" not in eda_env.get("DBT_MCP_ENABLE_TOOLS", "")
    assert "build" in build_env.get("DBT_MCP_ENABLE_TOOLS", "")
    # keep importlib referenced for later real-wiring resolution
    _ = importlib
