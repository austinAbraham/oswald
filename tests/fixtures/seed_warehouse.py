"""Seed the duckdb fixture warehouse for INTAKE-05 EDA profiling tests.

Materializes ``tests/fixtures/warehouse.duckdb`` with a small synthetic
``orders`` / ``customers`` table pair. The data is inert and synthetic — no real
credentials, no PII (threat T-02-02: accept). The script is idempotent (it drops
and recreates the tables) so the committed ``.duckdb`` file can be regenerated:

    uv run python tests/fixtures/seed_warehouse.py

The grain of ``orders`` is one row per order; ``customers`` is one row per
customer. The EDA profiling test derives types / null profiles / distinct counts
/ grain uniqueness from these tables via read-only queries (the INTAKE-05
read-only EDA path), matching the DEMO-1 example ticket's two sources.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent / "warehouse.duckdb"

# (customer_id, customer_name, created_at)
CUSTOMERS = [
    (1, "Acme Corp", "2025-01-02"),
    (2, "Globex", "2025-01-05"),
    (3, "Initech", "2025-02-11"),
    (4, "Umbrella", "2025-03-01"),
    (5, "Soylent", "2025-03-14"),
]

# (order_id, customer_id, order_date, amount) — includes one NULL customer_id row
# and one NULL amount row so the null-profile assertions in the EDA test have teeth.
ORDERS = [
    (100, 1, "2025-04-01", 120.50),
    (101, 1, "2025-04-01", 19.99),
    (102, 2, "2025-04-01", 250.00),
    (103, 2, "2025-04-02", 75.25),
    (104, 3, "2025-04-02", 500.00),
    (105, 3, "2025-04-03", 42.00),
    (106, 4, "2025-04-03", 18.75),
    (107, 5, "2025-04-04", 999.99),
    (108, None, "2025-04-04", 10.00),  # NULL customer_id (orphan order)
    (109, 5, "2025-04-05", None),  # NULL amount
]


def seed(db_path: Path = DB_PATH) -> None:
    """Create the synthetic orders/customers tables in ``db_path``."""
    con = duckdb.connect(str(db_path))
    try:
        con.execute("DROP TABLE IF EXISTS orders")
        con.execute("DROP TABLE IF EXISTS customers")
        con.execute(
            "CREATE TABLE customers ("
            "  customer_id INTEGER, customer_name VARCHAR, created_at DATE"
            ")"
        )
        con.execute(
            "CREATE TABLE orders ("
            "  order_id INTEGER, customer_id INTEGER, order_date DATE, amount DOUBLE"
            ")"
        )
        con.executemany(
            "INSERT INTO customers VALUES (?, ?, ?)", CUSTOMERS
        )
        con.executemany(
            "INSERT INTO orders VALUES (?, ?, ?, ?)", ORDERS
        )
        con.commit()
    finally:
        con.close()


if __name__ == "__main__":
    seed()
    print(f"seeded {DB_PATH}")
