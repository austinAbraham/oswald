"""Oswald MCP layer — scoped tool-sets enforcing the Rule of Two (MCP-03 / SEC-01).

This package is **config / source-of-truth**, not pipeline-orchestrator code (D-10).
It ships the per-role tool-name allowlists that both the M1 ``oswald validate``
preflight (plan 05) and the Claude Code orchestrator skill / permission rules
(plan 06) consume so the read-only EDA role and the sandbox build role can never
drift apart.

The split is enforced at THREE independent layers across the phase — warehouse
roles, dbt targets, and dbt-mcp tool whitelists (RESEARCH Pattern 2 / ARCHITECTURE
Pattern 4). These constants are the Claude-Code permission-rule layer: the
``mcp__<server>__<tool>`` allowlists that scope what each role may call. They are
defense-in-depth ON TOP of dbt-mcp's own ``DBT_MCP_ENABLE_TOOLS`` whitelist in
``.mcp.json`` — never a prompt-level "you are read-only" instruction, which prompt
injection defeats (RESEARCH Anti-Patterns).
"""

from oswald.mcp.toolsets import (
    BUILD_TOOLS,
    READ_ONLY_TOOLS,
    tools_for_role,
)

__all__ = ["BUILD_TOOLS", "READ_ONLY_TOOLS", "tools_for_role"]
