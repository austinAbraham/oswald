# dbt House Style — Oswald conventions (override me)

> **These are opinionated, working defaults — not law.** They produce a sane,
> consistent dbt project on the first run (conventions ARE the product
> differentiator, D-04). Every default here is **override me**: copy this file
> into your dbt repo and change anything that conflicts with your team's
> established style. What you should NOT drop is the deterministic backstop — the
> shipped `pack/.sqlfluff` config (D-05) catches naming/casing/layout violations
> mechanically, so style is enforced by `sqlfluff lint` during build + validate,
> not left to model discretion.

## Layering — staging → intermediate → marts

Every model lives in exactly one layer. Data flows one direction only; never
skip downward or reach back upward.

- **staging** (`models/staging/`) — one model per source table. Light, 1:1 with
  the raw source: rename to snake_case, cast types, basic cleaning. No joins, no
  business logic, no aggregation. A staging model is the *only* place that reads
  a `source()`.
- **intermediate** (`models/intermediate/`) — reusable building blocks: joins,
  fan-out/fan-in, de-duplication, the gnarly logic that more than one mart needs.
  Reads from staging (and other intermediate) models via `ref()` only.
- **marts** (`models/marts/`) — the consumable, business-facing models analysts
  and BI tools query. Reads from staging/intermediate via `ref()`.

> Override me: add a `models/utilities/` layer, split marts by domain, etc.

## Naming

Prefix every model with its layer/shape, snake_case throughout:

| Prefix  | Layer / shape                  | Example                     |
| ------- | ------------------------------ | --------------------------- |
| `stg_`  | staging (per source)           | `stg_orders`                |
| `int_`  | intermediate (building block)  | `int_orders_joined_customers` |
| `fct_`  | marts — fact (events/measures) | `fct_daily_customer_revenue` |
| `dim_`  | marts — dimension (entities)   | `dim_customers`             |

- All identifiers (models, columns, CTEs) are `snake_case`.
- Boolean columns read as assertions: `is_active`, `has_orders`.
- Keep names descriptive over short; the model name should tell you the grain.

> Override me: `f_`/`d_` prefixes, `mart_` prefix, plural vs singular, etc.

## Keys — surrogate keys, `ref()` / `source()` only

- **Generate a surrogate key** for every model whose natural grain is composite,
  using a deterministic hash of the grain columns (e.g. `dbt_utils.generate_surrogate_key`).
  Put it first, named `<entity>_sk` or `<model>_id`.
- **Never hard-code a schema or database reference.** Read raw data only through
  `source()` (in staging) and read other models only through `ref()`. Hard-coded
  `analytics.public.orders`-style refs break lineage and the sandbox isolation
  (SEC-02) — they are forbidden.

> Override me: a different hashing macro, integer surrogate keys, etc. — but keep
> the `ref()`/`source()`-only rule; it is load-bearing for sandbox safety.

## Tests — MANDATORY `unique` + `not_null` on the grain key

**This is the non-negotiable contract, not an override-me default.** Every model
MUST declare its grain key in `schema.yml` and put **both** a `unique` test and a
`not_null` test on it (a composite grain → both tests on the surrogate key built
from those columns).

```yaml
# models/marts/_marts.yml
models:
  - name: fct_daily_customer_revenue
    columns:
      - name: daily_customer_revenue_sk   # surrogate of (customer_id, order_date)
        tests:
          - unique
          - not_null
```

Why mandatory: the declared grain is the model's core promise, and these two
tests are exactly what the M3 acceptance-criteria reconciliation relies on to
verify "one row per <grain>" deterministically. Drop them and the grain claim is
unverifiable. Add more tests freely (relationships, accepted_values, range
checks) — but `unique` + `not_null` on the grain key always ship.

## SQL / CTE style

- **CTEs, not nested subqueries.** Lead with import CTEs (one per `ref()`/
  `source()`), then logical/transform CTEs, then a final `select` from the last
  CTE. The final `select` does no heavy logic — it just picks columns.
- Name CTEs for what they hold (`orders`, `customers`, `joined`, `aggregated`),
  not `cte1`/`tmp`.
- One leading import CTE per source/ref keeps lineage readable.
- Lowercase keywords and functions; explicit `as` on every alias; explicit
  column lists (no `select *` in models). The shipped `pack/.sqlfluff` enforces
  all of this — run `sqlfluff lint` and it will tell you exactly what drifted.
- Snowflake dialect is the default target (D-06); set `dialect` in `.sqlfluff`
  for another warehouse.

```sql
-- models/marts/fct_daily_customer_revenue.sql
with orders as (
    select * from {{ ref('stg_orders') }}
),

aggregated as (
    select
        customer_id,
        order_date,
        sum(amount) as daily_revenue
    from orders
    group by customer_id, order_date
)

select
    {{ dbt_utils.generate_surrogate_key(['customer_id', 'order_date']) }} as daily_customer_revenue_sk,
    customer_id,
    order_date,
    daily_revenue
from aggregated
```

> Override me: comma placement, indentation width, blank-line rules — change them
> in `pack/.sqlfluff` so the linter and the prose stay in agreement.
