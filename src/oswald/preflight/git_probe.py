"""Repo / warehouse access preflight — PR-capability + branch-protection WARN (SEC-03).

Three checks, each producing a named, secret-free :class:`CheckResult`:

* :func:`check_pr_capability` — the bot identity can open a PR (the PR-only path
  works). A missing/invalid token or absent repo access FAILs, naming the repo
  and the cause (never the token value — threat T-05-01).
* :func:`check_branch_protection` — branch protection on the protected branch is
  the no-merge control (the bot is PR-only and never a bypass actor; fine-grained
  PATs cannot separate create-PR from merge — GitHub #182732). Its absence is a
  **WARN, not a FAIL** (SEC-03 gray area, RESEARCH Open Q1): the bot is still
  PR-capable, but the operator must be told the no-merge guarantee is unenforced.
* :func:`check_warehouse_access` — the read-only warehouse role can SELECT (the
  EDA path works). A missing SELECT grant FAILs, naming the role/grant.

:func:`probe_repo` aggregates all three for ``cli.validate``.

Every external call goes through a small, monkeypatchable client seam
(:class:`GitHubClient`, :class:`WarehouseClient`) so tests mock GitHub/warehouse
outcomes without a live host — and the global ``--disable-socket`` default proves
no real network call happens in CI.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from oswald.preflight import CheckResult, CheckStatus

if TYPE_CHECKING:  # pragma: no cover
    from oswald.config import OswaldConfig


# --------------------------------------------------------------------------- #
# Client seams (mockable; no real host contacted in tests / CI)
# --------------------------------------------------------------------------- #
class GitHubClient(Protocol):
    """Minimal GitHub surface the repo probe needs (mockable in tests)."""

    token_scopes: list[str]

    def can_open_pull_request(self) -> bool: ...

    def branch_protection_enabled(self, branch: str) -> bool: ...


class WarehouseClient(Protocol):
    """Minimal warehouse surface the probe needs (mockable in tests)."""

    def can_select(self) -> bool: ...


# --------------------------------------------------------------------------- #
# Individual checks
# --------------------------------------------------------------------------- #
def check_pr_capability(config: OswaldConfig, client: GitHubClient | None = None) -> CheckResult:
    """PASS if the bot can open a PR against the configured repo; FAIL (named) otherwise."""
    repo = config.repo.remote
    if client is None:
        return CheckResult(
            name="repo:pr-capability",
            status=CheckStatus.FAIL,
            message=(
                f"repo '{repo}': could not verify PR capability — no reachable git "
                "client configured (set up the git MCP / bot token per "
                "docs/minimal-permissions.md)"
            ),
        )
    try:
        capable = client.can_open_pull_request()
    except Exception as exc:  # noqa: BLE001 — categorise without leaking the token
        return CheckResult(
            name="repo:pr-capability",
            status=CheckStatus.FAIL,
            message=f"repo '{repo}': PR-capability check failed ({type(exc).__name__})",
        )
    if not capable:
        return CheckResult(
            name="repo:pr-capability",
            status=CheckStatus.FAIL,
            message=(
                f"repo '{repo}': bot identity '{config.repo.bot_user}' cannot open a PR "
                "— check the bot token holds contents:write + pull-requests:write"
            ),
        )
    return CheckResult(
        name="repo:pr-capability",
        status=CheckStatus.PASS,
        message=f"repo '{repo}': bot can open PRs (PR-only path verified)",
    )


def check_branch_protection(
    config: OswaldConfig, client: GitHubClient | None = None
) -> CheckResult:
    """WARN (not FAIL) when branch protection is absent on the protected branch (SEC-03).

    Branch protection — not a token scope — is the no-merge enforcement (the bot
    holds contents+pull-requests write but is not a bypass actor). Its absence is
    a deliberate WARN so the run still proceeds while the gap is visibly surfaced
    (RESEARCH Open Q1).
    """
    branch = config.repo.protected_branch
    if client is None:
        return CheckResult(
            name="repo:branch-protection",
            status=CheckStatus.WARN,
            message=(
                f"branch protection on '{branch}' could not be verified (no git client) "
                "— ensure protection is enabled so the bot cannot merge (SEC-03)"
            ),
        )
    try:
        protected = client.branch_protection_enabled(branch)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(
            name="repo:branch-protection",
            status=CheckStatus.WARN,
            message=(
                f"branch protection on '{branch}' could not be verified "
                f"({type(exc).__name__}) — verify it manually (SEC-03)"
            ),
        )
    if not protected:
        return CheckResult(
            name="repo:branch-protection",
            status=CheckStatus.WARN,
            message=(
                f"branch protection ABSENT on '{branch}' — the no-merge guarantee is "
                "UNENFORCED; enable required-review branch protection and do not list the "
                "bot as a bypass actor (SEC-03, docs/minimal-permissions.md)"
            ),
        )
    return CheckResult(
        name="repo:branch-protection",
        status=CheckStatus.PASS,
        message=f"branch protection enabled on '{branch}' (no-merge control in place)",
    )


def check_warehouse_access(
    config: OswaldConfig, client: WarehouseClient | None = None
) -> CheckResult:
    """PASS if the read-only role can SELECT; FAIL (named role/grant) otherwise."""
    role = "OSWALD_READ_ONLY"
    if client is None:
        return CheckResult(
            name="warehouse:read-only-access",
            status=CheckStatus.FAIL,
            message=(
                f"warehouse role '{role}': could not verify SELECT access — no reachable "
                "warehouse client (check the warehouse-ro MCP server + grants per "
                "docs/minimal-permissions.md)"
            ),
        )
    try:
        can_select = client.can_select()
    except Exception as exc:  # noqa: BLE001 — never echo credentials
        return CheckResult(
            name="warehouse:read-only-access",
            status=CheckStatus.FAIL,
            message=f"warehouse role '{role}': access check failed ({type(exc).__name__})",
        )
    if not can_select:
        return CheckResult(
            name="warehouse:read-only-access",
            status=CheckStatus.FAIL,
            message=(
                f"warehouse role '{role}': missing SELECT grant — grant USAGE + SELECT to "
                f"'{role}' (docs/minimal-permissions.md)"
            ),
        )
    return CheckResult(
        name="warehouse:read-only-access",
        status=CheckStatus.PASS,
        message=f"warehouse role '{role}': SELECT access verified (read-only EDA path)",
    )


# --------------------------------------------------------------------------- #
# Aggregator
# --------------------------------------------------------------------------- #
def probe_repo(
    config: OswaldConfig,
    github_client: GitHubClient | None = None,
    warehouse_client: WarehouseClient | None = None,
) -> list[CheckResult]:
    """Aggregate PR-capability, branch-protection (WARN), and warehouse-access checks."""
    return [
        check_pr_capability(config, github_client),
        check_branch_protection(config, github_client),
        check_warehouse_access(config, warehouse_client),
    ]


__all__ = [
    "GitHubClient",
    "WarehouseClient",
    "check_pr_capability",
    "check_branch_protection",
    "check_warehouse_access",
    "probe_repo",
]
