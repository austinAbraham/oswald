# AE-1234: Monthly customer retention mart

## Background

The Growth and Finance teams need a single, trusted view of customer retention
to track how well we keep customers month over month and to understand which
acquisition channels produce the stickiest customers. Today this is computed by
hand in a spreadsheet that nobody trusts and that breaks every quarter.

We want a dbt model (a mart) that produces monthly, customer-level retention so
that downstream dashboards and the Finance reconciliation can both read from one
governed source.

## Requirements

- Build a dbt mart for **monthly customer retention**.
- **Grain:** monthly, at the customer level (one row per customer per month).
- Track customer-level **retention** month over month.
- Break retention out by **acquisition channel**.
- **Exclude internal and test accounts** (employees, QA seed data, sandbox
  customers) so they do not inflate the numbers.

## Sources

- `raw.crm.customers` — the customer master (acquisition channel lives here).
- `raw.events.customer_activity` — per-customer activity events used to decide
  whether a customer is active in a given month.
- `raw.billing.subscriptions` — subscription/billing records used as a second
  signal of an active, paying customer.

## Acceptance criteria

- [ ] `customer_id` + `month` is unique (the declared grain holds with no
      duplicate rows).
- [ ] Monthly active/retained customer counts reconcile within **1%** of the
      existing Finance retention spreadsheet for the last 3 closed months.
- [ ] The model is **documented** (model + every column has a description).
- [ ] **Tests are added** (at minimum: unique + not_null on the grain key,
      and a relationship test from `customer_id` back to the customer master).
- [ ] Builds cleanly into the sandbox schema.

## Open questions

- How exactly do we define **retained** vs **reactivated**? Is a customer who
  was active in month 1, inactive in month 2, then active again in month 3
  "retained" in month 3, or "reactivated"?
- What is the activity signal of record — `customer_activity` events, an active
  `subscription`, or either one?
- Do we need to **backfill** history, and if so how far back? Or is this
  forward-only from the first full month after launch?
