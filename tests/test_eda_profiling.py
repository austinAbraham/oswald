"""INTAKE-05 — EDA derives types/nulls/distinct/grain/distributions/uniqueness.

The EDA path is read-only (the fixture warehouse is opened read-only). This
module asserts the *mechanism* against the seeded duckdb fixture warehouse —
those read-only profiling queries are green from plan 01-02 — plus an xfail
check against the real EDA profiling routine (under ``tests.harness``, per D-10)
once it lands.
"""

from __future__ import annotations

import importlib

import pytest


def test_eda_derives_types_nulls_distinct_grain(fixture_warehouse):
    """Read-only profiling derives the required facts from the fixture warehouse.

    Mirrors RESEARCH §EDA profiling: row count, null profile, distinct counts,
    and grain uniqueness — all via read-only SELECTs (INTAKE-05).
    """
    con = fixture_warehouse

    # data types / columns
    cols = {row[1] for row in con.execute("PRAGMA table_info('orders')").fetchall()}
    assert {"order_id", "customer_id", "order_date", "amount"}.issubset(cols)

    # row count
    (n_orders,) = con.execute("SELECT count(*) FROM orders").fetchone()
    assert n_orders == 10

    # null profile — the fixture has one NULL customer_id and one NULL amount
    (null_customer,) = con.execute(
        "SELECT count(*) - count(customer_id) FROM orders"
    ).fetchone()
    assert null_customer == 1
    (null_amount,) = con.execute("SELECT count(*) - count(amount) FROM orders").fetchone()
    assert null_amount == 1

    # distinct counts (candidate join key profile)
    (distinct_customers,) = con.execute(
        "SELECT count(DISTINCT customer_id) FROM orders"
    ).fetchone()
    assert distinct_customers == 5

    # actual grain / uniqueness of customers.customer_id (count == count distinct)
    total, distinct = con.execute(
        "SELECT count(*), count(DISTINCT customer_id) FROM customers"
    ).fetchone()
    assert total == distinct  # customer_id is unique in customers


def test_read_only_path_cannot_write(fixture_warehouse):
    """The EDA connection is read-only — a write must be rejected (Rule of Two)."""
    con = fixture_warehouse
    with pytest.raises(Exception):
        con.execute("CREATE TABLE should_fail (x INTEGER)")


@pytest.mark.xfail(reason="awaiting real EDA profiling routine (INTAKE-05)", strict=False)
def test_real_eda_profiler_present():
    """The real EDA profiling routine lands under tests.harness (D-10)."""
    try:
        mod = importlib.import_module("tests.harness.eda")
    except ModuleNotFoundError:
        pytest.fail("tests.harness.eda not implemented yet (INTAKE-05)")
    assert hasattr(mod, "profile_source")
