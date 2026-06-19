"""Shared fixtures for the Oswald test scaffold (plan 01-02).

This conftest provides the verification surface every later feature plan drives
its implementation against:

* ``ALLOWED`` — the egress allowlist (SEC-04 / D-11). The host set matches
  RESEARCH §Code Examples exactly: the configured model endpoint, warehouse,
  git, and ticketing hosts, plus loopback for local MCP stdio / test fixtures.
  The global ``--disable-socket`` default (plan 01-01) denies every socket; the
  egress test layers ``@pytest.mark.allow_hosts(ALLOWED)`` on top.
* ``scripted_harness`` — the headless harness fixture (D-11). It resolves the real
  ``run_one_ticket`` from ``tests.harness.harness`` (landed in the Walking-Skeleton
  plan). The lazy-import shim is retained so the module still collects cleanly if
  the harness is ever absent (it ``pytest.skip``s rather than erroring on import).
* ``mock_mcp_servers`` — in-memory MCP stub servers (raw ``mcp`` SDK style)
  returning canned ``list_tools()`` results for the EDA and build roles. No
  socket is ever opened (threat T-02-03: accept).
* ``mock_github_api`` — a monkeypatch-based fake GitHub API for the git-identity
  test (SEC-03): records PR-open calls and refuses merges, modelling the
  PR-only bot identity.
* ``fixture_warehouse`` — a read-only duckdb connection to the seeded
  ``tests/fixtures/warehouse.duckdb`` (INTAKE-05 EDA profiling).
* ``demo_ticket`` — the DEMO-1 example ready ticket text (D-02/D-03).

Per D-10 the M1 harness lives under ``tests/harness/`` — this conftest does NOT
import any harness/pipeline module under ``src/oswald`` (there is no such module
in M1; the M1 ``oswald`` CLI is ``init``/``validate`` only).
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any, Callable

import pytest

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
WAREHOUSE_DB = FIXTURES_DIR / "warehouse.duckdb"
DEMO_TICKET = FIXTURES_DIR / "DEMO-1.md"
PACK_DIR = Path(__file__).resolve().parents[1] / "pack"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- #
# SEC-04 / D-11 — egress allowlist
# --------------------------------------------------------------------------- #
# Mirrors RESEARCH §Code Examples exactly. Every host NOT in this list is denied
# by the global ``--disable-socket`` default; the egress test opts these in via
# ``@pytest.mark.allow_hosts(ALLOWED)``.
ALLOWED: list[str] = [
    "model.endpoint.internal",  # configured LiteLLM / model-gateway host
    "warehouse.internal",  # configured warehouse MCP / Snowflake host
    "api.github.com",  # configured git host
    "ticketing.internal",  # configured ticketing host
    "127.0.0.1",  # local MCP stdio / test fixtures
    "localhost",  # local MCP stdio / test fixtures
]


# --------------------------------------------------------------------------- #
# Mock MCP stub servers (in-memory; no sockets — threat T-02-03: accept)
# --------------------------------------------------------------------------- #
# Canned tool surfaces matching the Rule-of-Two split (RESEARCH Pattern 2):
# the EDA role exposes read-only verbs only; the build role exposes write verbs
# against the sandbox target. ``clone`` is intentionally absent from build
# (highest blast radius — omitted in M1).
EDA_TOOLS: list[str] = ["show", "compile", "list", "parse", "docs"]
BUILD_TOOLS: list[str] = ["build", "run", "test", "compile", "list"]


class StubMCPServer:
    """Minimal in-memory MCP server stub.

    Returns a canned ``list_tools()`` result. Opens no socket and contacts no
    real host — the ``--disable-socket`` default is the backstop that proves it.
    """

    def __init__(self, name: str, tools: list[str]) -> None:
        self.name = name
        self._tools = list(tools)
        self.connected = False

    def connect(self) -> None:
        self.connected = True

    async def list_tools(self) -> list[str]:
        if not self.connected:
            self.connect()
        return list(self._tools)

    def list_tools_sync(self) -> list[str]:
        if not self.connected:
            self.connect()
        return list(self._tools)


@pytest.fixture
def mock_mcp_servers() -> dict[str, StubMCPServer]:
    """Two canned dbt-mcp stub servers: read-only EDA and sandbox build roles."""
    return {
        "dbt-eda": StubMCPServer("dbt-eda", EDA_TOOLS),
        "dbt-build": StubMCPServer("dbt-build", BUILD_TOOLS),
    }


# --------------------------------------------------------------------------- #
# Mock GitHub API (SEC-03 — PR-only bot identity)
# --------------------------------------------------------------------------- #


class MockGitHubAPI:
    """Fake GitHub API modelling the PR-only bot identity.

    Records ``open_pull_request`` calls; ``merge_pull_request`` always raises,
    because the no-merge guarantee comes from branch protection — the bot is
    never a bypass actor (RESEARCH Pitfall 5 / SEC-03). The git-identity test
    asserts the bot can open a PR but cannot merge.
    """

    def __init__(self) -> None:
        self.opened_prs: list[dict[str, Any]] = []
        self.token_scopes: list[str] = ["contents:write", "pull-requests:write"]
        self.branch_protection_enabled = True

    def open_pull_request(self, *, head: str, base: str, title: str) -> dict[str, Any]:
        pr = {"number": len(self.opened_prs) + 1, "head": head, "base": base, "title": title}
        self.opened_prs.append(pr)
        return pr

    def merge_pull_request(self, number: int) -> None:  # noqa: ARG002
        raise PermissionError(
            "bot identity is PR-only; merge requires a human (branch protection)"
        )


@pytest.fixture
def mock_github_api(monkeypatch: pytest.MonkeyPatch) -> MockGitHubAPI:
    """A fake GitHub API for the git-identity test (no real host contacted)."""
    api = MockGitHubAPI()
    # No real module to patch yet (git glue lands in a later plan); the fixture
    # hands the fake to the test directly. Keep ``monkeypatch`` in the signature
    # so later plans can repoint a real client at this fake without a signature
    # change.
    _ = monkeypatch
    return api


# --------------------------------------------------------------------------- #
# Fixture warehouse (INTAKE-05 EDA profiling)
# --------------------------------------------------------------------------- #


@pytest.fixture
def fixture_warehouse():  # noqa: ANN201 — duckdb connection type is internal
    """Read-only duckdb connection to the seeded fixture warehouse.

    Models the read-only EDA path: the connection is opened read-only so the
    profiling test cannot write (Rule-of-Two read-only role analogue).
    """
    duckdb = pytest.importorskip("duckdb")
    if not WAREHOUSE_DB.exists():
        pytest.skip(
            f"fixture warehouse missing: {WAREHOUSE_DB} "
            "(run `uv run python tests/fixtures/seed_warehouse.py`)"
        )
    con = duckdb.connect(str(WAREHOUSE_DB), read_only=True)
    try:
        yield con
    finally:
        con.close()


# --------------------------------------------------------------------------- #
# DEMO-1 example ticket
# --------------------------------------------------------------------------- #


@pytest.fixture
def demo_ticket() -> str:
    """Raw text of the DEMO-1 example ready ticket (four hard fields, D-02/D-03)."""
    if not DEMO_TICKET.exists():
        pytest.skip(f"DEMO-1 ticket missing: {DEMO_TICKET}")
    return DEMO_TICKET.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# scripted_harness (D-11) — STUB until the Walking-Skeleton plan wires the run
# --------------------------------------------------------------------------- #


class ScriptedHarnessStub:
    """Adapter for the headless scripted harness (D-10/D-11).

    ``run_one_ticket`` resolves and calls the real entry point in
    ``tests.harness.harness`` (landed in the Walking-Skeleton plan). The lazy
    import is retained as a safety net: if that module is ever absent the call
    raises ``pytest.skip.Exception`` so the egress test (SEC-04) collects and runs
    without an ImportError instead of erroring at collection time.
    """

    def run_one_ticket(self, ticket_id: str, **kwargs: Any) -> Any:
        run_one_ticket = _load_real_harness_entrypoint()
        if run_one_ticket is None:
            pytest.skip(
                "scripted harness not implemented yet — "
                "tests.harness.harness.run_one_ticket lands in the "
                "Walking-Skeleton plan (D-11)"
            )
        return run_one_ticket(ticket_id, **kwargs)


def _load_real_harness_entrypoint() -> Callable[..., Any] | None:
    """Lazily resolve ``tests.harness.harness.run_one_ticket`` if it exists."""
    try:
        module = importlib.import_module("tests.harness.harness")
    except ModuleNotFoundError:
        return None
    return getattr(module, "run_one_ticket", None)


@pytest.fixture
def scripted_harness() -> ScriptedHarnessStub:
    """The headless harness fixture the egress test (SEC-04) rides.

    Returns the stub in this plan; the Walking-Skeleton plan replaces the
    underlying ``tests.harness.harness`` module with the real headless run, and
    this fixture then resolves to it automatically (no test change needed).
    """
    return ScriptedHarnessStub()
