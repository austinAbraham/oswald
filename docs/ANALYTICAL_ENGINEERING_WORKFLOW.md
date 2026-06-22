# The analytical-engineering workflow

This is the day-to-day flow Oswald is built around: taking a business request
and turning it into a validated, reviewable dbt change — without losing the
thread between "what the business asked" and "what the model actually does."

It follows the bundled example, **AE-1234: Monthly customer retention mart**
(`examples/tickets/sample-retention-ticket.md`), through every phase. Each phase
is one CLI command, owns one workflow state, and writes durable artifacts under
`.oswald/`. You can stop after any phase, walk away, come back (or hand off to a
teammate or a fresh agent), and resume from the artifacts — that is the whole
point.

`oswald next` always tells you the recommended next command from the current
state, so you never have to memorize the order.

---

## The evidence-tagging discipline

The single most important habit in this workflow: **never let an unsourced claim
masquerade as a fact.** Every business rule, metric, grain, filter, or join an
agent records is tagged with how it was established, and where it came from.
Oswald enforces this with a four-value vocabulary (see `tentacles/base.ts`):

| Tag | Meaning | Example |
|-----|---------|---------|
| `confirmed` | Explicitly stated in a sourced artifact or the ticket. | "Grain is one row per customer per month" — stated verbatim in AE-1234. |
| `inferred` | Deterministically derived from sourced evidence. | "Candidate key is `(customer_id, month)`" — inferred from the declared grain. |
| `assumption` | A default the tooling chose; **needs human confirmation** before build. | "Active = at least one activity event in the month" — a reasonable default, but not stated. |
| `open_question` | Unknown; a human must answer before proceeding. | "Is a customer who lapses then returns *retained* or *reactivated*?" |

Every tentacle renders an **Evidence Ledger** table into its artifacts. When you
read `intake.md` or `metric_spec.yml`, you can see at a glance which definitions
are solid and which are guesses waiting on a stakeholder. The validation phase
will not declare "done" while load-bearing items are still `open_question` or an
acceptance criterion is unverified.

> Rule of thumb: if you can't point at a source, it's an `assumption` or an
> `open_question` — never a silent fact.

---

## Phase by phase

Set up once (in a scratch dir):

```bash
oswald init --runtime generic --yes
oswald intake --from-file ./ticket.md      # ./ticket.md = the AE-1234 sample
```

Then drive each phase with the ticket id (`AE-1234` for the sample):

### 1. Intake — `oswald intake`

Parses the raw ticket into a structured brief. It extracts requirements,
acceptance criteria, source systems, target models, stakeholders, due dates, and
dependencies; flags metric/grain ambiguity as open questions; computes a
completeness score; and wraps the entire ticket body as untrusted, injection-
scanned evidence.

For AE-1234 you get ~85% completeness and open questions like *"Term 'active' is
used but not defined"* and *"Term 'retention' is used but not defined."* That is
the system doing its job: the ticket *uses* those words but never *defines* them,
so they surface as gaps instead of being quietly assumed.

→ Writes `intake.md`, `requirements.md`, `acceptance_criteria.md`. Advances to
the `clarification` phase.

### 2. Clarification & scoping — `oswald clarify AE-1234 --draft-comment`

Triages the open questions into **blocking** vs **non-blocking**, groups them by
stakeholder, surfaces scope risks with severities, proposes explicit
assumptions, and — for AE-1234 — recommends **splitting** the ticket (it is large
for one deliverable). It drafts a clarification comment you could send to the
requester.

`--draft-comment` keeps it draft-only. To actually post (with a real ticket
provider): `oswald clarify AE-1234 --post-comment --yes` — and even then, posting
must be permitted by policy. Default-deny means nothing leaves your machine by
accident.

→ Writes `open_questions.md`, `scope_risks.md`, `clarification_comment.md`.
Records blocking questions as state blockers. Advances to `context`.

### 3. Context gathering — `oswald context AE-1234 --local-only`

Local-first scan of the repo for existing dbt models, SQL, YAML, and docs, so you
don't rebuild what already exists. It extracts source/table references and ranks
similar prior work. For a greenfield demo dir it honestly reports *"No existing
dbt models found — confirm this is greenfield."* `--local-only` pulls no remote
context; drop it (and add `--include-prs/--include-docs/--include-tickets`) when
providers are wired.

→ Writes `context_pack.md`, `existing_assets.md`, `lineage_notes.md`,
`source_inventory.md`. Advances to `eda`.

### 4. Warehouse discovery & EDA — `oswald eda AE-1234 --warehouse mock --dry-run`

Generates **read-only** SQL to discover schemas/tables, profile row counts and
null rates, infer candidate grain, probe join paths, and identify PII columns by
name. Every generated query is re-validated through the SQL safety gate and
LIMIT-capped. PII-by-name columns are profiled only by aggregate and never
sampled raw.

`--dry-run` (the default) writes the SQL files + an inspection plan without
touching a warehouse. `--execute` runs them against the configured warehouse
provider (the offline demo uses a small built-in mock fixture). Grain is only
ever marked `confirmed` when an executed profile shows distinct-keys = total-rows;
in dry-run it stays an unverified inference — honest by construction.

→ Writes `eda_report.md`, `grain_analysis.md`, `join_analysis.md`,
`data_quality_findings.md`, and `sql_queries/*.sql`. Advances to `design`.

### 5. Metric & semantic design — `oswald design AE-1234`

Converts the business language into precise definitions: metric formula, grain,
dimensions, filters/exclusions, null behavior, and a reconciliation approach. It
**never invents business logic** — the undefined terms from intake (`active`,
`retention`) come back as explicit open questions demanding a formula, grain, and
qualifying filter. This is the phase where `assumption`s get promoted to
`confirmed` *by a human*, not by the tool.

→ Writes `metric_spec.yml`, `semantic_model_plan.md`, `dimension_contracts.yml`.
Advances to `planning`.

### 6. Model planning — `oswald plan AE-1234`

Plans a layered set of staging / intermediate / mart dbt models + tests,
identifies the modeling pattern, keeps the change set small, and emits a
`changed_files` manifest of **intended** changes. It does **not** modify project
files. (If you skipped `design`/`eda`, it warns that it is planning from
intake/requirements alone and is lower-fidelity.)

→ Writes `model_plan.md`, `implementation_plan.md`, `changed_files.md`. Advances
to `building`.

### 7. Build — `oswald build AE-1234 --dry-run`

Bridges the plan to real files. `--dry-run` (default) writes a change *preview* +
a `changed_files.json` manifest and touches nothing. `--apply --yes` (with a
permitting policy) generates conservative, clearly-marked dbt scaffolds under
`models/` — `TODO(human)` stubs, never production logic — and it **never
overwrites or deletes** an existing file.

→ Writes `build_preview.md`, `changed_files.json` (+ scaffolds under `--apply`).
Advances to `validating`.

### 8. Validation & quality — `oswald validate AE-1234 --skip-external`

Classifies each acceptance criterion into a deterministic check (grain /
uniqueness / non-null / accepted-values / freshness / row-count / build),
reconciles a candidate row count against a legacy report when both exist, and
produces a fix plan on any failure. **It refuses to declare "done" while blocking
failures remain** and parks the workflow in `blocked` (exit code 2) instead of
faking a pass.

`--skip-external` (the effective default) stays fully local — the library never
spawns a process. For the AE-1234 demo this means the *"builds cleanly into the
sandbox schema"* criterion is recorded as **not verified** and the workflow
blocks. That is the honest outcome offline; with a wired command runner you would
pass `--dbt` (or `--command '...'`) to actually run the build/tests.

→ Writes `validation_report.md`, `test_results.md`, `reconciliation_report.md`,
`known_limitations.md`.

### 9. Delivery — `oswald pr AE-1234 --draft` and `oswald update-ticket AE-1234 --draft`

The delivery tentacle packages the change for human review: a PR summary with
validation evidence, assumptions, and known limitations (`pr_summary.md`), a
drafted ticket update (`jira_update.md`), release/handoff notes, and an appended
`decision_log.md`. Everything is **draft-by-default**. Opening the PR
(`pr ... --open --yes`) or posting the update (`update-ticket ... --post --yes`)
is approval-gated; absent consent + policy, it only drafts and records the gated
actions as "not taken."

(In the offline demo these also stay `blocked` because validation did not pass —
delivery honestly refuses to present unvalidated work as shippable.)

### 10. Ship — `oswald ship AE-1234`

The finalize gate. It verifies the workflow is not blocked, that a validation
report exists without blocking failures, and that a PR summary is present; then it
archives the noisy intermediate artifacts (preserving the decision log + evidence
+ acceptance criteria), writes `ship_record.md`, and marks the state `shipped`.
It **refuses to bypass blocking validation failures** unless a
`known_limitations.md` explicitly documents the exception — in which case it
proceeds with a warning and records the documented exception.

---

## Keeping context healthy — `oswald compact`

At any point, run `oswald compact` to summarize the current artifact set into a
single `current_context.md` ("read this first") and archive the intermediates it
just summarized into `.oswald/archive/`. It **preserves** the decision log,
evidence/source artifacts, acceptance criteria, and the ship record. This is how
you keep a long-running ticket from drowning a fresh agent (or yourself) in stale
intermediate files while losing nothing load-bearing.

---

## Why this shape matters for an analytical engineer

- **The gap between "asked" and "built" is always visible.** Undefined terms
  (`active`, `retention`) travel as `open_question`s from intake all the way to
  design, where a human resolves them — they are never silently assumed into SQL.
- **Nothing destructive happens by accident.** Reads are gated to read-only SQL;
  writes (post comment, open PR, scaffold files, run build) are default-deny and
  need explicit consent + a permitting policy.
- **"Done" means verified, not asserted.** Validation blocks rather than fakes a
  pass; ship refuses to bypass blockers without a documented exception.
- **The work is resumable and auditable.** The artifact dir + `state.yml` +
  `decision_log.md` are a durable record you can hand to a reviewer, a teammate,
  or a fresh agent session at any phase.
