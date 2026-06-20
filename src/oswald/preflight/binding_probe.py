"""Borrowed-tool Rule-of-Two binding probe for ``oswald validate`` (BIND-02 / D-06).

For each bound logical role (``warehouse`` / ``ticketing`` / ``git``) the probe
connects the providing MCP server, lists its tools (reusing the M1
``mcp_probe._connect_and_list`` seam), and runs three Rule-of-Two assertions in
the established ``CheckResult`` PASS/WARN/FAIL vocabulary:

* **(i) mapped-tool existence** — every logical→actual tool in the binding's
  ``tool_map`` must exist on the connected server, else **FAIL** naming the server
  and the missing tool (CLI-02: name the exact misconfig, never "failed").
* **(ii) un-scopable destructive borrowed tool** — a host connector may expose a
  destructive tool (``merge_pull_request``, ``create_pull_request``, ``push``,
  ``deleteJiraIssue``, ``create_or_update_file``, …) that Oswald cannot disable at
  the source. Each such *listed* tool — classified by the shared verb-stem
  detector, not a closed name list — yields a **WARN** naming the exact tool and
  directing it to ``.claude/settings.json`` deny + out of every agent grant set
  (D-06, Pitfall 5). This runs for ANY borrowed (non-local) role, even one with an
  empty ``tool_map`` (WR-04). A WARN never fails the run.
* **(iii) EDA holds no write** — the EDA context (read-only intake/EDA: the
  warehouse + ticketing read roles) must hold NO ticket-write / warehouse-write
  tool. If a binding's ``tool_map`` would resolve an EDA-context logical tool to a
  write/destructive actual tool — caught by the same verb-stem detector, so
  ``create_pull_request`` / ``deleteJiraIssue`` / ``updateJiraIssue`` are no longer
  missed — **FAIL** naming it (Rule of Two, D-10).

Security: no message echoes a secret. Messages surface only the role / server /
tool name + a failure category (threat T-05-01). The write/destructive
classification is the SINGLE detector :func:`oswald.mcp.toolsets.is_write_tool`
(a case-insensitive verb-stem denylist) — one source of truth shared with the
toolsets allowlist asserts and the resolver asserts in ``profiles.py`` (CR-01 /
CR-02 / WR-03 / WR-04). A name-based literal allowlist could be outrun by a
connector inventing a new destructive verb; the stem denylist cannot.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Callable

from oswald.preflight import CheckResult, CheckStatus
from oswald.preflight.mcp_probe import McpProbeError, _connect_and_list
from oswald.mcp.toolsets import is_write_tool

if TYPE_CHECKING:  # pragma: no cover
    from oswald.config.schema import BindingsConfig, OswaldConfig, RoleBinding

#: The local, residency-pinned warehouse server (D-05/D-08). A role bound to this
#: server is the default local dbt-mcp surface — already pinned by the parse-time
#: ``BindingsConfig`` validator and the ``profiles.py`` import asserts — so it is
#: the ONLY binding the borrowed-tool probe may skip (WR-04). Imported lazily
#: inside helpers to avoid an import cycle (profiles -> schema -> ... ).
_LOCAL_WAREHOUSE_SERVER = "dbt-eda"

#: Illustrative real destructive borrowed tool names a host connector may expose
#: that Oswald cannot disable at the source (the un-scopable case, D-06 / Pitfall
#: 5). This set is NO LONGER the classifier — :func:`is_write_tool` (the verb-stem
#: denylist in :mod:`oswald.mcp.toolsets`) is. It is kept only as documentation /
#: a sanity floor: every name here MUST classify as a write tool (asserted at
#: import time below). The real GitHub/Atlassian write surface is far larger than
#: this list. VERIFIED real names across GitHub official MCP + Atlassian Rovo.
DESTRUCTIVE_BORROWED: frozenset[str] = frozenset(
    {
        # GitHub
        "merge_pull_request",
        "create_pull_request",
        "create_branch",
        "push",
        "push_files",
        "create_or_update_file",
        "delete_file",
        "fork_repository",
        # Atlassian (Jira)
        "editJiraIssue",
        "updateJiraIssue",
        "deleteJiraIssue",
        "createJiraIssue",
        "transitionJiraIssue",
        "addCommentToJiraIssue",
        "addAttachmentToJiraIssue",
    }
)

# Sanity floor (CR-01/WR-03): the classifier MUST flag every documented
# destructive borrowed name. If a future edit narrows the verb-stems and lets one
# through, fail the build loudly here rather than at a Rule-of-Two bypass.
assert all(is_write_tool(name) for name in DESTRUCTIVE_BORROWED), (
    "is_write_tool failed to classify a known destructive borrowed tool — the "
    "verb-stem denylist regressed (CR-01/WR-03)"
)

#: Roles whose tools land in the read-only EDA (intake/EDA) context. The EDA fork
#: must never hold a ticket-write or warehouse-write tool (Rule of Two, D-10). The
#: ``git`` role is build-only and is NOT part of the EDA context.
_EDA_CONTEXT_ROLES: frozenset[str] = frozenset({"warehouse", "ticketing"})

#: A connect-and-list seam: ``(server_name, server_obj) -> list[tool_name]``. The
#: default wraps the async M1 ``mcp_probe._connect_and_list`` via ``asyncio.run``;
#: tests inject a synchronous stub returning a canned tool list (no live host).
ConnectAndList = Callable[[str, object], list[str]]


def _default_connect_and_list(name: str, server: object) -> list[str]:
    """Synchronous wrapper over the async M1 ``_connect_and_list`` seam."""
    return asyncio.run(_connect_and_list(name, server))  # type: ignore[arg-type]


def _is_write_tool(tool: str) -> bool:
    """True if a tool name is a write/destructive tool (the shared classifier).

    Delegates to :func:`oswald.mcp.toolsets.is_write_tool` — a case-insensitive
    verb-stem denylist that catches the full borrowed GitHub/Atlassian destructive
    surface (``create_pull_request``, ``deleteJiraIssue``, ``mergePullRequest``
    camelCase, …), not just the five literal names this probe used to enumerate
    (CR-01/WR-03). One source of truth, never re-implemented here.
    """
    return is_write_tool(tool)


def _bindings_of(config: BindingsConfig | OswaldConfig) -> BindingsConfig:
    """Accept either an OswaldConfig (``.bindings``) or a BindingsConfig directly."""
    return getattr(config, "bindings", config)


def _server_obj(config: BindingsConfig | OswaldConfig, server_name: str) -> object:
    """The McpServer registration for ``server_name`` if the config carries one.

    The CLI passes an ``OswaldConfig`` with ``mcp_servers``; the unit tests pass a
    bare ``BindingsConfig`` and inject their own ``connect_and_list`` (so the
    server object is unused). Returns ``None`` when no registration is available.
    """
    servers = getattr(config, "mcp_servers", None)
    if servers is None:
        return None
    return servers.get(server_name)


def _bound_roles(
    bindings: BindingsConfig,
) -> list[tuple[str, RoleBinding]]:
    """Yield ``(role_name, RoleBinding)`` for every role the borrowed-tool probe must check.

    A role is probed if it is bound to a connector whose un-scopable destructive
    surface needs enumerating — i.e. it has a non-empty ``tool_map`` (an explicit
    rename to verify) OR it is bound to a *non-local* server (a borrowed connector
    whose listed tools must be surfaced even with no ``tool_map`` — WR-04). A
    no-``tool_map`` borrowed binding (``git: {server: "github"}``) is the most
    likely real config (vendor names match logical names) and is exactly the one
    the old "skip empty tool_map" filter let slip past the destructive-tool WARN.

    The ONLY skip is the residency-pinned local warehouse default
    (``dbt-eda``, empty ``tool_map``): it has nothing to resolve against a live
    server and its residency invariant is already enforced at parse time
    (``BindingsConfig`` validator) and import time (``profiles.py``).
    """
    candidates: list[tuple[str, RoleBinding | None]] = [
        ("warehouse", bindings.warehouse),
        ("ticketing", bindings.ticketing),
        ("git", bindings.git),
    ]
    return [
        (role, binding)
        for role, binding in candidates
        if binding is not None
        and (binding.tool_map or binding.server != _LOCAL_WAREHOUSE_SERVER)
    ]


def probe_binding(
    config: BindingsConfig | OswaldConfig,
    *,
    connect_and_list: ConnectAndList | None = None,
) -> list[CheckResult]:
    """Probe every bound role's connector for Rule-of-Two compliance (BIND-02).

    Args:
        config: An :class:`OswaldConfig` (uses ``.bindings`` + ``.mcp_servers``) or
            a bare :class:`BindingsConfig` (tests inject ``connect_and_list``).
        connect_and_list: Injectable ``(server, obj) -> [tool]`` seam. Defaults to
            the live async M1 seam wrapped in ``asyncio.run``.

    Returns:
        A list of named :class:`CheckResult` — FAIL on a missing mapped tool or an
        EDA-context write grant, WARN on an un-scopable destructive borrowed tool.
        A WARN never fails the run; a FAIL drives a non-zero ``validate`` exit.
    """
    connect = connect_and_list or _default_connect_and_list
    bindings = _bindings_of(config)
    results: list[CheckResult] = []

    for role, binding in _bound_roles(bindings):
        server = binding.server
        try:
            listed = list(connect(server, _server_obj(config, server)))
        except McpProbeError as exc:
            results.append(
                CheckResult(
                    name=f"binding:{role}",
                    status=CheckStatus.FAIL,
                    message=f"role '{role}' server '{server}': {exc.cause}",
                )
            )
            continue

        listed_set = set(listed)

        # (i) every mapped logical->actual tool must exist on the connected server.
        for logical, actual in binding.tool_map.items():
            if actual not in listed_set:
                results.append(
                    CheckResult(
                        name=f"binding:{role}:{logical}",
                        status=CheckStatus.FAIL,
                        message=(
                            f"role '{role}': mapped tool '{logical}' -> '{actual}' "
                            f"not found on server '{server}' "
                            f"(it exposes: {', '.join(sorted(listed_set)) or 'no tools'})"
                        ),
                    )
                )

        # (iii) EDA-context roles must resolve to NO write/destructive tool — a
        # ticket-write/warehouse-write tool in the read context is a Rule-of-Two
        # elevation (D-10). Checked before (ii) so the FAIL is emitted.
        if role in _EDA_CONTEXT_ROLES:
            for logical, actual in binding.tool_map.items():
                if _is_write_tool(actual):
                    results.append(
                        CheckResult(
                            name=f"binding:{role}:eda-write",
                            status=CheckStatus.FAIL,
                            message=(
                                f"role '{role}' (EDA read context) would hold WRITE tool "
                                f"'{actual}' (mapped from '{logical}') on server '{server}' "
                                "— the EDA fork must never hold a ticket-write/warehouse-write "
                                "tool (Rule of Two, D-10)"
                            ),
                        )
                    )

        # (ii) any LISTED destructive borrowed tool is un-scopable at the source —
        # WARN naming it (the deny rule is the only backstop, D-06 / Pitfall 5).
        for tool in sorted(listed_set):
            if _is_write_tool(tool):
                results.append(
                    CheckResult(
                        name=f"binding:{role}:deny",
                        status=CheckStatus.WARN,
                        message=(
                            f"role '{role}' server '{server}' exposes destructive tool "
                            f"'{tool}' (un-scopable at the host) — ensure it is in "
                            ".claude/settings.json deny and out of every agent grant set "
                            "(Rule of Two over borrowed tools, D-06)"
                        ),
                    )
                )

        # PASS marker so a fully-clean binding is visible in the report.
        if not any(r.name.startswith(f"binding:{role}") for r in results):
            results.append(
                CheckResult(
                    name=f"binding:{role}",
                    status=CheckStatus.PASS,
                    message=(
                        f"role '{role}' server '{server}': all {len(binding.tool_map)} "
                        "mapped tools present, no un-scopable destructive tool"
                    ),
                )
            )

    return results


__all__ = ["DESTRUCTIVE_BORROWED", "probe_binding"]
