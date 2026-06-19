<!--
  Oswald intake-spec — the versioned, in-repo "well-specified ticket" contract.

  This is the M1 ticket template (PACK-03, D-01/D-02/D-03). It is human-first and
  fill-in-the-blanks: write prose, do not conform to a schema. A ticket is *ready*
  when the agent can resolve everything else via warehouse EDA + safe stated
  assumptions, leaving only genuine business decisions to ask about.

  HARD GATE — exactly four required fields, no second-tier sections (D-03):
  Intent, Grain, Source(s), Acceptance criteria. The agent derives and
  pressure-tests output columns, transformation logic, and materialization via
  EDA — do NOT add those as template sections.

  Copy this file, replace the bracketed guidance under each heading, and keep all
  four headings. See tests/fixtures/DEMO-1.md for a fully filled-in example.
-->

# <ticket-id> — <one-line title>

## Intent

What business question does this model answer, and for whom? One or two
sentences. Describe the outcome, not the SQL.

> e.g. "Report each customer's total order revenue per day so analysts can chart
> daily revenue trends per customer without writing SQL by hand."

## Grain

What does exactly one row represent? Name the grain key(s) explicitly — this is
the uniqueness contract the model must hold.

> e.g. "One row per customer per calendar day (`customer_id` + `order_date`)."

## Source(s)

Which existing tables/sources feed this model? List each with the columns you
expect to use. The agent verifies these against the warehouse during EDA — a
stated source it cannot confirm becomes a question, not a guess.

> e.g.
> - `raw.orders` — one row per order (`order_id`, `customer_id`, `order_date`, `amount`)
> - `raw.customers` — one row per customer (`customer_id`, `customer_name`)

## Acceptance criteria

Testable-bullet convention (D-02): each criterion is its own discrete bullet,
phrased as a checkable assertion — a statement that is unambiguously true or
false against the built model. Free prose, no rigid tagging syntax.

**Forward-design contract — do not remove:** each bullet is designed to map to
exactly one M3 acceptance-criteria reconciliation check. One bullet → one check.
Bundling several assertions into one bullet breaks that mapping; split them.

Canonical examples of well-formed testable bullets:

- One row per customer per day (the declared grain is unique)
- Revenue within 1% of `stg_orders` (total reconciles to the source)
- No null `customer_id` (the grain key is never null)

Write your own below, one assertion per bullet:

- <assertion 1 — true/false against the built model>
- <assertion 2>
- <assertion 3>
