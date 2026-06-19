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
