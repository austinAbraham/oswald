# Oswald example dbt project (`dbt-duckdb`)

A small, **real** dbt project that builds locally with no cloud and no warehouse
account — it uses [`dbt-duckdb`](https://github.com/duckdb/dbt-duckdb) writing to
a single `.duckdb` file under `target/`. It implements the
`sample-retention-ticket` (AE-1234): a **monthly customer-retention mart** at the
grain `customer_id + month`, broken out by acquisition channel, excluding
internal/test accounts.

## Layout

```
dbt_project.yml                 project config (profile: oswald_example)
profiles.yml                    duckdb profile; default target "sandbox"
seeds/
  raw_crm_customers.csv         customer master (synthetic, no PII)
  raw_events_customer_activity.csv
  raw_billing_subscriptions.csv
models/
  staging/stg_*.sql             rename/cast passthroughs + internal/test flag
  marts/customer/fct_customer_retention.sql   the AE-1234 mart
macros/month_helpers.sql        dbt_utils-free 'YYYY-MM' month arithmetic
tests/assert_retention_grain_unique.sql   singular grain-uniqueness test
```

## Tests (acceptance criteria)

- `not_null` on every grain/foreign key.
- `accepted_values` on `retention_status` (`new`/`retained`/`reactivated`/`churned`).
- `relationships` from `fct_customer_retention.customer_id` → `stg_crm_customers`.
- Singular `assert_retention_grain_unique` — proves `customer_id + month` is
  unique (the declared grain), with **no `dbt_utils` dependency** (so `dbt deps`
  is not required).

## Run it

No global dbt install needed — run it through `uv` (matches Oswald's pinned
Python `>=3.12,<3.14`):

```bash
cd examples/dbt-project
DO_NOT_TRACK=1 uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt seed  --profiles-dir . --project-dir .
DO_NOT_TRACK=1 uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt build --profiles-dir . --project-dir .
DO_NOT_TRACK=1 uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt test  --profiles-dir . --project-dir .
```

Or via Oswald's runner (`src/tools/dbt`), which applies the policy guards
(offline skip, never-write-to-non-sandbox) and parses `run_results.json` into a
typed result:

```ts
import { runDbt } from "@oswald-ai/oswald-core";

await runDbt("build", {
  projectDir: "examples/dbt-project",
  target: "sandbox",
  dbtCommand: "uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt",
});
```

All `target/` output (including the `.duckdb` file) is git-ignored.
