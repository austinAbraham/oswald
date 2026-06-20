"""JIRA-01 — spec-field allowlist + Rule-of-Two separation for the write-back.

Mirrors ``tests/test_rule_of_two.py``'s leaked-set assertion + the deterministic
write-back glue from ``tests.harness.writeback``. Each behaviour maps to a
VALIDATION Per-Task row:

* ``test_writeback_strips_warehouse_data``                  — D-11: a
  warehouse-derived key (``row_count``) is REJECTED by the spec-field allowlist
  (this row is GREEN: the guard glue landed in Wave 0).
* ``test_writeback_calls_ticketing_write_only_after_approval`` — D-10: the
  deterministic glue calls the ticketing-write tool only after approval, and the
  recorded body carries no warehouse-derived key. Uses ``mock_ticketing_write``.
* ``test_eda_agent_never_holds_ticket_write``               — D-10 / Rule of Two:
  the ``oswald-eda`` SKILL.md ``allowed-tools`` grants no ticket-write tool.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.harness.writeback import (
    WritebackGuardError,
    guard_writeback,
    write_spec_back,
)

ROOT = Path(__file__).resolve().parents[1]
EDA_SKILL_MD = ROOT / ".claude" / "skills" / "oswald-eda" / "SKILL.md"

# Ticket-write tool fragments the EDA fork must never hold (D-10). Borrowed
# Atlassian write tools + the generic M1 ``add_comment`` placeholder.
_TICKET_WRITE_FRAGMENTS = (
    "editJiraIssue",
    "createJiraIssue",
    "transitionJiraIssue",
    "addCommentToJiraIssue",
    "add_comment",
)


def test_writeback_strips_warehouse_data():
    """D-11 — warehouse-derived fields are REJECTED (named) by the spec-field allowlist.

    A payload carrying valid spec fields alongside warehouse-derived data
    (``row_count`` + ``distinct_customers``) must RAISE, naming every leaked key —
    a fail-safe allowlist rejects, it never silently strips (so a new leak field can
    never slip through unnoticed).
    """
    with pytest.raises(WritebackGuardError) as exc:
        guard_writeback(
            {
                "intent": "daily customer revenue mart",
                "grain": ["customer_id", "date_day"],
                "sources": ["raw.orders", "raw.customers"],
                "acceptance_criteria": ["one row per customer per day"],
                "row_count": 1_200_000,
                "distinct_customers": 4213,
            }
        )
    message = str(exc.value)
    assert "row_count" in message, "the guard must NAME the rejected warehouse key"
    assert "distinct_customers" in message, "the guard must NAME every rejected key"
    # The spec fields are never named as leaked (they are the allowlist).
    assert "intent" not in message and "acceptance_criteria" not in message

    # A spec-only payload passes the guard unchanged.
    clean = guard_writeback(
        {
            "intent": "daily customer revenue mart",
            "grain": ["customer_id", "date_day"],
            "sources": ["raw.orders"],
            "acceptance_criteria": ["one row per customer per day"],
        }
    )
    assert set(clean) == {"intent", "grain", "sources", "acceptance_criteria"}


def test_writeback_rejects_warehouse_data_nested_in_spec_field_value():
    """WR-01 — warehouse data nested INSIDE an allowed spec field's value is rejected.

    The top-level keys are all valid spec fields, so the original top-level-only
    allowlist PASSED this payload (the Rule-of-Two hole). The recursive guard must
    now REJECT it, naming the nested warehouse-derived key — EDA profiling data
    must never reach the ticket at ANY depth (D-11).
    """
    with pytest.raises(WritebackGuardError) as exc:
        guard_writeback(
            {
                "intent": "mart",
                "grain": ["customer_id"],
                "sources": [
                    {"name": "raw.orders", "row_count": 1_200_000, "sample_values": ["a", "b"]}
                ],
                "acceptance_criteria": [{"distinct_customers": 4213}],
            }
        )
    message = str(exc.value)
    assert "row_count" in message or "sample_values" in message or "distinct" in message.lower(), (
        "the guard must NAME the nested warehouse-derived key it rejected (WR-01)"
    )


def test_writeback_rejects_deeply_nested_warehouse_key():
    """WR-01 — rejection holds at arbitrary depth, not just one level down."""
    with pytest.raises(WritebackGuardError):
        guard_writeback(
            {
                "intent": "mart",
                "grain": ["customer_id"],
                "sources": ["raw.orders"],
                # warehouse stat buried two list/dict levels inside acceptance_criteria
                "acceptance_criteria": [["ok", {"histogram": [1, 2, 3]}]],
            }
        )


def test_writeback_rejects_non_text_scalar_in_spec_field():
    """WR-01 — a bare numeric value in a spec field is profiling-shaped, rejected."""
    with pytest.raises(WritebackGuardError):
        # ``grain`` carrying a raw count integer rather than a column name.
        guard_writeback(
            {
                "intent": "mart",
                "grain": [4213],  # a number, not a grain column name
                "sources": ["raw.orders"],
                "acceptance_criteria": ["one row per customer"],
            }
        )


def test_writeback_allows_plain_str_and_list_of_str_spec_fields():
    """WR-01 — the recursive guard still PASSES legitimate str / list[str] spec values.

    The contract is preserved: only the structured/warehouse-derived shapes are
    rejected; the clarified-requirement text (str + list[str]) goes through.
    """
    clean = guard_writeback(
        {
            "intent": "daily customer revenue mart",
            "grain": ["customer_id", "date_day"],
            "sources": ["raw.orders", "raw.customers"],
            "acceptance_criteria": [
                "one row per customer per day",
                "revenue reconciles to finance ledger",
            ],
        }
    )
    assert clean["grain"] == ["customer_id", "date_day"]
    assert clean["sources"] == ["raw.orders", "raw.customers"]
    assert set(clean) == {"intent", "grain", "sources", "acceptance_criteria"}


def test_writeback_calls_ticketing_write_only_after_approval(mock_ticketing_write):
    """D-10 — the write-back posts only after approval; the body holds no warehouse data."""
    payload = {
        "intent": "daily customer revenue mart",
        "grain": ["customer_id", "date_day"],
        "sources": ["raw.orders", "raw.customers"],
        "acceptance_criteria": ["one row per customer per day"],
    }
    # Fails closed before approval — nothing is posted.
    with pytest.raises(WritebackGuardError):
        write_spec_back("DEMO-1", payload, approved=False, ticketing=mock_ticketing_write)
    assert mock_ticketing_write.calls == [], "no write may occur before approval (D-10)"

    # After approval the spec-only body is written.
    result = write_spec_back("DEMO-1", payload, approved=True, ticketing=mock_ticketing_write)
    assert result["ticket_id"] == "DEMO-1"
    assert len(mock_ticketing_write.calls) == 1
    body = mock_ticketing_write.calls[0]["body"]
    # No warehouse-derived key leaks into the recorded body (D-11).
    leaked = {k for k in body if k.startswith("distinct_") or k in {"row_count", "distributions", "sample_values"}}
    assert not leaked, f"warehouse-derived keys leaked into the write-back body: {leaked}"
    assert set(body) <= {"intent", "grain", "sources", "acceptance_criteria"}


def test_eda_agent_never_holds_ticket_write():
    """D-10 / Rule of Two — the EDA fork's allowed-tools grants no ticket-write tool."""
    if not EDA_SKILL_MD.exists():
        pytest.skip(f"oswald-eda SKILL.md not present: {EDA_SKILL_MD}")
    text = EDA_SKILL_MD.read_text(encoding="utf-8")
    # Isolate the allowed-tools block (between ``allowed-tools:`` and the next
    # top-level key) so a tool merely listed under disallowed-tools doesn't trip us.
    match = re.search(
        r"^allowed-tools:\n(.*?)^(?:\w[\w-]*:)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    allowed_block = match.group(1) if match else text
    leaked = [frag for frag in _TICKET_WRITE_FRAGMENTS if frag in allowed_block]
    assert not leaked, (
        f"EDA fork's allowed-tools must hold NO ticket-write tool (D-10), found: {leaked}"
    )
