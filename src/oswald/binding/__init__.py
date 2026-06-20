"""Oswald connector-binding layer (BIND-01).

A pure ``config.yaml`` → resolution layer that maps logical roles
(warehouse / ticketing / git) to concrete ``mcp__...`` tool names, install-mode
aware (pack vs plugin-bundled prefix). It has NO Claude Code coupling — the M2
Pydantic-AI service reuses it verbatim. Importing this package triggers the
``profiles`` import-time Rule-of-Two invariants (a deliberate violation FAILs the
build at import, the M1 ``toolsets.py`` discipline).
"""

from oswald.binding.profiles import LOCAL_WAREHOUSE_SERVER, ProfileName, profile_for
from oswald.binding.resolve import InstallMode, actual_tool_name, resolve_logical_tool

__all__ = [
    "InstallMode",
    "ProfileName",
    "LOCAL_WAREHOUSE_SERVER",
    "actual_tool_name",
    "resolve_logical_tool",
    "profile_for",
]
