"""SEC-03 — bot git identity is PR-only; branch-protection checked; cannot merge.

The threat is privilege elevation via merge (T-ELEVATION-MERGE): the bot must be
able to open a PR but never merge — the no-merge guarantee comes from branch
protection (the bot is not a bypass actor). This module asserts the contract via
the conftest ``mock_github_api`` (green from plan 01-02, since the mock encodes
the PR-only contract) plus an xfail check that ``validate`` warns when branch
protection is absent (CLI wiring lands later).
"""

from __future__ import annotations

import importlib

import pytest


def test_bot_can_open_pr(mock_github_api):
    """The bot identity can open a pull request (PR-only path works)."""
    pr = mock_github_api.open_pull_request(
        head="oswald/ticket-DEMO-1", base="main", title="DEMO-1: daily customer revenue"
    )
    assert pr["number"] == 1
    assert mock_github_api.opened_prs


def test_bot_cannot_merge(mock_github_api):
    """The bot identity cannot merge — merge is a human-only gate (SEC-03)."""
    mock_github_api.open_pull_request(head="oswald/ticket-DEMO-1", base="main", title="t")
    with pytest.raises(PermissionError):
        mock_github_api.merge_pull_request(1)


def test_bot_token_scopes_are_pr_only(mock_github_api):
    """The bot token holds contents+pull-requests write, nothing broader."""
    assert set(mock_github_api.token_scopes) == {"contents:write", "pull-requests:write"}


@pytest.mark.xfail(reason="awaiting validate branch-protection check (SEC-03)", strict=False)
def test_validate_warns_when_branch_protection_absent():
    """`oswald validate` warns when branch protection is missing (RESEARCH Open Q1)."""
    try:
        mod = importlib.import_module("oswald.preflight.git_probe")
    except ModuleNotFoundError:
        pytest.fail("oswald.preflight.git_probe not implemented yet (SEC-03)")
    assert hasattr(mod, "check_branch_protection")
