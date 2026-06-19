"""Per-role MCP tool-set allowlists — the Rule-of-Two split as code (MCP-03 / SEC-01).

Two scoped, frozen tool-name allowlists, expressed in Claude Code's
``mcp__<server>__<tool>`` permission-rule namespace:

* ``READ_ONLY_TOOLS`` — the EDA role (untrusted ticket + read-only warehouse, no
  write/PR power). Read-only dbt verbs against the ``dbt-eda`` instance, read-only
  warehouse access, ticketing reads. Holds **no** ``build``/``run``/``test``/
  ``clone`` verb and **no** git-write/merge tool (T-04-01, threat register).
* ``BUILD_TOOLS`` — the build role (acts on the human-approved plan; writes the
  sandbox schema only; opens a PR, never merges). The sandbox-write dbt verbs
  against the ``dbt-build`` instance plus the PR-only git surface and ticketing
  comment. ``clone`` is **omitted** (highest blast radius — RESEARCH Anti-Patterns,
  T-04-02).

These constants mirror the ``DBT_MCP_ENABLE_TOOLS`` allowlists shipped in
``.mcp.json`` (defense in depth at two layers). The dbt verb sets are kept in
lock-step with the ``.mcp.json`` env blocks: EDA = ``show,compile,list,parse,docs``;
build = ``build,run,test,compile,list`` (no ``clone``).

``tools_for_role(role)`` returns the scoped set by role name so plan 05's validate
and plan 06's skill/permission rules consume one source of truth.
"""

from __future__ import annotations

from typing import Literal

# --------------------------------------------------------------------------- #
# Role names — match the dbt-mcp registrations in .mcp.json (dbt-eda / dbt-build).
# --------------------------------------------------------------------------- #
Role = Literal["eda", "build"]

# dbt verb sets — kept in lock-step with the DBT_MCP_ENABLE_TOOLS allowlists in
# .mcp.json. Source of truth for the dbt-mcp layer of the split.
_EDA_DBT_VERBS = ("show", "compile", "list", "parse", "docs")
_BUILD_DBT_VERBS = ("build", "run", "test", "compile", "list")  # NOTE: no clone

# --------------------------------------------------------------------------- #
# READ_ONLY_TOOLS — EDA role (A + B, never C). No write/PR/merge tool.
# --------------------------------------------------------------------------- #
READ_ONLY_TOOLS: frozenset[str] = frozenset(
    {
        # dbt-eda read-only verbs (mirror .mcp.json dbt-eda DBT_MCP_ENABLE_TOOLS)
        *(f"mcp__dbt-eda__{verb}" for verb in _EDA_DBT_VERBS),
        # read-only warehouse access (profiling SELECTs via the read-only SF role)
        "mcp__warehouse-ro__query",
        "mcp__warehouse-ro__describe",
        # ticketing — read only (the EDA role reads the ticket; it never comments)
        "mcp__ticketing__get_issue",
        "mcp__ticketing__search_issues",
    }
)

# --------------------------------------------------------------------------- #
# BUILD_TOOLS — build role (acts on approved plan; sandbox-write; PR-only; no merge).
# --------------------------------------------------------------------------- #
BUILD_TOOLS: frozenset[str] = frozenset(
    {
        # dbt-build sandbox-write verbs (mirror .mcp.json dbt-build, clone omitted)
        *(f"mcp__dbt-build__{verb}" for verb in _BUILD_DBT_VERBS),
        # git — PR-only identity; open PR + push branch, NEVER merge (SEC-03)
        "mcp__git__create_branch",
        "mcp__git__push",
        "mcp__git__open_pull_request",
        # ticketing — comment back on the worked ticket
        "mcp__ticketing__add_comment",
    }
)

# Verbs/tool fragments that must never appear in READ_ONLY_TOOLS (Rule-of-Two
# elevation guard) and the clone guard for BUILD_TOOLS.
_WRITE_FRAGMENTS = ("build", "run", "test", "clone", "seed", "snapshot", "merge")
_PR_WRITE_FRAGMENTS = ("open_pull_request", "create_branch", "push", "merge")

# --------------------------------------------------------------------------- #
# Invariants — fail at import time if the split is ever broken (correctness gate).
# --------------------------------------------------------------------------- #
assert not any(
    frag in tool for tool in READ_ONLY_TOOLS for frag in _WRITE_FRAGMENTS
), "READ_ONLY_TOOLS leaked a write/test/clone/merge verb — Rule-of-Two violation"
assert not any(
    frag in tool for tool in READ_ONLY_TOOLS for frag in _PR_WRITE_FRAGMENTS
), "READ_ONLY_TOOLS leaked a git-write/PR/merge tool — Rule-of-Two violation"
assert not any(
    "clone" in tool for tool in BUILD_TOOLS
), "BUILD_TOOLS holds clone — highest blast radius, omit in M1 (SEC-02)"
assert not any(
    "merge" in tool for tool in BUILD_TOOLS
), "BUILD_TOOLS holds a merge tool — merge is a human-only gate (SEC-03)"

_ROLE_TOOLS: dict[str, frozenset[str]] = {
    "eda": READ_ONLY_TOOLS,
    "build": BUILD_TOOLS,
}


def tools_for_role(role: Role) -> frozenset[str]:
    """Return the scoped tool-set allowlist for a pipeline role.

    Args:
        role: ``"eda"`` (read-only intake/EDA) or ``"build"`` (sandbox-write/PR).

    Returns:
        The frozen ``mcp__<server>__<tool>`` allowlist for that role.

    Raises:
        ValueError: if ``role`` is not a known role name (fail loud, not silent).
    """
    try:
        return _ROLE_TOOLS[role]
    except KeyError:
        valid = ", ".join(sorted(_ROLE_TOOLS))
        raise ValueError(f"unknown role {role!r}; expected one of: {valid}") from None
