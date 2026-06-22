# Oswald the Analytical Octopus

> A runtime-agnostic, MCP-native, context-rot-resistant workflow layer for
> analytical-engineering AI agents.

Oswald turns a business request ("we need a monthly customer-retention mart")
into a disciplined, auditable analytical-engineering pipeline — intake →
clarification → context → EDA → design → planning → build → validation →
PR → ticket update → ship — where **every step writes durable artifacts to
disk**, the LLM stays a thin orchestrator, and **no side effect happens without
explicit human approval**.

Oswald is a TypeScript/ESM library plus a `oswald` CLI. It does **not** call a
model itself. Each pipeline step (a *tentacle*) does deterministic work —
parsing tickets, generating read-only SQL, classifying acceptance criteria,
scaffolding dbt files — and emits structured Markdown/YAML evidence plus the
next-step prompt. The agent runtime you already use (Claude Code, Codex,
Gemini CLI, or a plain CLI) supplies the reasoning; Oswald supplies the
workflow, the conventions, the safety gates, and the memory.

---

## The problem: context rot

Long-running agentic work degrades as the conversation grows. Facts established
early ("the grain is one row per customer per month") get buried, contradicted,
or silently forgotten as the context window fills with intermediate reasoning.
This is **context rot**, and it is fatal for multi-step analytical engineering,
where a decision made at intake must still hold at validation.

### How Oswald resists it

1. **Durable artifacts in `.oswald/`.** Every tentacle writes its findings to
   versioned files on disk (`intake.md`, `eda_report.md`, `metric_spec.yml`,
   `validation_report.md`, …). The artifact directory — not the chat
   transcript — is the source of truth. A fresh agent run reads the files, not
   the history.

2. **A thin orchestrator.** Tentacles do deterministic work and hand back a
   compact result + the recommended next command. The model is asked to reason
   over *small, structured evidence*, never to hold the whole project in its head.

3. **Explicit state, not implicit memory.** `.oswald/state.yml` records the
   pipeline phase, the recorded blockers, requirement completeness, and the
   next recommended command. `oswald next` reads it; the workflow survives a
   context reset or a process restart.

4. **`oswald compact`.** On demand, Oswald summarizes the current artifact set
   into a single `current_context.md` ("read this first") and archives the noisy
   intermediates it just summarized — while **deliberately preserving** the
   decision log and evidence-bearing artifacts. This is context-rot reduction
   you can run at any point without losing anything load-bearing.

5. **Evidence tagging.** Every business rule, metric, grain, or filter an agent
   records is tagged `confirmed` / `inferred` / `assumption` / `open_question`,
   with a source. Unsourced claims can never masquerade as fact, so a later step
   (or a human) can always tell what is known versus guessed.

---

## Why eight tentacles

The pipeline is decomposed into eight self-contained modules ("tentacles"),
each owning one workflow phase, one CLI verb, and its own I/O schemas + quality
checklist. They run in a linear order with human gates between side effects.

| # | Tentacle | What it does |
|---|----------|--------------|
| 1 | **Requirements Intake** | Turns a raw ticket into a structured brief — requirements, acceptance criteria, sources, targets, stakeholders, ambiguity flags — treating all ticket text as untrusted evidence. |
| 2 | **Clarification & Scoping** | Triages open questions into blocking vs non-blocking, groups them by stakeholder, surfaces scope risks, proposes explicit assumptions, recommends splitting oversized tickets, and drafts a clarification comment. |
| 3 | **Context Gathering** | Local-first scan of the repo (dbt models, SQL, YAML, docs) plus optional related tickets/docs, so the pipeline does not rebuild what already exists. |
| 4 | **Warehouse Discovery & EDA** | Generates (and optionally runs) **read-only** SQL to profile sources, infer grain, probe joins, and identify PII — preferring aggregates and never sampling sensitive columns raw. |
| 5 | **Metric & Semantic Design** | Converts business language into precise metric/grain/dimension/filter definitions and a reconciliation approach; never invents business logic. |
| 6 | **Model Planning & Implementation** | Plans layered staging/intermediate/mart dbt models + tests and emits a `changed_files` manifest of *intended* changes — without touching project files. |
| 7 | **Validation & Quality** | Classifies acceptance criteria into deterministic checks, (guardedly) runs dbt build/test, reconciles against a legacy report, and refuses to declare "done" while blocking failures remain. |
| 8 | **Delivery, PRs & Knowledge Capture** | Packages the change into a PR summary with validation evidence, drafts a ticket update, appends the decision log, and writes handoff/release notes — all draft-by-default and approval-gated. |

(`build`, `ship`, and `compact` are deterministic, non-tentacle commands; `init`,
`doctor`, and `next` are operator commands.)

---

## Quickstart

Requires **Node.js >= 22**.

```bash
git clone <your-fork-or-this-repo> oswald
cd oswald
npm install
npm run build        # compiles TypeScript to dist/
node dist/cli/index.js --help
```

Optionally link the `oswald` bin onto your PATH:

```bash
npm link             # then: oswald --help
```

Throughout the docs, `oswald <command>` and
`node dist/cli/index.js <command>` are interchangeable.

---

## Offline demo (no network, no warehouse, no LLM)

This walks the **entire** pipeline against the bundled sample retention ticket
and the built-in mock warehouse. Everything runs locally and deterministically.
Run it in a throwaway directory:

```bash
# 0) Work in a scratch dir; point at the repo's sample ticket.
mkdir /tmp/oswald-demo && cd /tmp/oswald-demo
cp /path/to/oswald/examples/tickets/sample-retention-ticket.md ./ticket.md

OSWALD="node /path/to/oswald/dist/cli/index.js"

# 1) Initialize Oswald + a generic runtime adapter (no secrets written).
$OSWALD init --runtime generic --yes

# 2) Intake the ticket from the local file.
$OSWALD intake --from-file ./ticket.md

# 3..10) Drive the pipeline. Use the ticket id AE-1234 (from the sample ticket).
$OSWALD clarify       AE-1234 --draft-comment
$OSWALD context       AE-1234 --local-only
$OSWALD eda           AE-1234 --warehouse mock --dry-run
$OSWALD design        AE-1234
$OSWALD plan          AE-1234
$OSWALD build         AE-1234 --dry-run
$OSWALD validate      AE-1234 --skip-external
$OSWALD pr            AE-1234 --draft
$OSWALD update-ticket AE-1234 --draft

# 11) See the recommended next step, then compact the artifact set.
$OSWALD next
$OSWALD compact
```

Inspect the results — the whole pipeline's evidence lives on disk:

```bash
ls .oswald/                 # intake.md, eda_report.md, metric_spec.yml, ...
cat .oswald/current_context.md
```

### What you'll see (honest expectations)

- **Pipeline commands take a `<ticket>` argument.** `intake --from-file` records
  the ticket source as `local-file`; the sample ticket's id is `AE-1234`, so the
  demo passes `AE-1234` to the downstream verbs. (If you intake from a provider
  with `intake TICKET-42 --provider mock`, the id is persisted and
  `oswald next --run` can supply it for you.)
- **`validate --skip-external` lands the workflow in `blocked` (exit code 2).**
  This is correct and honest: offline, Oswald cannot actually build the dbt
  project into a sandbox, so the "builds cleanly into the sandbox schema"
  acceptance criterion is recorded as *not verified* rather than faked. A
  blocked state is not a crash — all artifacts are still written.
- **`pr`/`update-ticket --draft` only ever draft.** They write
  `pr_summary.md` / `jira_update.md` and never post anything (no `--yes`, no
  provider). They also park in `blocked` here because validation did not pass —
  again, by design.
- **`compact`** summarizes the artifacts into `current_context.md` and archives
  the noisy intermediates into `.oswald/archive/`, preserving the decision log
  and evidence.

To go further: `eda --warehouse mock --execute` runs the generated read-only
SQL against the built-in mock fixture (a small `analytics.customers` /
`analytics.orders` schema), and `build AE-1234 --apply --yes` scaffolds
conservative, clearly-marked example dbt SQL/YAML stubs under `models/` (it
never overwrites or deletes existing files).

### Real dbt-backed validate (non-blocked, requires dbt + dbt-duckdb)

The offline demo above ends in `blocked` *because* it stays local. When an actual
dbt project and a working `dbt` are present, `validate --dbt` runs a **real**
`dbt build` + `dbt test` and can reach a **non-blocked** verdict. The repo ships
a runnable example project at `examples/dbt-project` (duckdb, no warehouse
account needed):

```bash
OSW=/path/to/oswald
EX="$OSW/examples/dbt-project"
DBT='uvx --python 3.12 --from dbt-core --with dbt-duckdb dbt'   # or your own `dbt`

# Seed the example project's duckdb fixtures once.
$DBT seed --project-dir "$EX" --profiles-dir "$EX" --target sandbox

# Validate AE-1234 against the real project — runs dbt build + test for real.
node "$OSW/dist/cli/index.js" validate AE-1234 \
  --dbt --dbt-project-dir "$EX" --dbt-target sandbox --dbt-command "$DBT"
# → validate: PASS — N passed, 0 failed   (exit 0, NON-blocked)
```

This path is covered by a guarded integration test
(`tests/integration/dbt-duckdb.test.ts`, opt in with `OSWALD_RUN_DBT_IT=1`) that
seeds, builds, tests, and asserts the validate tentacle reaches `ready_for_pr`.
It skips cleanly when no usable `dbt` is found, so `npm test` stays green offline.

---

## Full command list

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

- **A write only proceeds when BOTH** an explicit consent flag is supplied
  (`--yes` / `--post` / `--open` / `--apply`) **AND** the configured policy
  permits the action. Absent either, the command degrades to draft/dry-run.
  `--draft` always wins (forces draft-only even if a consent flag is present).
  This is enforced by a single `ApprovalService` (`core/approvals`).
- **Read-only warehouse access.** Every EDA query is re-validated through an SQL
  safety gate (`core/policy/sql-safety`) that allows only a read-only leading
  keyword (`SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`), rejects multi-statement
  input, and injects a `LIMIT` cap. Anything else is blocked. The library never
  spawns a process to run external commands itself.
- **Untrusted-content sanitizer.** All ticket/doc/EDA text is wrapped and
  prompt-injection-scanned before any agent reads it; detected patterns are
  neutralized and flagged, never silently obeyed.
- **PII redaction.** Sensitive values are masked out of every artifact before it
  is written, and PII-by-name columns are profiled only by aggregate, never
  sampled raw.
- **Gated action classes:** `ticket_update`, `create_ticket`, `create_branch`,
  `commit`, `push`, `open_pull_request`, `execute_write_sql`,
  `write_external_document`. Default config gates warehouse writes, PR opens,
  and ticket updates, and **prohibits** direct push to protected branches. This
  mirrors the **Rule of Two**: never concentrate read-untrusted-text +
  touch-warehouse + post-comments in one un-gated step.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#policy-engine) for the policy
engine internals.

---

## Runtime support matrix

Oswald is runtime-agnostic. `oswald init --runtime <id>` generates command
templates (and, where supported, slash commands, agent definitions, hooks, and
an MCP setup HOW-TO) under `.oswald/runtime/<id>/`. **No secrets are ever
written**; credentials are documented as a HOW-TO that points at each runtime's
own configuration.

| Runtime | Status | What you get |
|---------|--------|--------------|
| `generic` | **Supported** | A command-prompt `.md` per command + README index. The always-available fallback; works in any shell. |
| `claude-code` | **Supported** | Slash-command markdown, an agent definition, a hooks scaffold, and an `MCP-SETUP.md`. |
| `codex` | **Supported** | Command-prompt files + a Codex MCP setup doc. |
| `gemini-cli` | **Supported** | Command-prompt files + a Gemini CLI MCP setup doc. |
| `cursor` | **Scaffolded** | Detection + command docs + a README that is honest support is scaffolded; you configure MCP yourself. |
| `windsurf` | **Scaffolded** | Same posture as Cursor. |

Unknown runtime ids fall back to `generic` with a warning. Full detail:
[`docs/RUNTIMES.md`](docs/RUNTIMES.md).

---

## MCP integration overview

Oswald speaks to external systems (warehouse, ticketing, repo, docs) through a
typed **provider** abstraction (`ToolProvider` and the per-domain
`WarehouseProvider` / `TicketProvider` / `RepoProvider` / `DocumentProvider`
interfaces). Tentacles only ever see those interfaces, so the backend can change
without touching pipeline logic, and any provider can be omitted to degrade
gracefully.

Two implementations exist today:

- **Mock providers** — fully offline, deterministic, no network. They power the
  demo above, the test suite, and `oswald doctor`.
- **MCP provider seam** (`src/tools/mcp/`) — the documented, typed slot for
  binding Oswald to real MCP servers (e.g. `dbt-mcp`, a Jira MCP). `oswald.yml`
  already carries an `mcp_servers` block, and `doctor` surfaces the seam.

> **Current status (honest):** the MCP transport is **not yet wired**. The
> `McpToolProvider` is a clearly-marked stub that reports
> *"unavailable — no MCP server configured"* and throws on `connect()`, so the
> rest of the system degrades cleanly. The mock providers are what runs today.
> See `src/tools/mcp/provider.ts` for the step-by-step wiring plan.

---

## Current MVP limitations

This is early-stage software. Being honest about what is **not** done yet:

- **No live LLM in the library.** By design — tentacles are deterministic and
  emit prompts/evidence for the host runtime. There is no built-in agent loop.
- **Two connectivity models; Model B ships, Model A is backlog.**
  **Model B (live):** inside Claude Code, Oswald's generated slash-command prompts
  are *connector-aware* — they instruct Claude to use the **host's already-connected**
  MCP connectors (`mcp__atlassian__*`, `mcp__github__*`, a warehouse connector),
  so Oswald stays MCP-client-free in that runtime.
  **Model A (backlog, [TODO.md](./TODO.md) / [docs/ROADMAP.md](./docs/ROADMAP.md)):**
  a CLI-owned MCP client so terminal / CI / non-Claude-Code users get the same
  pipeline without a host's connectors. Until then, the mock providers are the
  only working in-library backend for those runtimes.
- **`validate --skip-external` (the default) is fully local** and records the
  sandbox-build criterion as *not verified*. Passing `--dbt` opts into REAL
  execution: when a dbt project and a working `dbt` (e.g. `dbt-duckdb`) are
  present, `validate` runs an actual `dbt build` + `dbt test` against a sandbox
  target and can reach a **non-blocked** verdict (see the dbt-backed walkthrough
  above). Without `--dbt` it never spawns a process.
- **`build --apply` writes conservative *scaffolds*, not production SQL.**
  Generated `.sql`/`.yml` are clearly-marked stubs with `TODO(human)` markers
  (`source('TODO_source', …)` / `ref('TODO_upstream')`); Oswald never fabricates
  provenance, so the post-apply `dbt parse` is expected to fail on those
  placeholders until a human fills them in — `build --apply` runs parse precisely
  to surface them, warns, and leaves the files for review. It never overwrites or
  deletes files.
- **`cursor`/`windsurf` adapters are scaffolded**, not full integrations.
- **Snowflake (and other real warehouses) have no offline driver** in this tier;
  `--warehouse snowflake` falls back to the mock so the read-only gate is still
  exercised deterministically.
- **No durable orchestration / queue yet** (no DBOS/Temporal); the workflow is
  state-file-driven and resumable, but there is no background reconciler.

---

## License & credits

Licensed under **Apache-2.0** (see [`LICENSE`](LICENSE)).

Architectural inspiration is gratefully acknowledged from the **GSD Core**
workflow discipline (durable planning artifacts, explicit phase state, thin
orchestration) and from the **Model Context Protocol** documentation and
ecosystem (the typed tool/provider seam Oswald is built around).
