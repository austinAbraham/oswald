"""Deterministic spec-level ticket write-back — M1 test harness only (JIRA-01).

M1 test harness only — the production orchestrator is the Claude Code skill
(D-10); the Python service arrives in M2. This module is the headless,
deterministic mirror of the Gate-1 write-back step: after a human approves the
refined spec the ``oswald-run`` orchestrator proposes, a **deterministic** step
(CODE, not an LLM tool-call — CLAUDE.md "don't LLM-ify deterministic steps")
writes the requirement back to the ticket. It lives under ``tests/harness/``
(not ``src/oswald/``) precisely because the production write-back path is
orchestrator glue, not application code, in M1.

Rule of Two (D-10): the EDA subagent holds read-untrusted-ticket + read-warehouse
and must NEVER also hold ticket-write — concentrating all three powers would break
the security model. So the EDA fork only *proposes* the refined spec text; this
deterministic glue performs the write through an injected ticketing-write tool the
EDA fork never imports or holds. The human approval is what turns proposed text
into trusted text — hence ``write_spec_back`` fails closed unless ``approved``.

Residency of the write-back (D-11): only the *requirement* crosses back to the
ticket system — Intent / Grain / Sources / Acceptance-criteria. ``guard_writeback``
is an explicit **fail-safe allowlist** (``SPEC_FIELDS``): a warehouse-derived key
(sample values, row counts, distinct-value lists, profiling distributions) is
REJECTED with a named error, never silently stripped — EDA *findings* inform the
agent's refinement, but only the spec goes back to the ticket.
"""

from __future__ import annotations

import re
from typing import Any

# The spec-field allowlist (D-11). Only these four fields — the clarified
# requirement — may be written back to the ticket system. Anything else
# (row_count / distinct_customers / distributions / sample_values …) is
# warehouse-derived data and is REJECTED, fail-safe. The frozenset + fail-loud
# shape mirrors ``toolsets.py`` ``_WRITE_FRAGMENTS`` and the named-domain-error
# convention of ``McpProbeError`` / ``InlineSecretError``.
SPEC_FIELDS: frozenset[str] = frozenset(
    {"intent", "grain", "sources", "acceptance_criteria"}
)

#: Warehouse-derived key patterns (regex, case-insensitive) that must NEVER reach
#: the ticket at ANY depth inside a spec-field value (WR-01 / D-11). EDA profiling
#: emits these — row counts, distinct-value counts/lists, sample values,
#: distributions, aggregate stats. They inform the agent's refinement but are not
#: the spec, so they are rejected wherever they appear (top level or nested).
_WAREHOUSE_KEY_PATTERNS: tuple[str, ...] = (
    r"row_?count",
    r"distinct(_.*)?",
    r"sample.*",
    r"distribution.*",
    r"null_?count",
    r"min",
    r"max",
    r"mean",
    r"median",
    r"mode",
    r"stddev",
    r"std_?dev",
    r"variance",
    r"percentile.*",
    r"histogram",
    r"cardinality",
    r"freq.*",
    r"count",
)
_WAREHOUSE_KEY_RE = re.compile(
    r"^(?:" + "|".join(_WAREHOUSE_KEY_PATTERNS) + r")$", re.IGNORECASE
)


class WritebackGuardError(ValueError):
    """A ticket write-back violated the spec-field allowlist or approval gate.

    Raised by :func:`guard_writeback` when a non-spec (warehouse-derived) key is
    present at any depth, and by :func:`write_spec_back` when the human-approval
    precondition is not met. A named domain error mirroring
    ``McpProbeError``/``InlineSecretError`` so callers can distinguish a
    residency/governance violation from a generic ``ValueError``.
    """


def _looks_warehouse_derived(key: str) -> bool:
    """True if ``key`` matches a known warehouse-derived profiling pattern."""
    return bool(_WAREHOUSE_KEY_RE.match(key))


def _reject_nested_warehouse_data(field: str, value: Any, path: str) -> None:
    """Recurse a spec-field value; RAISE on any warehouse-derived key or structured shape.

    A spec field's value may only be a ``str`` or a ``list`` of ``str`` (the
    clarified requirement is text). A nested ``dict`` (or a list containing dicts)
    can smuggle warehouse-derived data — sample values, row counts, distributions —
    inside an allowed field, bypassing the top-level allowlist (WR-01). So:

    * a ``dict`` anywhere inside a spec-field value is rejected outright, naming
      any warehouse-derived key it carries (clearer error) or the structured shape;
    * a ``list`` is recursed element-wise (lists of plain strings are fine);
    * a scalar must be a ``str`` (numbers/bools are profiling-shaped, not spec text).
    """
    if isinstance(value, str):
        return
    if isinstance(value, dict):
        warehouse_keys = sorted(k for k in value if _looks_warehouse_derived(str(k)))
        if warehouse_keys:
            raise WritebackGuardError(
                f"warehouse-derived key(s) {warehouse_keys} nested under spec field "
                f"{field!r} (at {path}) rejected from ticket write-back — EDA "
                "profiling data must never reach the ticket (D-11)"
            )
        raise WritebackGuardError(
            f"spec field {field!r} (at {path}) carries a nested/structured value; "
            "only str or list[str] is allowed — nested values may smuggle "
            "warehouse-derived data past the top-level allowlist (WR-01 / D-11)"
        )
    if isinstance(value, list):
        for i, item in enumerate(value):
            _reject_nested_warehouse_data(field, item, f"{path}[{i}]")
        return
    # A bare scalar that is not a str (int/float/bool/None) is profiling-shaped, not
    # spec text — reject it so a stray ``row_count: 1200000`` value cannot ride.
    raise WritebackGuardError(
        f"spec field {field!r} (at {path}) must be str or list[str]; got "
        f"{type(value).__name__} — non-text values may carry warehouse-derived "
        "data (WR-01 / D-11)"
    )


def guard_writeback(payload: dict[str, Any]) -> dict[str, Any]:
    """Allowlist guard (D-11): only spec fields may be written back; reject the rest.

    Two layers, both fail-safe:

    1. **Top-level allowlist** — any top-level key NOT in :data:`SPEC_FIELDS` (a
       warehouse-derived key like ``row_count``) RAISES, naming every leaked key,
       rather than being silently dropped, so a new leak field can never slip
       through unnoticed.
    2. **Recursive value guard (WR-01)** — each spec field's VALUE is walked: only
       ``str`` / ``list[str]`` is allowed; a nested ``dict``/list-of-dicts or a
       non-text scalar is REJECTED, naming any warehouse-derived key it carries.
       This closes the hole where warehouse data nested inside an allowed field's
       value (``sources: [{"name": ..., "row_count": ...}]``) reached the ticket.

    On success returns the cleaned spec-only payload.
    """
    leaked = set(payload) - SPEC_FIELDS
    if leaked:
        raise WritebackGuardError(
            f"non-spec fields rejected from ticket write-back: {sorted(leaked)}"
        )
    for field in SPEC_FIELDS & set(payload):
        _reject_nested_warehouse_data(field, payload[field], field)
    return {k: payload[k] for k in SPEC_FIELDS if k in payload}


def write_spec_back(
    ticket_id: str,
    payload: dict[str, Any],
    *,
    approved: bool,
    ticketing: Any,
) -> Any:
    """Write the approved, spec-only refined requirement back to the ticket.

    Deterministic orchestrator glue (D-10) — never an LLM tool-call. The shape
    mirrors ``stages.build``'s injectable-callable seam: ``ticketing`` is the
    write tool (in tests, the ``mock_ticketing_write`` fixture; in a wired
    environment, the resolved ticketing-write MCP tool) so a real call plugs in
    without changing this contract. The EDA fork never holds ``ticketing``.

    Fails closed: raises :class:`WritebackGuardError` unless ``approved is True`` —
    the human approval is what turns proposed text into trusted text (D-10). The
    guard runs BEFORE any ``ticketing.post`` call so an unapproved write never
    reaches the ticket system, and ``guard_writeback`` strips the payload to the
    spec-field allowlist (D-11) before it is sent.
    """
    if approved is not True:
        raise WritebackGuardError(
            f"refused to write back to ticket {ticket_id!r}: not human-approved "
            "(the human approval is what turns proposed text into trusted text, D-10)"
        )
    clean = guard_writeback(payload)
    return ticketing.post(ticket_id=ticket_id, body=clean)


__all__ = [
    "SPEC_FIELDS",
    "WritebackGuardError",
    "guard_writeback",
    "write_spec_back",
]
