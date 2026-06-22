# Oswald the Analytical Octopus

[![npm version](https://img.shields.io/npm/v/@oswald-ai/oswald-core)](https://www.npmjs.com/package/@oswald-ai/oswald-core)
[![CI](https://github.com/austinAbraham/oswald/actions/workflows/ci.yml/badge.svg)](https://github.com/austinAbraham/oswald/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

> A runtime-agnostic, MCP-native, context-rot-resistant workflow layer for
> analytical-engineering AI agents.

Oswald turns a business request — *"we need a monthly customer-retention mart"* —
into a disciplined, auditable pipeline: **intake → clarification → context → EDA →
design → planning → build → validation → PR → ticket update → ship**. Every step
writes durable artifacts to disk, the LLM stays a thin orchestrator, and **no side
effect happens without explicit human approval**.

It does **not** call a model itself. Each step (a *tentacle*) does deterministic
work — parsing tickets, generating read-only SQL, classifying acceptance criteria,
scaffolding dbt files — and emits structured Markdown/YAML evidence plus the
next-step prompt. The agent runtime you already use (Claude Code, Codex, Gemini
CLI, or a plain shell) supplies the reasoning; Oswald supplies the workflow, the
conventions, the safety gates, and the memory.

## Install

Requires **Node.js >= 22**.

```bash
npm i -g @oswald-ai/oswald-core   # global CLI → oswald --help
npx @oswald-ai/oswald-core --help # one-off, no install
npm i @oswald-ai/oswald-core      # as a typed library
```

Prefer to run from source? See [Quickstart](#quickstart) below.

---

## The problem: context rot

Long-running agentic work degrades as the conversation grows. Facts established
early ("the grain is one row per customer per month") get buried, contradicted,
or silently forgotten as the context window fills with intermediate reasoning.
This is **context rot**, and it is fatal for multi-step analytical engineering,
where a decision made at intake must still hold at validation.

### How Oswald resists it

1. **Durable artifacts in `.oswald/`.** Every tentacle writes its findings to
   versioned files (`intake.md`, `eda_report.md`, `metric_spec.yml`,
   `validation_report.md`, …). The artifact directory — not the chat transcript —
   is the source of truth. A fresh agent run reads the files, not the history.
2. **A thin orchestrator.** Tentacles do deterministic work and return a compact
   result plus the recommended next command. The model reasons over *small,
   structured evidence*, never the whole project at once.
3. **Explicit state, not implicit memory.** `.oswald/state.yml` records the phase,
   blockers, requirement completeness, and the next command. `oswald next` reads
   it, so the workflow survives a context reset or a process restart.
4. **`oswald compact`.** On demand, Oswald summarizes the artifact set into a single
   `current_context.md` ("read this first") and archives the noisy intermediates —
   while **deliberately preserving** the decision log and evidence. Context-rot
   reduction you can run any time without losing anything load-bearing.
5. **Evidence tagging.** Every business rule, metric, grain, or filter is tagged
   `confirmed` / `inferred` / `assumption` / `open_question`, with a source.
   Unsourced claims can never masquerade as fact.

---

## Why eight tentacles

The pipeline is decomposed into eight self-contained modules ("tentacles"), each
owning one workflow phase, one CLI verb, and its own I/O schemas + quality
checklist. They run in a linear order with human gates between side effects.

| # | Tentacle | What it does |
|---|----------|--------------|
| 1 | **Requirements Intake** | Turns a raw ticket into a structured brief — requirements, acceptance criteria, sources, targets, stakeholders, ambiguity flags — treating all ticket text as untrusted evidence. |
| 2 | **Clarification & Scoping** | Triages open questions (blocking vs non-blocking), groups them by stakeholder, surfaces scope risks, proposes explicit assumptions, recommends splitting oversized tickets, and drafts a clarification comment. |
| 3 | **Context Gathering** | Local-first scan of the repo (dbt models, SQL, YAML, docs) plus optional related tickets/docs, so the pipeline does not rebuild what already exists. |
| 4 | **Warehouse Discovery & EDA** | Generates (and optionally runs) **read-only** SQL to profile sources, infer grain, probe joins, and identify PII — preferring aggregates, never sampling sensitive columns raw. |
| 5 | **Metric & Semantic Design** | Converts business language into precise metric/grain/dimension/filter definitions and a reconciliation approach; never invents business logic. |
| 6 | **Model Planning & Implementation** | Plans layered staging/intermediate/mart dbt models + tests and emits a `changed_files` manifest of *intended* changes — without touching project files. |
| 7 | **Validation & Quality** | Classifies acceptance criteria into deterministic checks, (guardedly) runs dbt build/test, reconciles against a legacy report, and refuses to declare "done" while blocking failures remain. |
| 8 | **Delivery, PRs & Knowledge Capture** | Packages the change into a PR summary with validation evidence, drafts a ticket update, appends the decision log, and writes handoff/release notes — all draft-by-default and approval-gated. |

(`build`, `ship`, and `compact` are deterministic, non-tentacle commands; `init`,
`doctor`, and `next` are operator commands.)

---

## Quickstart

From source (Node.js >= 22):

```bash
git clone https://github.com/austinAbraham/oswald.git
cd oswald
npm install
npm run build              # compiles TypeScript to dist/
node dist/cli/index.js --help
npm link                   # optional: puts `oswald` on your PATH
```

Throughout the docs, `oswald <command>` and `node dist/cli/index.js <command>`
are interchangeable.

---

## Offline demo (no network, no warehouse, no LLM)

Walks the **entire** pipeline against the bundled sample ticket and the built-in
mock warehouse — fully local and deterministic. Run it in a throwaway directory:

```bash
mkdir /tmp/oswald-demo && cd /tmp/oswald-demo
cp /path/to/oswald/examples/tickets/sample-retention-ticket.md ./ticket.md
OSWALD="node /path/to/oswald/dist/cli/index.js"

$OSWALD init --runtime generic --yes      # init + a generic runtime adapter (no secrets)
$OSWALD intake --from-file ./ticket.md    # the sample ticket's id is AE-1234
$OSWALD clarify       AE-1234 --draft-comment
$OSWALD context       AE-1234 --local-only
$OSWALD eda           AE-1234 --warehouse mock --dry-run
$OSWALD design        AE-1234
$OSWALD plan          AE-1234
$OSWALD build         AE-1234 --dry-run
$OSWALD validate      AE-1234 --skip-external
$OSWALD pr            AE-1234 --draft
$OSWALD update-ticket AE-1234 --draft
$OSWALD next                              # recommended next step
$OSWALD compact                           # summarize + archive intermediates
```

The whole pipeline's evidence lives on disk — `ls .oswald/` and
`cat .oswald/current_context.md`.

### What you'll see (honest expectations)

- **Pipeline commands take a `<ticket>` argument.** `intake --from-file` records the
  source as `local-file`, so the demo passes `AE-1234` explicitly to downstream
  verbs. (Intake from a provider — `intake TICKET-42 --provider mock` — persists the
  id, and `oswald next --run` can supply it for you.)
- **`validate --skip-external` lands in `blocked` (exit 2) — by design.** Offline,
  Oswald can't actually build the dbt project, so the "builds cleanly into the
  sandbox" criterion is recorded as *not verified* rather than faked. `blocked` is
  not a crash; all artifacts are still written.
- **`pr` / `update-ticket --draft` only ever draft.** They write `pr_summary.md` /
  `jira_update.md` and never post anything. They also park in `blocked` here because
  validation didn't pass.
- **`compact`** summarizes into `current_context.md` and archives intermediates into
  `.oswald/archive/`, preserving the decision log and evidence.

To go further offline: `eda AE-1234 --warehouse mock --execute` runs the generated
read-only SQL against the mock fixture, and `build AE-1234 --apply --yes` scaffolds
conservative, clearly-marked example dbt files under `models/` (never overwriting).

### Real dbt-backed validate (non-blocked, requires `dbt`)

The offline demo ends in `blocked` *because* it stays local. With an actual dbt
project and a working `dbt`, `validate --dbt` runs a **real** `dbt build` + `dbt test`
and can reach a **non-blocked** verdict. The repo ships a runnable example at
`examples/dbt-project` (duckdb — no warehouse account needed):

```bash
OSW=/path/to/oswald
EX="$OSW/examples/dbt-project"
DBT='uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt'   # or your own `dbt`

$DBT seed --project-dir "$EX" --profiles-dir "$EX" --target sandbox   # once
node "$OSW/dist/cli/index.js" validate AE-1234 \
  --dbt --dbt-project-dir "$EX" --dbt-target sandbox --dbt-command "$DBT"
# → validate: PASS — N passed, 0 failed   (exit 0, NON-blocked)
```

This is covered by a guarded integration test
(`tests/integration/dbt-duckdb.test.ts`, opt in with `OSWALD_RUN_DBT_IT=1`) that
skips cleanly when no usable `dbt` is found, so `npm test` stays green offline.

---

## Command reference

| Command | Purpose |
|---------|---------|
| `init` | Initialize Oswald in a project (state + runtime command templates). |
| `doctor` | Diagnose the environment: config, state, providers, policy. |
| `intake [ticket\|text]` | Ingest a ticket (`--from-file`, `--provider`, or inline text) and draft structured requirements. |
| `clarify <ticket>` | Triage open questions; draft (`--draft-comment`) or post (`--post-comment --yes`) a clarification comment. |
| `context <ticket>` | Gather existing warehouse/repo/doc context (`--local-only`, `--include-prs/--include-docs/--include-tickets`). |
| `eda <ticket>` | Generate read-only EDA SQL; `--dry-run` (default) or `--execute`; `--warehouse mock\|snowflake\|none`. |
| `design <ticket>` | Convert business language into metric/semantic definitions. |
| `plan <ticket>` | Plan layered dbt models + tests; emit an intended-changes manifest (writes plans, not models). |
| `build <ticket>` | Turn the plan into a change preview (`--dry-run`, default) or scaffold dbt files (`--apply --yes`). |
| `validate <ticket>` | Classify acceptance criteria into deterministic checks (`--skip-external` default; `--dbt`, `--command`). |
| `pr <ticket>` | Package the change into a PR summary; `--draft` (default) or `--open --yes`. |
| `update-ticket <ticket>` | Write results back to the ticket; `--draft` (default) or `--post --yes`. |
| `ship <ticket>` | Finalize: verify validation + PR summary, archive intermediates, mark `shipped`. |
| `compact` | Summarize artifacts into `current_context.md`; archive noisy intermediates. |
| `next` | Show (or `--run`) the recommended next command from state. |

Every command accepts `-C, --cwd <dir>` to set the project root.

---

## Safety model

Oswald's posture is **default-deny for every side effect**, built in rather than
bolted on.

- **A write proceeds only when BOTH** an explicit consent flag is supplied
  (`--yes` / `--post` / `--open` / `--apply`) **AND** the configured policy permits
  it. Absent either, the command degrades to draft/dry-run; `--draft` always forces
  draft-only. Enforced by a single `ApprovalService` (`core/approvals`).
- **Read-only warehouse access.** Every EDA query is re-validated through an SQL
  safety gate (`core/policy/sql-safety`) that allows only a read-only leading
  keyword (`SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`), rejects multi-statement
  input, and injects a `LIMIT` cap. The library never spawns a process to run
  external commands itself.
- **Untrusted-content sanitizer.** All ticket/doc/EDA text is wrapped and
  prompt-injection-scanned before any agent reads it; detected patterns are
  neutralized and flagged, never silently obeyed.
- **PII redaction.** Sensitive values are masked out of every artifact before it is
  written, and PII-by-name columns are profiled by aggregate only, never sampled raw.
- **Gated action classes:** `ticket_update`, `create_ticket`, `create_branch`,
  `commit`, `push`, `open_pull_request`, `execute_write_sql`,
  `write_external_document`. The default config gates warehouse writes, PR opens, and
  ticket updates, and **prohibits** direct push to protected branches — mirroring the
  **Rule of Two**: never concentrate read-untrusted-text + touch-warehouse +
  post-comments in one un-gated step.

See [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#policy-engine).

---

## Runtime support

Oswald is runtime-agnostic. `oswald init --runtime <id>` generates command templates
(and, where supported, slash commands, agent definitions, hooks, and an MCP setup
HOW-TO) under `.oswald/runtime/<id>/`. **No secrets are ever written** — credentials
are documented as a HOW-TO pointing at each runtime's own configuration.

| Runtime | Status | What you get |
|---------|--------|--------------|
| `generic` | **Supported** | A command-prompt `.md` per command + a README index. The always-available fallback; works in any shell. |
| `claude-code` | **Supported** | Modern Claude Code **skills** (`.claude/skills/oswald-<cmd>/SKILL.md`), an agent definition, a hooks scaffold, and an `MCP-SETUP.md`. Add `--install` to write skills/agents straight into `.claude/`. Prompts are **connector-aware** (see below). |
| `codex` | **Supported** | Command-prompt files + a Codex MCP setup doc. |
| `gemini-cli` | **Supported** | Command-prompt files + a Gemini CLI MCP setup doc. |
| `cursor` | **Scaffolded** | Detection + command docs + a README noting that support is scaffolded; you configure MCP yourself. |
| `windsurf` | **Scaffolded** | Same posture as Cursor. |

Unknown runtime ids fall back to `generic` with a warning. Detail:
[`docs/RUNTIMES.md`](docs/RUNTIMES.md).

### Make Oswald's commands available in Claude Code

Run init with `--install` to write Oswald's skills and agent straight into the
project's `.claude/` directory so the commands actually appear in Claude Code:

```bash
oswald init --runtime claude-code --install
```

This creates:

- `.claude/skills/oswald-<command>/SKILL.md` — one skill per Oswald command
- `.claude/agents/oswald-analyst.md` — the `oswald-analyst` subagent

**Restart (or reload) Claude Code** so the new skills and agent load, then invoke
them as `/oswald-intake`, `/oswald-context`, and so on.

Without `--install`, the same skills/agent are *staged* under
`.oswald/runtime/claude-code/` (`skills/oswald-<command>/SKILL.md` and
`agents/oswald-analyst.md`) — copy them into `.claude/` manually if you prefer:

```bash
cp -R .oswald/runtime/claude-code/skills .claude/skills
cp -R .oswald/runtime/claude-code/agents .claude/agents
```

The reference docs (`hooks/README.md`, `MCP-SETUP.md`) always stay staged under
`.oswald/runtime/claude-code/` since Claude Code does not auto-load them.

---

## MCP integration

Oswald reaches external systems (warehouse, ticketing, repo, docs) through a typed
**provider** abstraction (`ToolProvider` plus the per-domain `WarehouseProvider` /
`TicketProvider` / `RepoProvider` / `DocumentProvider`). Tentacles only ever see
those interfaces, so the backend can change without touching pipeline logic, and any
provider can be omitted to degrade gracefully. Two delivery models:

- **Model B — connector-aware prompts (live).** Inside Claude Code, Oswald's
  generated slash-command prompts instruct the host to use its **already-connected**
  MCP connectors (`mcp__atlassian__*`, `mcp__github__*`, a warehouse connector) — so
  Oswald stays MCP-client-free in that runtime, reusing the integrations you already
  have, with untrusted-content wrapping and approval gates preserved.
- **Model A — CLI-owned MCP client (backlog).** A client Oswald owns, so
  terminal / CI / non-Claude-Code users get live providers too. Tracked in
  [`TODO.md`](./TODO.md) / [`docs/ROADMAP.md`](docs/ROADMAP.md).

> **Honest status:** the in-library MCP transport (`src/tools/mcp/`) is a typed but
> **unwired stub** (`McpToolProvider` reports *"unavailable — no MCP server
> configured"*). The **mock providers** are what runs today in-library; Model B is
> live via the Claude Code runtime. See [`docs/MCP.md`](docs/MCP.md).

---

## Current limitations

Early-stage software — being explicit about what is **not** done:

- **No live LLM in the library** (by design) — tentacles are deterministic and emit
  prompts/evidence for the host runtime; there's no built-in agent loop.
- **In-library live providers are backlog (Model A).** Live connectors work today
  only via the Claude Code runtime (Model B); elsewhere the mock providers are the
  only in-library backend.
- **`build --apply` writes *scaffolds*, not production SQL.** Generated `.sql`/`.yml`
  are clearly-marked `TODO(human)` stubs; Oswald never fabricates provenance, so the
  post-apply `dbt parse` is *expected* to fail on the placeholders until a human fills
  them in. It never overwrites or deletes files.
- **`cursor` / `windsurf` adapters are scaffolded**, not full integrations.
- **No offline driver for real warehouses** in this tier; `--warehouse snowflake`
  falls back to the mock so the read-only gate is still exercised deterministically.
- **No durable orchestration / queue yet** (no DBOS/Temporal); the workflow is
  state-file-driven and resumable, but there's no background reconciler.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, how to add a
tentacle / adapter / provider, and the safety rules contributors must keep.
Releases: [`docs/RELEASING.md`](docs/RELEASING.md).

## License & credits

Licensed under the **MIT License** — see [`LICENSE`](LICENSE).

Architectural inspiration is gratefully acknowledged from the **GSD Core** workflow
discipline (durable planning artifacts, explicit phase state, thin orchestration) and
from the **Model Context Protocol** documentation and ecosystem (the typed
tool/provider seam Oswald is built around).

The earlier Python/Claude-Code dbt harness that preceded this project is preserved on
the [`legacy-python`](https://github.com/austinAbraham/oswald/tree/legacy-python)
branch.
