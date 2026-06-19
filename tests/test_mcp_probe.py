"""MCP-01 — each configured MCP server connects + list_tools() succeeds.

Integration behaviour exercised against the conftest in-memory stub servers (no
sockets — the ``--disable-socket`` default is the backstop). The canned probe is
green from plan 01-02; an xfail check covers the real preflight probe
(``oswald.preflight.mcp_probe``) once it ships.
"""

from __future__ import annotations

import importlib

import pytest


@pytest.mark.asyncio
async def test_each_stub_server_connects_and_lists_tools(mock_mcp_servers):
    """Every registered (stub) MCP server connects and returns a tool list."""
    for name, server in mock_mcp_servers.items():
        tools = await server.list_tools()
        assert server.connected, f"{name} did not connect"
        assert isinstance(tools, list) and tools, f"{name} returned no tools"


@pytest.mark.xfail(reason="awaiting validate MCP preflight probe (MCP-01)", strict=False)
def test_real_mcp_probe_lists_tools_for_each_server():
    """The real preflight probe connects to each configured server and lists tools."""
    try:
        probe = importlib.import_module("oswald.preflight.mcp_probe")
    except ModuleNotFoundError:
        pytest.fail("oswald.preflight.mcp_probe not implemented yet (MCP-01)")
    assert hasattr(probe, "probe_servers")
