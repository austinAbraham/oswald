---
name: oswald-run
description: Drive one well-specified dbt ticket end-to-end — intake, read-only EDA, plan, model, sandbox build, PR — with human gates at each stage. Use when running an Oswald single-ticket assisted run in Claude Code.
disable-model-invocation: true
argument-hint: "[ticket-id]"
---

# Oswald single-ticket gated run (D-09 / D-10)

Drive ticket `$ARGUMENTS` through the five-stage pipeline. This skill is the thin
**orchestrator**: it sequences the stages and the human gates. It holds **no**
warehouse, build, or PR tools itself — the Rule-of-Two powers live in two **forked
subagents** with isolated contexts (see `SPIKE-tool-topology.md`):

- Stage 1 (read-only EDA, powers A+B) runs in the **`oswald-eda`** subagent.
- Stage 3 (model/build, powers B+C) runs in the **`oswald-model`** subagent.
- Stages 4–5 (build + PR) are **deterministic glue** — code, not agent tool-calls.

PAUSE for explicit human approval at every `GATE` before proceeding. The only thing
that crosses from the untrusted-input context into the write context is the
**human-approved plan** (the Stage-2 gate). Never carry raw ticket text into Stage 3.

## Stage 1 — INTAKE + EDA  (read-only role; `oswald-eda` subagent)

Invoke the **`oswald-eda`** subagent (`context: fork`) to read ticket `$ARGUMENTS`
via the ticketing MCP, validate the four hard fields are present (Intent, Grain,
Source(s), Acceptance criteria — see `pack/intake_spec.md`), and profile the
declared sources with **read-only** tools ONLY (`mcp__dbt-eda__show`,
`mcp__dbt-eda__compile`, `mcp__dbt-eda__list`). It follows `pack/prompts/eda.md`
and derives all six profiles (types, nulls, distinct counts, candidate join keys,
value distributions, actual uniqueness/grain). It returns an EDA-findings +
inferred-grain summary; the raw ticket/warehouse context stays inside the fork.

**GATE:** Present the EDA findings, the stated-and-confirmed grain, and any open
questions the EDA subagent could not confirm. Wait for human confirmation.

## Stage 2 — PLAN  (orchestrator context; no warehouse/build tools)

Produce a modeling plan from the confirmed intake + EDA findings. Write NO code,
touch NO warehouse. The plan is the trusted handoff into the write context.

**GATE:** Wait for explicit human plan approval. Only the approved plan crosses
into Stage 3.

## Stage 3 — MODEL  (build role; `oswald-model` subagent)

Invoke the **`oswald-model`** subagent (`context: fork`) with the **approved plan**
(not the raw ticket). It writes dbt models on the feature branch
`oswald/ticket-$ARGUMENTS` following `pack/CLAUDE.md` conventions and
`pack/prompts/modeling.md`, with MANDATORY `unique` + `not_null` tests on the
grain key, using `ref()`/`source()` only.

## Stage 4 — BUILD + VALIDATE  (deterministic glue — not agent tool-calls)

Deterministically run, against the **SANDBOX** target only: `dbt build` (the
`generate_schema_name` override confines it to `OSWALD_SANDBOX`), the dbt grain
tests, then `sqlfluff lint` with `pack/.sqlfluff`. On failure return to Stage 3
(bounded retries). Do not LLM-drive these steps — they are code.

## Stage 5 — PR  (deterministic glue — bot identity, PR-only)

Deterministically open a PR from branch `oswald/ticket-$ARGUMENTS` via the git
bot (idempotent: re-open is a no-op on an existing branch). Ping reviewers.

**GATE:** A human reviews and merges. Oswald never merges (branch protection).
