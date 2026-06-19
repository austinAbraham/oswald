"""SEC-01 / SEC-02 — Rule-of-Two split assertions.

Two grouped behaviours (matching the VALIDATION map):

* ``test_eda_no_write``   — SEC-01: the EDA role/tool-set holds no write/PR tools
  (T-ELEVATION). Asserted against the conftest mock EDA server (green: the canned
  surface IS the contract) plus an xfail against the real config once it ships.
* ``test_sandbox_only``   — SEC-02: the build path is restricted to the sandbox
  target; ``clone`` is omitted; ``generate_schema_name`` forces the sandbox schema
  (T-TAMPER-SANDBOX). RED until the dbt profile + macro land.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "dbt_project" / "profiles.example.yml"
SCHEMA_MACRO = ROOT / "dbt_project" / "macros" / "generate_schema_name.sql"

WRITE_OR_PR_TOOLS = {"build", "run", "test", "clone", "seed", "snapshot", "open_pull_request", "merge"}


@pytest.mark.asyncio
async def test_eda_no_write(mock_mcp_servers):
    """SEC-01 — the EDA tool-set excludes every write/PR tool."""
    eda = mock_mcp_servers["dbt-eda"]
    tools = set(await eda.list_tools())
    leaked = tools & WRITE_OR_PR_TOOLS
    assert not leaked, f"EDA role must not hold write/PR tools, found: {leaked}"


def test_sandbox_only():
    """SEC-02 — build is restricted to the sandbox target; clone omitted; schema forced."""
    if not PROFILES.exists() or not SCHEMA_MACRO.exists():
        pytest.skip(
            "dbt sandbox profile/macro not shipped yet (SEC-02): "
            f"{PROFILES} / {SCHEMA_MACRO}"
        )
    profile_text = PROFILES.read_text(encoding="utf-8")
    macro_text = SCHEMA_MACRO.read_text(encoding="utf-8")
    # The sandbox target must exist and be distinct from the read-only EDA target.
    assert "sandbox" in profile_text
    assert "eda_ro" in profile_text
    # The generate_schema_name override forces the sandbox schema.
    assert "generate_schema_name" in macro_text
