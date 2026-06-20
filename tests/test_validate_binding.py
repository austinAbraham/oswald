"""BIND-02 — borrowed-tool Rule-of-Two probe (PASS/WARN/FAIL).

Mirrors ``tests/test_validate_errors.py``'s probe-testing style: inject a fake
``_connect_and_list`` seam returning a canned tool list, then assert
``result.status is CheckStatus.X`` and that the message NAMES the exact misconfig
(never a generic "failed"). The canned destructive surfaces come from the conftest
``GITHUB_BORROWED_TOOLS`` / ``ATLASSIAN_BORROWED_TOOLS`` constants (and the
``borrowed_connectors`` stub servers), so the probe is exercised with no live host
(``--disable-socket`` backstop).

Each behaviour maps to a VALIDATION Per-Task row:

* ``test_missing_tool_fails``        — a mapped logical tool absent from the listed
  set → FAIL whose message names the server + tool.
* ``test_destructive_borrowed_warns`` — an un-scopable destructive borrowed tool
  present → WARN naming it (e.g. ``mcp__github__merge_pull_request``).
* ``test_eda_no_write_grants``       — the resolved EDA grant set holds no
  ticket-write / warehouse-write tool → FAIL otherwise (Rule of Two).

RED/SKIP until ``oswald.preflight.binding_probe.probe_binding`` lands (Plan 03) —
imported lazily inside the test body so collection never errors on the absent
module.
"""

from __future__ import annotations

import pytest

from tests.conftest import (
    ATLASSIAN_BORROWED_TOOLS,
    GITHUB_BORROWED_TOOLS,
    PREVIOUSLY_MISSED_DESTRUCTIVE,
)


def _binding_probe():
    """Lazily import the binding probe, skipping if it has not landed yet."""
    try:
        from oswald.preflight import binding_probe  # noqa: PLC0415
    except (ModuleNotFoundError, ImportError):
        pytest.skip("oswald.preflight.binding_probe not implemented yet (BIND-02, Plan 03)")
    return binding_probe


def _check_status():
    """Lazily import the CheckStatus enum from the established preflight vocabulary."""
    from oswald.preflight import CheckStatus  # noqa: PLC0415

    return CheckStatus


def test_missing_tool_fails():
    """A mapped logical tool absent from the connected server's tools → FAIL naming it."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    # The github connector lists only its real tools; a binding that maps a logical
    # tool to a name NOT in that set must FAIL, naming the server + missing tool.
    listed = {"github": list(GITHUB_BORROWED_TOOLS)}

    def connect_and_list(name, _server):
        return list(listed[name])

    results = binding_probe.probe_binding(
        _binding_config_mapping_missing_tool(),
        connect_and_list=connect_and_list,
    )
    fails = [r for r in results if r.status is CheckStatus.FAIL]
    assert fails, "a missing mapped tool must FAIL (BIND-02)"
    msg = " ".join(r.message for r in fails).lower()
    assert "github" in msg, "the FAIL message must name the server"
    assert "nonexistent_tool" in msg, "the FAIL message must name the missing tool"


def test_destructive_borrowed_warns():
    """An un-scopable destructive borrowed tool present → WARN naming the tool."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    listed = {
        "github": list(GITHUB_BORROWED_TOOLS),
        "atlassian": list(ATLASSIAN_BORROWED_TOOLS),
    }

    def connect_and_list(name, _server):
        return list(listed[name])

    results = binding_probe.probe_binding(
        _binding_config_with_borrowed_destructive(),
        connect_and_list=connect_and_list,
    )
    warns = [r for r in results if r.status is CheckStatus.WARN]
    assert warns, "an un-scopable destructive borrowed tool must WARN (BIND-02)"
    msg = " ".join(r.message for r in warns)
    assert "merge_pull_request" in msg, (
        "the WARN must name the destructive tool (e.g. mcp__github__merge_pull_request)"
    )


def test_eda_no_write_grants():
    """The resolved EDA grant set holds NO ticket-write / warehouse-write tool."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    listed = {
        "atlassian": list(ATLASSIAN_BORROWED_TOOLS),  # includes editJiraIssue (write)
    }

    def connect_and_list(name, _server):
        return list(listed[name])

    results = binding_probe.probe_binding(
        _binding_config_eda_holds_ticket_write(),
        connect_and_list=connect_and_list,
    )
    # If the EDA context were granted a ticket-write tool, the probe FAILs naming it.
    fails = [r for r in results if r.status is CheckStatus.FAIL]
    assert fails, "EDA holding a ticket-write tool must FAIL (Rule of Two, D-10)"
    msg = " ".join(r.message for r in fails)
    assert "editJiraIssue" in msg or "write" in msg.lower(), (
        "the FAIL must name the ticket-write tool leaked into the EDA grant set"
    )


# --------------------------------------------------------------------------- #
# CR-01 / WR-03 / WR-04 — adversarial cases the original 5-name/7-fragment
# enumeration missed. These PROVE the verb-stem-detector fix: they fail loudly
# against the pre-fix code (which classified create_pull_request/deleteJiraIssue/
# … as read-only) and pass only once `is_write_tool` is the sound classifier.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("destructive", PREVIOUSLY_MISSED_DESTRUCTIVE)
def test_eda_context_fails_on_previously_missed_write_tool(destructive):
    """CR-01 — an EDA-context tool_map resolving to ANY real destructive borrowed
    tool the old enumeration missed must FAIL (Rule-of-Two bypass closed)."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    bindings_cls = _bindings_config()
    # ticketing is an EDA-context role; map a read logical name onto a destructive
    # actual tool that contains NONE of the original 7 fragments / 5 literal names.
    cfg = bindings_cls.model_validate(
        {"ticketing": {"server": "atlassian", "tool_map": {"get_issue": destructive}}}
    )

    def connect_and_list(_name, _server):
        # The connector lists the destructive tool so mapped-tool existence passes;
        # the only FAIL must be the EDA-context write grant.
        return [destructive, "getJiraIssue", "searchJiraIssues"]

    results = binding_probe.probe_binding(cfg, connect_and_list=connect_and_list)
    eda_fails = [
        r
        for r in results
        if r.status is CheckStatus.FAIL and "eda-write" in r.name
    ]
    assert eda_fails, (
        f"EDA context resolving get_issue -> {destructive!r} must FAIL "
        "(CR-01: destructive borrowed tool in the read context — Rule of Two D-10)"
    )
    msg = " ".join(r.message for r in eda_fails)
    assert destructive in msg, f"the FAIL must name the leaked write tool {destructive!r}"


@pytest.mark.parametrize("destructive", PREVIOUSLY_MISSED_DESTRUCTIVE)
def test_destructive_borrowed_warns_on_previously_missed_tool(destructive):
    """CR-01/WR-03 — a LISTED destructive borrowed tool the old enumeration missed
    yields a WARN naming it (the deny-list backstop signal)."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    bindings_cls = _bindings_config()
    # git is build-context (not EDA): the destructive listed tool must WARN, not FAIL.
    cfg = bindings_cls.model_validate(
        {"git": {"server": "github", "tool_map": {"open_pr": "get_pull_request"}}}
    )

    def connect_and_list(_name, _server):
        return ["get_pull_request", destructive]

    results = binding_probe.probe_binding(cfg, connect_and_list=connect_and_list)
    warns = [
        r
        for r in results
        if r.status is CheckStatus.WARN and destructive in r.message
    ]
    assert warns, (
        f"a listed destructive borrowed tool {destructive!r} must WARN "
        "(CR-01/WR-03: caught by the verb-stem detector, not a closed name list)"
    )


def test_camelcase_and_case_variants_are_caught():
    """WR-03 — vendor camelCase / case variants are caught case-insensitively."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    bindings_cls = _bindings_config()
    # A connector listing case/camel variants Oswald never enumerated literally.
    variants = ["mergePullRequest", "EditJiraIssue", "editjiraissue", "DeleteBranch"]
    cfg = bindings_cls.model_validate(
        {"git": {"server": "github", "tool_map": {"open_pr": "get_pull_request"}}}
    )

    def connect_and_list(_name, _server):
        return ["get_pull_request", *variants]

    results = binding_probe.probe_binding(cfg, connect_and_list=connect_and_list)
    warned = " ".join(r.message for r in results if r.status is CheckStatus.WARN)
    for v in variants:
        assert v in warned, f"case/camel variant {v!r} must WARN (WR-03 case-insensitive)"


def test_borrowed_role_with_empty_tool_map_is_probed():
    """WR-04 — a borrowed (non-local) role with an EMPTY tool_map is still probed;
    its un-scopable destructive listed tools WARN (the most-likely real config)."""
    binding_probe = _binding_probe()
    CheckStatus = _check_status()
    bindings_cls = _bindings_config()
    # `git: {server: github}` with NO tool_map — perfectly valid per the schema and
    # the config the review flagged as the one the old filter skipped entirely.
    cfg = bindings_cls.model_validate({"git": {"server": "github"}})

    def connect_and_list(name, _server):
        assert name == "github", "the empty-tool_map github role MUST be connected"
        return list(GITHUB_BORROWED_TOOLS)

    results = binding_probe.probe_binding(cfg, connect_and_list=connect_and_list)
    warns = [r for r in results if r.status is CheckStatus.WARN]
    assert warns, (
        "a borrowed git binding with empty tool_map must still surface its "
        "un-scopable destructive tools (WR-04)"
    )
    warned = " ".join(r.message for r in warns)
    assert "merge_pull_request" in warned and "create_branch" in warned, (
        "the empty-tool_map borrowed surface's destructive tools must each WARN (WR-04)"
    )


def test_local_warehouse_default_is_not_probed():
    """WR-04 — the residency-pinned local warehouse default (empty tool_map, dbt-eda)
    is the ONLY binding skipped; widening must not start probing it."""
    binding_probe = _binding_probe()
    bindings_cls = _bindings_config()
    cfg = bindings_cls.model_validate({})  # warehouse defaults to local dbt-eda

    connected: list[str] = []

    def connect_and_list(name, _server):
        connected.append(name)
        return ["show", "compile"]

    results = binding_probe.probe_binding(cfg, connect_and_list=connect_and_list)
    assert connected == [], "the local dbt-eda warehouse default must NOT be probed (WR-04)"
    assert results == [], "no checks emitted for the residency-pinned local default"


# --------------------------------------------------------------------------- #
# Config-fixture builders — lazily import the BindingsConfig schema (Plan 02).
# Each skips if the schema is absent so this module collects RED without error.
# --------------------------------------------------------------------------- #
def _bindings_config():
    try:
        from oswald.config.schema import BindingsConfig  # noqa: PLC0415
    except (ModuleNotFoundError, ImportError):
        pytest.skip("BindingsConfig not implemented yet (BIND-01/02, Plan 02)")
    return BindingsConfig


def _binding_config_mapping_missing_tool():
    """A git binding mapping a logical tool to a name absent from the server."""
    bindings_cls = _bindings_config()
    return bindings_cls.model_validate(
        {"git": {"server": "github", "tool_map": {"open_pr": "nonexistent_tool"}}}
    )


def _binding_config_with_borrowed_destructive():
    """Bindings riding the github + atlassian connectors that expose destructive tools."""
    bindings_cls = _bindings_config()
    return bindings_cls.model_validate(
        {
            "git": {"server": "github", "tool_map": {"open_pr": "create_pull_request"}},
            "ticketing": {"server": "atlassian", "tool_map": {"get_issue": "getJiraIssue"}},
        }
    )


def _binding_config_eda_holds_ticket_write():
    """A misconfiguration that would grant the EDA context a ticket-write tool."""
    bindings_cls = _bindings_config()
    return bindings_cls.model_validate(
        {"ticketing": {"server": "atlassian", "tool_map": {"get_issue": "editJiraIssue"}}}
    )
