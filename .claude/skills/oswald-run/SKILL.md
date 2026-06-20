---
name: run
description: Drive one well-specified dbt ticket end-to-end — intake, read-only EDA, plan, model, sandbox build, PR — with human gates at each stage. Use when running an Oswald single-ticket assisted run in Claude Code.
disable-model-invocation: true
argument-hint: "[ticket-id]"
---

# Oswald single-ticket gated run (D-09 / D-10)

> Invocation: this skill loads as `oswald:run` (plugin mode, frontmatter `name: run`)
> or as the directory-derived `oswald-run` (pack mode); the subagents it invoke load
> as `oswald:eda`/`oswald:model` (plugin) or `oswald-eda`/`oswald-model` (pack). The
> prose below uses the namespaced `eda`/`model` names that drive plugin-mode resolution.

Drive ticket `$ARGUMENTS` through the five-stage pipeline. This skill is the thin
**orchestrator**: it sequences the stages and the human gates. It holds **no**
warehouse, build, or PR tools itself — the Rule-of-Two powers live in two **forked
subagents** with isolated contexts (see `SPIKE-tool-topology.md`):

- Stage 1 (read-only EDA, powers A+B) runs in the **`eda`** subagent.
- Stage 3 (model/build, powers B+C) runs in the **`model`** subagent.
- Stages 4–5 (build + PR) are **deterministic glue** — code, not agent tool-calls.

There are **three explicit human gates** (D-09): **Gate 1** after Stage 1
(refine→approve, then the deterministic spec write-back), **Gate 2** after Stage 2
(plan→approve before any build), **Gate 3** after Stage 4 (build→approve before the
PR). The PR is **terminal** — the bot opens it but never merges; there is no fourth
gate. The Gate-1 ticket write-back is **deterministic glue**, NOT a fourth power on
any agent — the `eda` fork never holds a ticket-write tool (D-10).

PAUSE for explicit human approval at every `GATE` before proceeding. The only things
that cross from the untrusted-input context into a write context are (a) the
**human-approved plan** (Gate 2) into Stage 3 and (b) the **human-approved refined
spec** (Gate 1) into the deterministic write-back. Never carry raw ticket text into
Stage 3 or into the write-back.

## Stage 1 — INTAKE + EDA  (read-only role; `oswald-eda` subagent)

Invoke the **`eda`** subagent (`context: fork`) to read ticket `$ARGUMENTS`
via the ticketing MCP, validate the four hard fields are present (Intent, Grain,
Source(s), Acceptance criteria — see `pack/intake_spec.md`), and profile the
declared sources with **read-only** tools ONLY (`mcp__dbt-eda__show`,
`mcp__dbt-eda__compile`, `mcp__dbt-eda__list`). It follows `pack/prompts/eda.md`
and derives all six profiles (types, nulls, distinct counts, candidate join keys,
value distributions, actual uniqueness/grain). It returns an EDA-findings +
inferred-grain summary; the raw ticket/warehouse context stays inside the fork.

**GATE 1 (refine→approve):** Present the EDA findings, the stated-and-confirmed
grain, the **proposed refined spec** (Intent / Grain / Sources / Acceptance), and
any open questions the EDA subagent could not confirm. Wait for human confirmation.

On approval, a **DETERMINISTIC** step (CODE, not the `eda` subagent and not an LLM
tool-call — the same "deterministic glue — not agent tool-calls" discipline as
Stages 4–5) writes the refined spec back to the ticket — **Intent / Grain / Sources
/ Acceptance criteria ONLY**; NEVER warehouse samples, row counts, or distinct-value
lists (D-11). A spec-field allowlist guard REJECTS any warehouse-derived field by
name before the write. The write goes through the **ticketing-write tool**, which
the `eda` fork never holds (Rule of Two, D-10) — the write power lives only in this
deterministic glue, never in the read-untrusted-ticket + read-warehouse fork. The
human approval is what turns the proposed text into trusted text.

## Stage 2 — PLAN  (orchestrator context; no warehouse/build tools)

Produce a modeling plan from the confirmed intake + EDA findings. Write NO code,
touch NO warehouse. The plan is the trusted handoff into the write context.

**GATE 2 (plan→approve):** Wait for explicit human plan approval. Only the approved
plan crosses into Stage 3.

## Stage 3 — MODEL  (build role; `oswald-model` subagent)

Invoke the **`model`** subagent (`context: fork`) with the **approved plan**
(not the raw ticket). It writes dbt models on the feature branch
`oswald/ticket-$ARGUMENTS` following `pack/CLAUDE.md` conventions and
`pack/prompts/modeling.md`, with MANDATORY `unique` + `not_null` tests on the
grain key, using `ref()`/`source()` only.

## Stage 4 — BUILD + VALIDATE  (deterministic glue — not agent tool-calls)

Deterministically run, against the **SANDBOX** target only: `dbt build` (the
`generate_schema_name` override confines it to `OSWALD_SANDBOX`), the dbt grain
tests, then `sqlfluff lint` with `pack/.sqlfluff`. On failure return to Stage 3
(bounded retries). Do not LLM-drive these steps — they are code.

**GATE 3 (build→approve-before-PR):** Present the sandbox build + test results. Wait
for explicit human approval before opening the PR.

## Stage 5 — PR  (deterministic glue — bot identity, PR-only)

Deterministically open a PR from branch `oswald/ticket-$ARGUMENTS` via the git
bot (idempotent: re-open is a no-op on an existing branch). Ping reviewers.

**TERMINAL — a human reviews and merges. Oswald never merges (branch protection);
there is no fourth gate.** The PR is the end of the run.
