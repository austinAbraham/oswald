"""Install-mode-aware logical→actual tool-name resolver (BIND-01).

The same *logical* tool has different concrete ``mcp__...`` names depending on
how Oswald is installed:

* **pack** (project ``.mcp.json``) / **borrowed** (host connector) →
  ``mcp__<server>__<tool>``
* **bundled** (server bundled inside the ``oswald`` plugin) →
  ``mcp__plugin_oswald_<server>__<tool>``  ``[CITED: code.claude.com/docs/en/mcp]``

This module is the single resolution seam. It is a pure, side-effect-free config→
name mapping with NO Claude Code coupling — the M2 Pydantic-AI service reuses it
verbatim. Cross-vendor renames (logical ``get_issue`` → actual ``getJiraIssue``)
are handled by the per-role ``tool_map``; the install-mode *prefix* is handled
here. The two compose in :func:`resolve_logical_tool`.
"""

from __future__ import annotations

from typing import Literal, Mapping

#: How Oswald is installed — selects the tool-name prefix scheme (Pattern 3).
#:   ``pack`` / ``borrowed`` → ``mcp__<server>__<tool>``
#:   ``bundled``            → ``mcp__plugin_<plugin>_<server>__<tool>``
InstallMode = Literal["pack", "bundled", "borrowed"]


def actual_tool_name(
    server: str,
    tool: str,
    *,
    install_mode: str,
    plugin: str = "oswald",
) -> str:
    """Resolve a logical ``(server, tool)`` to its concrete ``mcp__`` rule name.

    Args:
        server: The MCP server name (e.g. ``"dbt-eda"``, ``"github"``).
        tool: The actual tool name on that server (already vendor-resolved; the
            cross-vendor rename happens in :func:`resolve_logical_tool`).
        install_mode: ``"pack"`` | ``"bundled"`` | ``"borrowed"``. Only ``bundled``
            prefixes ``plugin_<plugin>_``; pack/borrowed use the plain prefix.
        plugin: The plugin name used for the ``bundled`` prefix (default ``oswald``).

    Returns:
        The concrete Claude Code permission-rule name, e.g.
        ``"mcp__dbt-eda__show"`` (pack/borrowed) or
        ``"mcp__plugin_oswald_dbt-eda__show"`` (bundled).
    """
    if install_mode == "bundled":
        return f"mcp__plugin_{plugin}_{server}__{tool}"
    return f"mcp__{server}__{tool}"


def resolve_logical_tool(
    server: str,
    logical_tool: str,
    *,
    tool_map: Mapping[str, str] | None = None,
    install_mode: str,
    plugin: str = "oswald",
) -> str:
    """Resolve a *logical* tool to its concrete ``mcp__`` name (rename + prefix).

    First applies the cross-vendor ``tool_map`` (logical → actual vendor name),
    then the install-mode prefix. The two transforms compose: ``get_issue`` on an
    Atlassian binding with ``{"get_issue": "getJiraIssue"}`` and
    ``install_mode="borrowed"`` resolves to ``mcp__atlassian__getJiraIssue``.

    Args:
        server: The MCP server providing the role (e.g. ``"atlassian"``).
        logical_tool: The logical tool name the skill/orchestrator references.
        tool_map: Optional logical→actual rename map for this binding.
        install_mode: ``"pack"`` | ``"bundled"`` | ``"borrowed"``.
        plugin: Plugin name for the ``bundled`` prefix.

    Returns:
        The concrete ``mcp__...`` permission-rule name.
    """
    actual = tool_map.get(logical_tool, logical_tool) if tool_map else logical_tool
    return actual_tool_name(server, actual, install_mode=install_mode, plugin=plugin)


__all__ = ["InstallMode", "actual_tool_name", "resolve_logical_tool"]
