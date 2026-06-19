"""Read-only EDA profiling — M1 test harness only (INTAKE-05).

M1 test harness only — the production orchestrator is the Claude Code skill
(D-10); the Python service arrives in M2. This module is the headless,
deterministic mirror of what the ``oswald-eda`` subagent does at runtime via
``mcp__dbt-eda__show``: it derives the six required source profiles
(INTAKE-05) over a source table using **read-only** ``SELECT``s only — no DDL,
no DML. It lives under ``tests/harness/`` (not ``src/oswald/``) precisely
because the production EDA path is the skill, not Python code.

The connection passed to :func:`profile_source` is expected to be a read-only
warehouse handle (in M1 tests: a ``read_only=True`` duckdb connection to the
seeded fixture warehouse) — the Rule-of-Two read-only role analogue. Every query
issued here is a pure ``SELECT``; a write would (and must) be rejected by the
read-only connection.

The six derivations (RESEARCH §EDA profiling via read-only ``show``):

1. ``data_types``        — column name → declared type
2. ``null_profile``      — column name → (null_count, null_rate)
3. ``distinct_counts``   — column name → distinct value count
4. ``candidate_join_keys`` — high-distinct + low-null columns (join-key candidates)
5. ``distributions``     — column name → top-N (value, count) for low-cardinality columns
6. ``uniqueness``        — grain key → whether ``count(*) == count(distinct key)``

:func:`profile_source` also *states* the inferred grain and whether the
uniqueness check confirms it, and flags any requested grain key that is not a
real column as a human question rather than guessing (Pitfall 4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# A column is a join-key candidate when its distinct count is at least this
# fraction of the (non-null) row count and its null rate is at or below the cap.
_JOIN_KEY_DISTINCT_RATIO = 0.9
_JOIN_KEY_MAX_NULL_RATE = 0.1

# Only profile value distributions for "low-cardinality" columns (a high-cardinality
# distribution is just the column back). Top-N rows per distribution.
_LOW_CARDINALITY_MAX_DISTINCT = 20
_DISTRIBUTION_TOP_N = 10


class _Connection(Protocol):
    """The minimal read-only query surface :func:`profile_source` needs.

    Satisfied by a duckdb connection (and by any DB-API-ish handle exposing
    ``execute(sql).fetchall()`` / ``fetchone()``). The handle MUST be read-only;
    this module never issues a write.
    """

    def execute(self, sql: str) -> Any: ...  # noqa: D401,E704


@dataclass(frozen=True)
class SourceProfile:
    """Structured result of profiling one source table — all six INTAKE-05 facts.

    Attributes:
        source: The profiled source table name.
        row_count: ``count(*)`` of the source.
        data_types: column → declared type (derivation 1).
        null_profile: column → ``(null_count, null_rate)`` (derivation 2).
        distinct_counts: column → distinct value count (derivation 3).
        candidate_join_keys: high-distinct, low-null columns (derivation 4).
        distributions: column → top-N ``(value, count)`` rows (derivation 5).
        uniqueness: grain key → True iff ``count(*) == count(distinct key)`` (derivation 6).
        stated_grain: the grain key(s) inferred/requested for this source.
        grain_confirmed: True iff every stated grain key is unique (the grain holds).
        open_questions: unconfirmable facts surfaced as human questions (Pitfall 4).
    """

    source: str
    row_count: int
    data_types: dict[str, str]
    null_profile: dict[str, tuple[int, float]]
    distinct_counts: dict[str, int]
    candidate_join_keys: list[str]
    distributions: dict[str, list[tuple[Any, int]]]
    uniqueness: dict[str, bool]
    stated_grain: list[str]
    grain_confirmed: bool
    open_questions: list[str] = field(default_factory=list)

    def keys(self) -> list[str]:  # convenience for the "contains all six keys" check
        return [
            "data_types",
            "null_profile",
            "distinct_counts",
            "candidate_join_keys",
            "distributions",
            "uniqueness",
        ]


def _columns(connection: _Connection, source: str) -> dict[str, str]:
    """Derivation 1 — column name → declared type, read-only.

    Uses ``SELECT * FROM <src> LIMIT 0`` and reads the cursor description, which
    is read-only and warehouse-portable (no information_schema dialect assumptions).
    """
    cur = connection.execute(f"SELECT * FROM {source} LIMIT 0")
    description = getattr(cur, "description", None) or []
    types: dict[str, str] = {}
    for col in description:
        name = col[0]
        type_name = col[1]
        types[name] = str(type_name) if type_name is not None else "UNKNOWN"
    return types


def profile_source(
    connection: _Connection,
    source: str,
    *,
    grain_keys: list[str] | None = None,
) -> SourceProfile:
    """Derive all six INTAKE-05 profiles for ``source`` over a read-only connection.

    Args:
        connection: a **read-only** warehouse handle (duckdb ``read_only=True`` in
            M1 tests). Every query issued is a pure ``SELECT``.
        source: the source table to profile (e.g. ``"orders"``).
        grain_keys: the ticket-declared grain key column(s) to confirm. When
            omitted, the single best join-key candidate (if any) is taken as the
            inferred grain so uniqueness still gets stated + confirmed (Pitfall 4).

    Returns:
        A :class:`SourceProfile` carrying all six derivations, the stated grain and
        whether uniqueness confirms it, and an ``open_questions`` list of any
        requested grain key that is not a real column (a human question, not a guess).
    """
    columns = _columns(connection, source)
    col_names = list(columns)

    (row_count,) = connection.execute(f"SELECT count(*) FROM {source}").fetchone()
    row_count = int(row_count)

    # Derivation 2 — null profile per column (count(*) - count(col)).
    null_profile: dict[str, tuple[int, float]] = {}
    for col in col_names:
        (nulls,) = connection.execute(
            f"SELECT count(*) - count({col}) FROM {source}"
        ).fetchone()
        nulls = int(nulls)
        null_rate = (nulls / row_count) if row_count else 0.0
        null_profile[col] = (nulls, null_rate)

    # Derivation 3 — distinct counts per column.
    distinct_counts: dict[str, int] = {}
    for col in col_names:
        (distinct,) = connection.execute(
            f"SELECT count(DISTINCT {col}) FROM {source}"
        ).fetchone()
        distinct_counts[col] = int(distinct)

    # Derivation 4 — candidate join keys: high-distinct AND low-null.
    candidate_join_keys: list[str] = []
    for col in col_names:
        nulls, null_rate = null_profile[col]
        non_null_rows = row_count - nulls
        distinct = distinct_counts[col]
        if non_null_rows <= 0:
            continue
        distinct_ratio = distinct / non_null_rows
        if distinct_ratio >= _JOIN_KEY_DISTINCT_RATIO and null_rate <= _JOIN_KEY_MAX_NULL_RATE:
            candidate_join_keys.append(col)

    # Derivation 5 — value distributions for low-cardinality columns (top-N).
    distributions: dict[str, list[tuple[Any, int]]] = {}
    for col in col_names:
        if 0 < distinct_counts[col] <= _LOW_CARDINALITY_MAX_DISTINCT:
            rows = connection.execute(
                f"SELECT {col}, count(*) FROM {source} "
                f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {_DISTRIBUTION_TOP_N}"
            ).fetchall()
            distributions[col] = [(r[0], int(r[1])) for r in rows]

    # Resolve the grain to state + confirm (Pitfall 4 — state, confirm, or ask).
    open_questions: list[str] = []
    if grain_keys:
        stated_grain = [k for k in grain_keys if k in columns]
        for k in grain_keys:
            if k not in columns:
                open_questions.append(
                    f"declared grain key {k!r} is not a column of {source!r} — "
                    "cannot confirm; needs a human decision (not guessed)"
                )
    elif candidate_join_keys:
        # No declared grain: infer the strongest single candidate so uniqueness is
        # still stated + confirmed rather than silently skipped.
        stated_grain = [candidate_join_keys[0]]
    else:
        stated_grain = []
        open_questions.append(
            f"no grain key declared and no join-key candidate found in {source!r} — "
            "the grain cannot be inferred; needs a human decision"
        )

    # Derivation 6 — actual uniqueness/grain: count(*) == count(distinct key).
    uniqueness: dict[str, bool] = {}
    for key in stated_grain:
        total, distinct = connection.execute(
            f"SELECT count(*), count(DISTINCT {key}) FROM {source}"
        ).fetchone()
        uniqueness[key] = int(total) == int(distinct)

    grain_confirmed = bool(stated_grain) and all(uniqueness.get(k, False) for k in stated_grain)

    return SourceProfile(
        source=source,
        row_count=row_count,
        data_types=columns,
        null_profile=null_profile,
        distinct_counts=distinct_counts,
        candidate_join_keys=candidate_join_keys,
        distributions=distributions,
        uniqueness=uniqueness,
        stated_grain=stated_grain,
        grain_confirmed=grain_confirmed,
        open_questions=open_questions,
    )


__all__ = ["profile_source", "SourceProfile"]
