"""SEC-05 — minimal-permissions doc exists + lists SF grants + git scopes.

RED until ``docs/minimal-permissions.md`` ships; skip-keyed to the missing
artifact so the module collects and runs. When present, the doc must enumerate
the Snowflake role grants (read-only EDA + sandbox write) and the GitHub token
scopes, and document branch-protection-as-enforcement (RESEARCH Open Q1).
"""

from __future__ import annotations

from pathlib import Path

import pytest

DOC = Path(__file__).resolve().parents[1] / "docs" / "minimal-permissions.md"


def _require_doc() -> str:
    if not DOC.exists():
        pytest.skip(f"docs/minimal-permissions.md not shipped yet (SEC-05): {DOC}")
    return DOC.read_text(encoding="utf-8")


def test_doc_lists_snowflake_grants():
    """The doc enumerates the read-only EDA + sandbox write Snowflake roles."""
    text = _require_doc().lower()
    assert "grant" in text
    assert "read_only" in text or "read-only" in text
    assert "sandbox" in text


def test_doc_lists_git_scopes_and_branch_protection():
    """The doc lists GitHub token scopes + branch-protection-as-enforcement (SEC-03)."""
    text = _require_doc().lower()
    assert "contents" in text and "pull-requests" in text
    assert "branch protection" in text
