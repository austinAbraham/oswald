"""MCP-02 — dbt-mcp launches via uvx, LOCAL CLI flavor only.

The local CLI flavor runs against dbt-core with no paid plan; the remote /
Platform tool groups (Semantic Layer, Discovery, Admin API) must be DISABLED
(T-TAMPER-REMOTE). RED until ``.mcp.json`` ships the dbt-mcp registrations;
skip-keyed to the missing artifact so the module runs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

MCP_JSON = Path(__file__).resolve().parents[1] / ".mcp.json"

# Env flags that, if set, would enable a remote/Platform tool group.
REMOTE_GROUP_FLAGS = {
    "DBT_MCP_ENABLE_SEMANTIC_LAYER",
    "DBT_MCP_ENABLE_DISCOVERY",
    "DBT_MCP_ENABLE_ADMIN_API",
}


def _dbt_mcp_servers() -> dict:
    if not MCP_JSON.exists():
        pytest.skip(f".mcp.json not shipped yet (MCP-02): {MCP_JSON}")
    data = json.loads(MCP_JSON.read_text(encoding="utf-8"))
    servers = data.get("mcpServers", {})
    return {name: cfg for name, cfg in servers.items() if name.startswith("dbt-")}


def test_dbt_mcp_launches_via_uvx():
    """Each dbt-mcp registration launches the local server via uvx."""
    dbt_servers = _dbt_mcp_servers()
    assert dbt_servers, "no dbt-mcp servers registered"
    for name, cfg in dbt_servers.items():
        assert cfg.get("command") == "uvx", f"{name} must launch via uvx"
        assert "dbt-mcp" in cfg.get("args", []), f"{name} must run dbt-mcp"


def test_remote_tool_groups_disabled():
    """No dbt-mcp registration enables a remote / Platform tool group."""
    for name, cfg in _dbt_mcp_servers().items():
        env = cfg.get("env", {})
        enabled_remote = {flag for flag in REMOTE_GROUP_FLAGS if str(env.get(flag, "")).lower() == "true"}
        assert not enabled_remote, f"{name} enables remote groups: {enabled_remote}"
        # Telemetry must be off (data residency).
        assert str(env.get("DO_NOT_TRACK", "")) in {"1", "true", "True"}, f"{name} must set DO_NOT_TRACK"
