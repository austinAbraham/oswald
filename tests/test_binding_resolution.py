"""BIND-01 — connector binding: logical→actual resolution + warehouse-defaults-local.

Mirrors ``tests/test_tool_scoping.py``'s set-membership assertion style over tool
surfaces. The binding layer resolves a logical ``(server, tool)`` pair to the
concrete ``mcp__...`` permission-rule name, accounting for the install mode (pack
vs plugin-bundled prefix; RESEARCH §Pattern 3) and the cross-vendor tool-name map
(logical ``get_issue`` → ``getJiraIssue`` for Atlassian).

Each behaviour maps to a VALIDATION Per-Task row:

* ``test_actual_tool_name_pack_vs_bundled`` — pack vs ``mcp__plugin_oswald_...`` prefix.
* ``test_cross_vendor_tool_map``            — a ``tool_map`` resolves a logical name.
* ``test_warehouse_defaults_local``         — the warehouse role defaults to the
  local ``dbt-eda`` server, NEVER a hosted connector (D-05 / D-08, residency).

RED/SKIP until ``oswald.binding.resolve`` + the ``BindingsConfig`` schema land
(Plan 02) — every target is imported lazily inside the test body so collection
never errors on the absent module.
"""

from __future__ import annotations

import pytest


def _resolve():
    """Lazily import the binding resolver, skipping if it has not landed yet."""
    try:
        from oswald.binding import resolve  # noqa: PLC0415
    except ModuleNotFoundError:
        pytest.skip("oswald.binding.resolve not implemented yet (BIND-01, Plan 02)")
    return resolve


def _bindings_config():
    """Lazily import the BindingsConfig model, skipping if it has not landed yet."""
    try:
        from oswald.config.schema import BindingsConfig  # noqa: PLC0415
    except (ModuleNotFoundError, ImportError):
        pytest.skip("BindingsConfig not implemented yet (BIND-01/MODE-01, Plan 02)")
    return BindingsConfig


def test_actual_tool_name_pack_vs_bundled():
    """A logical (server, tool) resolves to the right mcp__ name per install mode."""
    resolve = _resolve()
    assert (
        resolve.actual_tool_name("dbt-eda", "show", install_mode="pack")
        == "mcp__dbt-eda__show"
    )
    assert (
        resolve.actual_tool_name("dbt-eda", "show", install_mode="bundled")
        == "mcp__plugin_oswald_dbt-eda__show"
    )
    # A borrowed host connector keeps the host-scoped (unprefixed) name.
    assert (
        resolve.actual_tool_name("github", "merge_pull_request", install_mode="borrowed")
        == "mcp__github__merge_pull_request"
    )


def test_cross_vendor_tool_map():
    """A logical→actual tool_map resolves cross-vendor names (get_issue→getJiraIssue)."""
    resolve = _resolve()
    tool_map = {"get_issue": "getJiraIssue"}
    actual = resolve.resolve_logical_tool(
        "atlassian", "get_issue", tool_map=tool_map, install_mode="borrowed"
    )
    assert actual == "mcp__atlassian__getJiraIssue", actual


def test_warehouse_defaults_local():
    """D-05/D-08 — the warehouse role defaults to local dbt-eda, never a hosted conn."""
    bindings_cls = _bindings_config()
    bindings = bindings_cls()
    assert bindings.warehouse.server == "dbt-eda", (
        "the warehouse role MUST default to the local dbt-mcp server (D-05/D-08) — "
        f"never a hosted connector, got {bindings.warehouse.server!r}"
    )


@pytest.mark.parametrize(
    "aliased_server",
    [
        "sf",  # aliased hosted Snowflake under a fresh mcp_servers key
        "wh",
        "snowflake",
        "snow-prod",
        "dbt-remote",
        "snowflake-managed",  # even the originally-denylisted names stay rejected
        "atlassian",
        "github",
        "dbt-cloud",
        "Snowflake-Hosted",  # case / trailing-space variants the denylist missed
        "snowflake-cloud ",
    ],
)
def test_warehouse_rejects_aliased_hosted_connector(aliased_server):
    """WR-05 — a hosted connector aliased under ANY name is rejected by the allowlist.

    The original 7-name denylist passed any name not literally enumerated, so a
    hosted Snowflake/dbt-Cloud connector registered under ``sf``/``wh``/``snow-prod``
    bound the warehouse role and EVADED the residency rule. The positive allowlist
    rejects everything not known-local (and not explicitly marked local) — proven
    non-vacuous: these PASSed the pre-fix denylist.
    """
    bindings_cls = _bindings_config()
    with pytest.raises(Exception) as exc:  # pydantic ValidationError wrapping ValueError
        bindings_cls.model_validate({"warehouse": {"server": aliased_server}})
    message = str(exc.value).lower()
    assert "local" in message and (
        "d-05" in message or "d-08" in message or "residency" in message or "off-boundary" in message
    ), f"the rejection must explain the residency rule, got: {exc.value}"


@pytest.mark.parametrize("local_server", ["dbt-eda", "dbt-build", "dbt-local", "dbt-mcp"])
def test_warehouse_accepts_known_local_servers(local_server):
    """WR-05 — the known-local dbt-mcp server names are accepted by the allowlist."""
    bindings_cls = _bindings_config()
    bindings = bindings_cls.model_validate({"warehouse": {"server": local_server}})
    assert bindings.warehouse.server == local_server


def test_warehouse_explicit_local_escape_hatch():
    """WR-05 — a custom local dbt-mcp launcher can be marked ``local: true`` and accepted.

    The escape hatch must be EXPLICIT (the operator's signed statement), not name
    inference: the same custom name WITHOUT the flag is rejected.
    """
    bindings_cls = _bindings_config()
    # Without the flag: rejected (not a known-local name).
    with pytest.raises(Exception):
        bindings_cls.model_validate({"warehouse": {"server": "my-local-dbt"}})
    # With local: true: accepted.
    bindings = bindings_cls.model_validate(
        {"warehouse": {"server": "my-local-dbt", "local": True}}
    )
    assert bindings.warehouse.server == "my-local-dbt"
    assert bindings.warehouse.local is True
