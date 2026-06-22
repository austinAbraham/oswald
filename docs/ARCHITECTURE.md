# Oswald architecture

Oswald is a TypeScript/ESM library (`@oswald-ai/oswald-core`) plus a thin
`oswald` CLI. This document maps the real modules under `src/` and how they fit
together. Everything is deterministic: **the library never calls an LLM and
never opens a network connection in normal operation.**

```
src/
  cli/          # Commander program + one file per command
  core/         # the engine: config, state, artifacts, workflow, policy, approvals, doctor, logging
  tentacles/    # the eight pipeline modules + shared base/registry
  tools/        # provider abstraction (mock impls today; MCP seam for later)
  runtimes/     # runtime adapters (generic / claude-code / codex / gemini-cli / cursor / windsurf)
  utils/        # fs, slug, time (clock), shared helpers
  index.ts      # library entrypoint (re-exports)
```

The high-level flow:

```
CLI command  ──▶  buildContext()  ──▶  Tentacle.run(ctx)  ──▶  artifacts on disk
   │                  │                       │                       │
   │            config + state +        deterministic work       advanceWorkflow()
   │            policy + providers      (parse / generate SQL /        │
   │            + clock + logger        classify / scaffold)      state.yml updated
   └── prints the standard output block + recommended next command ◀──┘
```

---

## Core engine (`src/core`)

### Config (`core/config`)

`oswald.yml` is parsed and validated by a Zod schema (`config/schema.ts`).
Defaults are generous: only `project.name` is required, and a fully-defaulted
config is produced when no file exists, so **every command is usable with zero
config**. The schema covers `project`, `runtime`, `paths`, `standards`,
`mcp_servers`, and `policies` (warehouse + privacy + approval lists).
`cli/commands/_config.ts` resolves the active config (`oswald.yml` → defaults
fallback keyed on the directory name).

### State (`core/state`)

`.oswald/state.yml` is the durable per-project lifecycle record, validated by a
Zod schema (`state/schema.ts`): `version`, `project`, `ticket`, `status`
(phase / last command / next recommended command / blockers), `requirements`
(completeness, unresolved questions), `tools`, `policy`, an `artifacts` key→path
map, and `timestamps`. `state/store.ts` provides `readState` / `writeState` /
`createInitialState` / `updateState`. State is what makes the pipeline survive a
context reset or a restart — the next agent reads the file, not the transcript.

### Artifacts (`core/artifacts`)

`ArtifactManager` owns all reads/writes under `<root>/<artifactDir>` (default
`.oswald`). It guards against path traversal, renders structured docs to
Markdown (`renderMarkdown`) and objects to YAML (`renderYaml`), and supports
`archive(name)` (moves a file to `archive/<timestamp>-<name>`). The artifact
directory — not the LLM context — is the project's memory.

### Workflow state machine (`core/workflow`)

`workflow/states.ts` defines the explicit, mostly-linear state machine:

```
uninitialized → intake → clarification → context → eda → design → planning
   → building → validating → ready_for_pr → ready_for_ticket_update → shipped
                                  └────────────▶ blocked (from any non-terminal) ◀──── resume
```

Each state maps to the CLI command that advances *out* of it
(`recommendNextCommand`) and to its default successor (`nextState`).
`canTransition` allows the linear successor, any non-terminal → `blocked`, and
`blocked` → any non-terminal (resume after unblocking). `shipped` and `blocked`
are terminal for `next`.

### Policy engine (`core/policy`)

Three deterministic, defense-in-depth gates, all exported from `policy/index.ts`:

- **`sql-safety.ts` — `SqlSafetyValidator`.** The read-only warehouse gate. It
  strips comments, splits statements, rejects multi-statement input, allows only
  a read-only leading keyword (`SELECT`, `WITH`, `SHOW`, `DESCRIBE`/`DESC`,
  `EXPLAIN`), explicitly blocks all write/DDL/privilege keywords, and injects a
  `LIMIT <max_result_rows>` cap on row-producing queries. Conservative by
  design: when in doubt, **block**. Every EDA query is re-validated through it
  before being written or executed.
- **`sensitive.ts` — `SensitiveFieldDetector` + `redactArtifactContent`.**
  Decides whether a column name looks like PII (canonical token list:
  `email`, `phone`, `name`, `ssn`, `credit_card`, `token`, …) and redacts
  sensitive values out of rendered artifacts (`[REDACTED]`) before they are
  persisted. PII-by-name columns are profiled only by aggregate.
- **`external-content.ts` — `ExternalContentSanitizer`.** The trust boundary for
  untrusted text (tickets, docs, EDA results). `wrap(text, source)` returns a
  clearly delimited, instruction-neutralized block plus a report of detected
  prompt-injection patterns (`ignore_previous`, `reveal_secrets`, …).
  Patterns are flagged and neutralized, never silently obeyed.

### Approvals (`core/approvals`)

`ApprovalService.requireApproval(action, { yes, policy, reason })` is the single
human-in-the-loop gate. It is **default-deny**: a side-effecting action proceeds
only when the caller supplies explicit `yes: true` **and** the policy permits it
(`require_approval_for` gates an action; `prohibit` forbids it outright).
Action classes: `ticket_update`, `create_ticket`, `create_branch`, `commit`,
`push`, `open_pull_request`, `execute_write_sql`, `write_external_document`,
with alias mapping so either config vocabulary works. `policyFromConfig` adapts
the config `policies` block to an `ApprovalPolicy`.

### Doctor (`core/doctor`)

`runDiagnostics({ cwd, providers })` checks the runtime (Node version), config
presence, artifact dir, state phase, each provider's health + capability count,
and the effective policy mode, returning a structured report the `doctor`
command renders.

### Logging (`core/logging`)

A small structured `logger` (`info` / `warn` / `error` / `success`) used
uniformly across the CLI and tentacles, injectable in tests.

---

## Tentacles (`src/tentacles`)

A **tentacle** is a first-class pipeline module. The shared contract lives in
`tentacles/base.ts`:

- It declares `id` (which doubles as workflow phase + CLI verb), `title`,
  `description`, Zod `inputSchema` / `outputSchema`, `requiredTools` /
  `optionalTools` (provider capabilities), and a self-applied quality
  `checklist`.
- Its `run(ctx)` does **deterministic** work, reads only the artifacts it needs,
  writes its output artifacts (PII-redacted), advances `state.yml` via
  `advanceWorkflow`, and returns a compact `TentacleResult` (artifacts written,
  one-line summary, open questions, warnings, structured output).
- It **degrades gracefully** when providers or prior artifacts are missing.

`base.ts` also defines the **evidence-tagging** primitives (`markEvidence`,
`renderEvidenceTable`, the `confirmed`/`inferred`/`assumption`/`open_question`
vocabulary) that enforce the analytical-engineering quality rule across all
tentacles, and the `buildContext` factory + `advanceWorkflow` helper.

### `TentacleContext`

`buildContext()` assembles the single, identically-configured world every
tentacle sees: resolved `config`, an `ArtifactManager`, the `providers` bundle,
the `policy` toolkit (sql / sensitive / sanitizer / redact), an
`ApprovalService`, the current `state`, an injectable `clock` and `logger`, the
target `ticketId`, and free-form per-run `options`. It reads state from disk or
(for intake) seeds a fresh state when `initStateIfMissing` is set.

### The eight tentacles + their artifacts

| id (`= phase = verb`) | Module | Key artifacts written under `.oswald/` |
|---|---|---|
| `intake` | `tentacles/intake` | `intake.md`, `requirements.md`, `acceptance_criteria.md` |
| `clarification` | `tentacles/clarification` | `open_questions.md`, `scope_risks.md`, `clarification_comment.md` |
| `context` | `tentacles/context` | `context_pack.md`, `existing_assets.md`, `lineage_notes.md`, `source_inventory.md` |
| `eda` | `tentacles/eda` | `eda_report.md`, `grain_analysis.md`, `join_analysis.md`, `data_quality_findings.md`, `sql_queries/*.sql` |
| `design` | `tentacles/design` | `metric_spec.yml`, `semantic_model_plan.md`, `dimension_contracts.yml` |
| `planning` | `tentacles/planning` | `model_plan.md`, `implementation_plan.md`, `changed_files.md` |
| `validate` | `tentacles/validation` | `validation_report.md`, `test_results.md`, `reconciliation_report.md`, `known_limitations.md` |
| `delivery` | `tentacles/delivery` | `pr_summary.md`, `jira_update.md`, `release_notes.md`, `handoff_notes.md`, `decision_log.md` |

The `delivery` tentacle backs both the `pr` and `update-ticket` verbs. Each
tentacle directory typically splits pure logic into helper files (e.g.
`intake/parse.ts`, `eda/sql.ts`, `clarification/analyze.ts`) so the `index.ts`
stays an orchestration shell.

### Registry (`tentacles/registry.ts`)

`TENTACLE_REGISTRY` keys each tentacle by its `id`. The CLI looks tentacles up
by id (`getTentacle`); `tentacleIds()` / `allTentacles()` enumerate them in a
deterministic order.

---

## CLI (`src/cli`)

`cli/index.ts` builds a Commander program (`buildProgram`) and only auto-runs
when invoked as the bin (so it stays importable in tests).
`cli/commands/index.ts` registers all commands in workflow order.

- **Operator/setup commands** — `init`, `doctor` — and **navigation** — `next` —
  talk to the engine directly.
- **Pipeline commands** funnel through `cli/commands/_run.ts`
  (`runTentacleCommand`): it builds the context, runs the registered tentacle,
  prints the **standard output block** (summary, warnings, open questions,
  artifacts, recommended next command), and returns an exit code — `0` success,
  `1` hard error, `2` the workflow landed in `blocked`.
- **Deterministic non-tentacle commands** — `build`, `ship`, `compact` — are
  hand-written in their command files (they read/write artifacts and advance
  state without a registry tentacle).
- `cli/commands/_providers.ts` (`selectProviders`) centralizes which providers a
  command wires, so every command degrades the same way (`--local-only` /
  `--skip-external` / `--warehouse none` drop providers).
- `cli/commands/_config.ts` resolves the active config.

`build` is the only non-tentacle command that can write into the project tree,
and only under `--apply --yes` with a permitting policy: it generates
conservative, clearly-marked dbt scaffolds (`TODO(human)` markers), **never**
overwriting or deleting. `ship` is the finalize gate (refuses to bypass blocking
validation failures unless `known_limitations.md` documents an exception).
`compact` is context-rot reduction (summarize → archive, preserving the decision
log + evidence).

---

## Tool / MCP abstraction (`src/tools`)

`tools/providers/types.ts` defines the typed contracts: a base `ToolProvider`
(name, `kind`, `capabilities()`, `health()`, generic `invoke()`) plus the
per-domain interfaces (`TicketProvider`, `WarehouseProvider`, `RepoProvider`,
`DocumentProvider`) with their typed methods. **Pipeline code depends only on
these interfaces, never on a transport.** Capabilities carry a `write: boolean`
flag so write-vs-read classification is explicit.

- **Mock providers** (`tools/providers/mock/`) — `MockTicketProvider`,
  `MockWarehouseProvider`, `MockRepoProvider`, `MockDocumentProvider`. Fully
  offline and deterministic; they power the demo, the tests, and `doctor`.
- **MCP seam** (`tools/mcp/provider.ts`) — `McpToolProvider` is the documented,
  typed slot for binding a real MCP server (dbt-mcp, a Jira MCP, …). It is a
  **stub today**: it reports *"unavailable — no MCP server configured"* and
  throws on `connect()`, with a step-by-step wiring plan in its header comment.
  When wired, MCP-backed providers slot in via `selectProviders` unchanged.

---

## Runtime adapters (`src/runtimes`)

Adapters are **generated assets, not forks**. The `RuntimeAdapter` contract
(`runtimes/adapters/types.ts`) renders command-prompt files (and, where the
runtime supports them, slash commands / agents / hooks / an MCP HOW-TO) into
`.oswald/runtime/<id>/`. Adapters **never write secrets** and declare their
capabilities honestly via `supportsFeature()`.

`runtimes/adapters/registry.ts` builds the registry (`generic`, `claude-code`,
`codex`, `gemini-cli`, plus scaffolded `cursor`/`windsurf`), resolves a
requested id (unknown → `generic` with a warning via `resolveAdapter`), and
offers best-effort `detectAdapter` (probes each adapter's side-effect-free
`detect()`). `BaseAdapter` (`adapters/base.ts`) provides shared install/uninstall
IO. See [`RUNTIMES.md`](RUNTIMES.md) for the per-runtime detail and support
matrix.

---

## Cross-cutting invariants

1. **Deterministic, no live LLM, no network** in the library. Tentacles emit
   prompts + evidence; the host runtime does the reasoning.
2. **All external text is untrusted** — wrapped + injection-scanned before any
   pattern reading; treated as data, never instructions.
3. **Default-deny writes** — every side effect goes through `ApprovalService`
   and needs explicit consent + a permitting policy.
4. **Evidence is always tagged** — `confirmed` / `inferred` / `assumption` /
   `open_question`, with a source.
5. **The artifact dir is the memory** — durable `.oswald/` files + explicit
   `state.yml`, refreshed by `compact`, make the pipeline context-rot-resistant.
