"""MCP reachability probe — connect each configured server + ``list_tools`` (MCP-01).

For every server registered in the config (mirrors ``.mcp.json``), open a real
``mcp`` SDK stdio session and call ``list_tools()``. A server that cannot be
launched, fails to initialise, or exposes no tools yields a :class:`CheckResult`
with ``status=FAIL`` whose message names **that specific server** and the cause
(CLI-02 — "fail with a specific, actionable error", never a generic "failed").

Security:
* No message echoes a secret. Server ``env`` may carry ``${ENV}`` references for
  credentials; we surface only the server *name* and a category of failure, never
  an env value (threat T-05-01).
* stdio transport launches a local subprocess and talks over pipes — no network
  socket is opened by the probe itself; the egress allowlist is respected (the
  server subprocess is responsible for its own configured-host egress).

The probe is deterministic and fully mockable: ``_connect_and_list`` is the single
seam tests monkeypatch to simulate reachable / unreachable / empty-tool servers
without launching a real ``dbt-mcp``.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from oswald.preflight import CheckResult, CheckStatus

if TYPE_CHECKING:  # pragma: no cover
    from oswald.config import OswaldConfig
    from oswald.config.schema import McpServer


class McpProbeError(RuntimeError):
    """A configured MCP server could not be reached / listed (names the server)."""

    def __init__(self, server: str, cause: str) -> None:
        self.server = server
        self.cause = cause
        super().__init__(f"MCP server {server!r}: {cause}")


def _resolve_env(server: McpServer) -> dict[str, str]:
    """Resolve the server's env passthrough, expanding ``${VAR}`` from os.environ.

    Returns a plain ``dict[str, str]``; resolved secret values are passed to the
    subprocess but never returned to the report layer (see :func:`probe_servers`).
    """
    import os
    import re

    env_ref = re.compile(r"^\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)\}$")
    resolved: dict[str, str] = {}
    for key, value in server.env.items():
        match = env_ref.match(value.strip()) if isinstance(value, str) else None
        resolved[key] = os.environ.get(match.group("name"), "") if match else value
    return resolved


async def _connect_and_list(name: str, server: McpServer) -> list[str]:
    """Open an mcp stdio session to ``server`` and return its tool names.

    Raises :class:`McpProbeError` naming the server on any failure. This is the
    single mockable seam — tests patch it to simulate reachability outcomes.
    """
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(
        command=server.command,
        args=list(server.args),
        env=_resolve_env(server),
    )
    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                return [tool.name for tool in listed.tools]
    except McpProbeError:
        raise
    except FileNotFoundError as exc:
        # The launcher binary (e.g. uvx / your-warehouse-mcp) is not installed.
        raise McpProbeError(
            name, f"launcher {server.command!r} not found on PATH ({exc.strerror})"
        ) from None
    except Exception as exc:  # noqa: BLE001 — categorise without leaking a secret
        raise McpProbeError(name, f"unreachable or failed to initialise ({type(exc).__name__})") from None


def probe_servers(config: OswaldConfig) -> list[CheckResult]:
    """Probe every configured MCP server; one named :class:`CheckResult` each.

    PASS when the server connects and returns a non-empty tool list. FAIL (naming
    the server + cause) on any connection/initialise/empty-list failure. The
    overall ``validate`` exit code is non-zero if any of these FAIL.
    """
    results: list[CheckResult] = []
    for name, server in config.mcp_servers.items():
        try:
            tools = asyncio.run(_connect_and_list(name, server))
        except McpProbeError as exc:
            results.append(
                CheckResult(
                    name=f"mcp:{name}",
                    status=CheckStatus.FAIL,
                    message=f"MCP server '{name}' {exc.cause}",
                )
            )
            continue
        if not tools:
            results.append(
                CheckResult(
                    name=f"mcp:{name}",
                    status=CheckStatus.FAIL,
                    message=f"MCP server '{name}' connected but exposed no tools "
                    "(check DBT_MCP_ENABLE_TOOLS / server config)",
                )
            )
            continue
        results.append(
            CheckResult(
                name=f"mcp:{name}",
                status=CheckStatus.PASS,
                message=f"MCP server '{name}' reachable ({len(tools)} tools)",
            )
        )
    return results


# Backwards-/plan-compatible alias: the plan's artifact spec names the export
# ``probe_mcp_servers``; the test scaffold (tests/test_mcp_probe.py) asserts
# ``probe_servers``. Expose both so neither contract drifts.
probe_mcp_servers = probe_servers

__all__ = ["probe_servers", "probe_mcp_servers", "McpProbeError"]
