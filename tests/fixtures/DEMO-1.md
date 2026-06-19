# DEMO-1 — Daily customer revenue mart

> Example *ready* ticket used by the test scaffold. Follows the M1 intake-spec
> contract: the four hard fields only (D-03) and a testable-bullet Acceptance
> Criteria section (D-02). No second-tier sections — the agent derives output
> columns, transformation logic, and materialization via EDA.

## Intent

Build a marts model that reports each customer's total order revenue per day so
analysts can chart daily revenue trends per customer without writing SQL by hand.

## Grain

One row per customer per calendar day (`customer_id` + `order_date`).

## Source(s)

- `raw.orders` — one row per order (`order_id`, `customer_id`, `order_date`, `amount`)
- `raw.customers` — one row per customer (`customer_id`, `customer_name`, `created_at`)

## Acceptance criteria

- One row per `customer_id` per `order_date` (the declared grain is unique)
- No null `customer_id` and no null `order_date` in the output
- `daily_revenue` equals the sum of `raw.orders.amount` for that customer and day
- Total revenue across all rows is within 1% of `SELECT sum(amount) FROM raw.orders`
- Every `customer_id` in the output exists in `raw.customers`
