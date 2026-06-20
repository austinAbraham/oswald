"""Default connector-binding profiles + import-time Rule-of-Two invariants (BIND-01).

Ships the four default binding profiles (``dbt-local`` / ``github`` / ``atlassian``
/ ``custom``) as frozen module constants, in the style of ``toolsets.py``'s
``READ_ONLY_TOOLS``/``BUILD_TOOLS``. ``dbt-local`` binds the warehouse role to the
local ``dbt-eda`` server (D-05/D-08) — no profile may bind the warehouse to a
hosted connector, and import-time assertions FAIL the build if that invariant or
the "no write verb in the resolved EDA grant" invariant is ever broken (the same
discipline the M1 ``toolsets.py`` uses).

The destructive-tool vocabulary is reused from :mod:`oswald.mcp.toolsets`
(``_WRITE_FRAGMENTS`` / ``_PR_WRITE_FRAGMENTS``) — ONE source of truth, never
redefined here (RESEARCH §Don't Hand-Roll).
"""

from __future__ import annotations

from typing import Literal

from oswald.binding.resolve import resolve_logical_tool
from oswald.config.schema import BindingsConfig, RoleBinding
from oswald.mcp.toolsets import _PR_WRITE_FRAGMENTS, _WRITE_FRAGMENTS

#: The default-profile names a user can select (or override individual mappings).
ProfileName = Literal["dbt-local", "github", "atlassian", "custom"]

#: The local dbt-mcp server the warehouse role MUST bind to (D-05/D-08). The
#: warehouse-data path stays local in both postures; never a hosted connector.
LOCAL_WAREHOUSE_SERVER = "dbt-eda"

#: Read-only logical tools the EDA context resolves for the warehouse role. Mirrors
#: the ``_EDA_DBT_VERBS`` allowlist; used by the import-time invariant to prove the
#: resolved EDA grant set holds no write/PR fragment.
_EDA_WAREHOUSE_LOGICAL_TOOLS: tuple[str, ...] = ("show", "compile", "list", "parse", "docs")

# --------------------------------------------------------------------------- #
# Default profiles — frozen constants in the toolsets.py style.
# --------------------------------------------------------------------------- #
# Each profile is a BindingsConfig whose warehouse role ALWAYS stays local
# (dbt-eda). The peripheral roles (ticketing/git) ride whatever the profile names;
# `custom`/`dbt-local` leave them unbound (the user fills them in).

_DBT_LOCAL_PROFILE = BindingsConfig(
    profile="dbt-local",
    warehouse=RoleBinding(server=LOCAL_WAREHOUSE_SERVER),
)

_GITHUB_PROFILE = BindingsConfig(
    profile="github",
    warehouse=RoleBinding(server=LOCAL_WAREHOUSE_SERVER),
    git=RoleBinding(
        server="github",
        tool_map={"open_pr": "create_pull_request", "get_pr": "get_pull_request"},
    ),
)

_ATLASSIAN_PROFILE = BindingsConfig(
    profile="atlassian",
    warehouse=RoleBinding(server=LOCAL_WAREHOUSE_SERVER),
    ticketing=RoleBinding(
        server="atlassian",
        tool_map={"get_issue": "getJiraIssue", "search_issues": "searchJiraIssues"},
    ),
)

_CUSTOM_PROFILE = BindingsConfig(
    profile="custom",
    warehouse=RoleBinding(server=LOCAL_WAREHOUSE_SERVER),
)

_PROFILES: dict[str, BindingsConfig] = {
    "dbt-local": _DBT_LOCAL_PROFILE,
    "github": _GITHUB_PROFILE,
    "atlassian": _ATLASSIAN_PROFILE,
    "custom": _CUSTOM_PROFILE,
}

# --------------------------------------------------------------------------- #
# Import-time invariants — fail the build if Rule-of-Two / residency is broken.
# --------------------------------------------------------------------------- #
# (a) No profile binds the warehouse role to anything but the local dbt-mcp server.
assert all(
    profile.warehouse.server == LOCAL_WAREHOUSE_SERVER for profile in _PROFILES.values()
), "a binding profile bound the warehouse role to a non-local server — D-05/D-08 violation"

# (b) The resolved EDA grant set (the warehouse role's read-only logical tools,
#     across every install mode) holds no write/test/clone/merge or PR-write
#     fragment — the binding layer can never smuggle a write tool into the read
#     (EDA) context (reuses the toolsets.py fragments, one source of truth).
_RESOLVED_EDA_GRANTS: frozenset[str] = frozenset(
    resolve_logical_tool(
        LOCAL_WAREHOUSE_SERVER, logical, tool_map={}, install_mode=mode
    )
    for logical in _EDA_WAREHOUSE_LOGICAL_TOOLS
    for mode in ("pack", "bundled", "borrowed")
)
assert not any(
    frag in tool for tool in _RESOLVED_EDA_GRANTS for frag in _WRITE_FRAGMENTS
), "the resolved EDA warehouse grant leaked a write/test/clone/merge verb — Rule-of-Two violation"
assert not any(
    frag in tool for tool in _RESOLVED_EDA_GRANTS for frag in _PR_WRITE_FRAGMENTS
), "the resolved EDA warehouse grant leaked a git-write/PR/merge tool — Rule-of-Two violation"


def profile_for(name: str) -> BindingsConfig:
    """Return the default :class:`BindingsConfig` for a profile name (fail loud).

    Args:
        name: ``"dbt-local"`` | ``"github"`` | ``"atlassian"`` | ``"custom"``.

    Returns:
        The default binding profile (warehouse always local).

    Raises:
        ValueError: if ``name`` is not a known profile (fail loud, not silent) —
            mirrors :func:`oswald.mcp.toolsets.tools_for_role`.
    """
    try:
        return _PROFILES[name]
    except KeyError:
        valid = ", ".join(sorted(_PROFILES))
        raise ValueError(f"unknown binding profile {name!r}; expected one of: {valid}") from None


__all__ = ["ProfileName", "LOCAL_WAREHOUSE_SERVER", "profile_for"]
