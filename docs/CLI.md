# Oswald CLI reference

Every Oswald command, its options, what it writes, and its exit codes.

The binary is `oswald` (see `package.json` `bin`). When it is not on `PATH`, use
`npx oswald …` or `node dist/cli/index.js …`. Requires **Node >= 22**.

## Global conventions

- **`-C, --cwd <dir>`** — project root. Available on every command; defaults to
  the current working directory.
- **Artifacts** land under the configured artifact dir (default `.oswald/`).
  Filenames are canonical (`src/core/artifacts/names.ts`) — see
  [Artifacts](#artifacts).
- **State** lives in `.oswald/state.yml`; the audit trail in `.oswald/audit.jsonl`
  — an append-only, hash-chained JSONL ledger (see [`oswald audit`](#oswald-audit)).
- **Consent flags are never defaults.** Writes are default-deny; a `--yes` /
  `--post` / `--open` / `--apply` is required, and `--draft` always forces
  draft-only — including over any `policies.autonomy` grant. (The
  `policies.autonomy` block can pre-approve specific action classes for
  callers that pass no consent flag at all; the `policies.prohibit` list still
  always wins.) See [SECURITY_MODEL.md](./SECURITY_MODEL.md#approval-gates).
- **`--json`** — every pipeline command (`intake` … `update-ticket`, including
  `build`) supports a machine-output mode for CI/headless use: one JSON step
  report on stdout, diagnostics on stderr. Operator and finalization commands
  (`init`, `doctor`, `next`, `ship`, `compact`) are human-output only. See
  [CI / machine output](#ci--machine-output---json).
- **Provider resolution is loud.** Every pipeline command prints a one-line
  `providers:` table showing what was REQUESTED vs what was RESOLVED per slot
  and why any fallback happened, e.g.
  `providers: warehouse: snowflake→MOCK (snow CLI not found on PATH); ticket: mock`
  (the fallback target is uppercased). By default a fallback is tolerated with
  a warning; pass **`--strict-providers`** (or set
  `policies.strict_providers: true` in `oswald.yml`) to turn any silent
  fallback into a hard failure — **exit 1** with a remediation hint, before the
  tentacle runs — so mock results can never masquerade as real evidence.
  Explicit suppression (`--local-only`, `--warehouse none`) is reported but is
  never a fallback.

## Exit codes

Pipeline commands route through a shared runner (`src/cli/commands/_run.ts`) with
a uniform contract:

| Code | Meaning |
|------|---------|
| `0`  | success — the phase advanced; artifacts written |
| `1`  | hard error — the command threw, an unknown tentacle, or a precondition failed (e.g. `--strict-providers` refused a provider fallback) |
| `2`  | **blocked** — the workflow landed in `blocked` (e.g. a validation gate failed). Not a crash; artifacts are still written, but the non-zero code halts automation. |

[`resume`](#oswald-resume-ticket) follows the same contract (`2` = the blocking
check still fails). Operator commands (`doctor`, `status`, `ship`, `compact`,
`audit`, `brief`, `next`, `init`) use `0`/`1` (`doctor` returns `1` on any
fail-status check; `ship`/`compact`/`brief` return `1` on a precondition
failure; `audit verify` returns `1` on a broken hash chain; `status` is
read-only and returns `0` even when the project is uninitialized). `run`
extends the contract with one extra code: `3` = parked at an approval gate
(see [`oswald run`](#oswald-run-ticket)).

---

## Operator / setup commands

### `oswald init`
Initialize Oswald in a project — config check, state, and runtime templates.

| Option | Description |
|--------|-------------|
| `-r, --runtime <runtime>` | agent runtime to install templates for (`generic`/`claude-code`/`codex`/`gemini-cli`/`cursor`/`windsurf`); default `generic` |
| `-f, --force` | overwrite existing files (state + runtime templates) |
| `-y, --yes` | assume yes for non-destructive prompts |
| `--artifact-dir <dir>` | artifact dir (overrides config) |
| `-C, --cwd <dir>` | project root |

**Writes:** `.oswald/state.yml` (initial state) and runtime templates under
`.oswald/runtime/<id>/` (see [RUNTIMES.md](./RUNTIMES.md)). Never writes secrets.
**Exit:** `0`.

### `oswald doctor`
Diagnose the environment — runtime, config validity, artifact dir, state,
artifact drift, per-provider health, and policy mode.

| Option | Description |
|--------|-------------|
| `--accept-drift` | bless hand-edited artifacts: re-hash their current content into the drift baseline (keeps the edits) |
| `-C, --cwd <dir>` | project root |

The **drift** check compares each artifact's recorded content-hash baseline
(`state.yml` `artifact_hashes`, recorded at write time) against the explicit
upstream→downstream consumption edges, and warns when an upstream artifact
changed after a downstream phase last ran (`state.yml` `phase_runs`, stamped on
every run — so re-running a phase clears its staleness even when its outputs
are byte-identical). `stale` findings name the downstream phase to re-run
(e.g. `intake` re-run but `design`/`plan` never regenerated); `modified`
findings (content edited outside the pipeline) name the PRODUCING phase —
re-run it to regenerate the artifact, or keep the edit with `--accept-drift`.
Report-only otherwise: drift is a `warn`, never a `fail` — the hard gate lives
in `oswald ship`. Artifacts written before drift tracking existed are reported
as `unknown (no baseline)`.

`--accept-drift` re-hashes every baselined artifact whose on-disk content
diverged, using the file's mtime as the new baseline time: consumers that
already re-ran after the edit stay fresh, consumers that predate it are
honestly flagged stale until re-run. It never invents baselines for
pre-tracking (`unknown`) artifacts.

**Writes:** nothing (with `--accept-drift`: updated baselines in
`.oswald/state.yml`). **Exit:** `0` if no check has `fail` status, else `1`.

### `oswald status`
At-a-glance, read-only run dashboard on one screen: current phase, ticket
id/provider, requirements completeness (progress bar) + unresolved question
count, blockers, which canonical artifacts exist vs are missing (from the
registry in `src/core/artifacts/names.ts`), provider/tool health (the same
cheap probes `doctor` runs, including `snow` CLI detection), and the
recommended next command plus its successor from the workflow state machine.
Pure composition of existing readers — no writes, no side effects. Honors
`paths.artifact_dir` from `oswald.yml` (the same resolution the pipeline uses),
so it reads whatever directory the run actually writes to. When the artifact
dir or `state.yml` is missing it degrades gracefully and points at
`oswald init` / `oswald intake`; an invalid `oswald.yml` falls back to the
default `.oswald` dir (run `oswald doctor` to surface config problems).

| Option | Description |
|--------|-------------|
| `--json` | emit the same report as JSON on stdout (no log prefixes) |
| `-C, --cwd <dir>` | project root |

**Writes:** nothing. **Exit:** `0` (a hard error still exits `1`).

### `oswald next`
Show (or run) the recommended next command, derived from the workflow state
machine. A `blocked` workflow is not a dead end: `next` lists the recorded
blockers and recommends [`oswald resume`](#oswald-resume-ticket).

| Option | Description |
|--------|-------------|
| `--run` | execute the recommended next command (never skips validation) |
| `--explain` | additionally explain WHY that command is next: where the phase sits on the pipeline, which input artifacts the step reads (present vs missing), what it writes, which blockers / unresolved open questions gate it, which provider capabilities it needs vs what `state.tools` records, and which consent flags its approval-gated side effects would need |
| `-C, --cwd <dir>` | project root |

`--explain` is deterministic and read-only — it is composed entirely from
`state.yml`, artifact existence, `oswald.yml` policies, and the tentacle
registry, and never changes the default output (the explanation is appended
after it). The `reads` lines report the LITERAL filenames the recommended
step's code actually looks for (steps resolve inputs by filename, including
legacy fallback chains such as `validation_report.md` → `validation.md`);
input names that no pipeline step currently produces are called out as
exactly that. When the phase is `blocked` it lists the blockers and says
exactly what to re-run (the parking command when known, else `validate`).

**Writes:** nothing itself; with `--run`, the dispatched command writes its own
artifacts and sets its own exit code. **Exit:** `0` when showing; otherwise the
dispatched command's code.

### `oswald run <ticket>`
Single-command pipeline driver. Executes the recommended next step for the
ticket (exactly one step, like `next --run` but pinned to an explicit ticket).
With `--auto` it loops — read the phase, dispatch, repeat — streaming each
step's standard output block, until a stop condition.

| Option | Description |
|--------|-------------|
| `--auto` | keep executing steps until a terminal phase, a blocker, or an approval gate |
| `--max-steps <n>` | safety cap on steps executed per `--auto` run (default `20`) |
| `-C, --cwd <dir>` | project root |

`--auto` stops at the first of:

1. a **terminal phase** (`shipped`) → exit `0`;
2. a **non-zero step** (`2` = the workflow parked in `blocked`, `1` = hard
   error) → that code propagates;
3. an **approval gate** → exit `3`. Auto mode **never** synthesizes consent
   flags (`--yes`/`--apply`/`--post`/`--open`): when the next step's primary
   deliverable is an approval-gated side effect (`build` → write dbt files,
   `pr` → open the PR, `update-ticket` → post the update) the run parks in
   front of it and prints `awaiting approval for <action>: run 'oswald <cmd>
   <ticket> <consent flags>' to proceed`. Run that command yourself, or run
   `oswald run <ticket>` (no `--auto`) to execute the step draft/dry-run only;
4. the `--max-steps` cap → exit `1`.

`run` refuses (exit `1`) when Oswald is not initialized, when no ticket has
been ingested yet (intake needs real ticket content a driver must never
fabricate — run `oswald intake <ticket> --from-file <path>` first), and when
`<ticket>` differs from the ticket recorded in state.

**Writes:** nothing itself; every dispatched step writes its own artifacts.
**Exit:** `0` / `1` / `2` / `3` as above.

---

## Pipeline commands (workflow order)

These advance the linear state machine
`intake → clarification → context → eda → design → planning → building →
validating → ready_for_pr → ready_for_ticket_update → shipped` (`blocked` is a
recoverable side state — recover with
[`oswald resume`](#oswald-resume-ticket)). Each prints a standard block: what
it did, the provider resolution table, warnings, open questions, artifacts
written, and the suggested next command. All return `0` / `1` / `2` per the
table above. Every pipeline command also accepts `--json` (see
[CI / machine output](#ci--machine-output---json)); it changes only how the
outcome is printed, never what the command does.

Transitions are **enforced**: a command run out of order (one whose completed
phase the state machine cannot reach from the current phase, e.g. `plan`
straight after `intake`) fails loudly with an `Illegal workflow transition`
error (exit `1`) and leaves state untouched. The check is **pre-flighted
before the command does any work** — an out-of-order command posts nothing to
a ticket provider, writes no artifacts or project files, and archives nothing
(and `advanceWorkflow` re-asserts the same rule afterwards as the backstop).
Re-running the current phase's command is always allowed; the deliberate
exceptions (skipping the optional `clarify`/`eda` steps, finalizing from
`ready_for_pr`, shipping over documented limitations) live in one table in
`src/core/workflow/states.ts`.

### `oswald intake [ticketOrInput]`
Ingest a ticket and draft structured requirements. The positional is either a
ticket id (when a provider is given) or inline ticket text.

| Option | Description |
|--------|-------------|
| `--from-file <path>` | read raw ticket markdown from a local file |
| `--provider <name>` | ticket source: `jira` / `github` / `local` / `mock` |
| `--output <dir>` | artifact output dir override (advisory) |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

Examples: `oswald intake --from-file ./ticket.md`,
`oswald intake TICKET-42 --provider mock`.
**Writes:** `intake.md` (+ seeds `state.yml` if missing).

### `oswald clarify <ticket>`
Triage open questions and draft a clarification comment. Posting is gated.

| Option | Description |
|--------|-------------|
| `--draft-comment` | render the clarification comment as a draft only |
| `--post-comment` | post the clarification comment (requires approval) |
| `-y, --yes` | grant explicit approval for gated side effects |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

**Writes:** `clarifications.md`. Posting (`ticket_update`) is approval-gated.

### `oswald context <ticket>`
Gather existing warehouse/repo/doc context so work is not duplicated.

| Option | Description |
|--------|-------------|
| `--local-only` | scan the local repo only; pull no remote context |
| `--include-docs` | include related documents (needs a doc provider) |
| `--include-prs` | include related PRs (needs a repo provider) |
| `--include-tickets` | include related tickets (needs a ticket provider) |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

**Writes:** `context.md`.

### `oswald eda <ticket>`
Generate (and optionally run) **read-only** EDA SQL against a warehouse. All SQL
passes the read-only safety validator; rows are LIMIT-capped.

| Option | Description |
|--------|-------------|
| `--warehouse <kind>` | warehouse: `snowflake` / `mock` / `none` (default `mock`) |
| `--execute` | actually run the read-only queries (needs provider + policy) |
| `--dry-run` | generate SQL + plan only; never execute (default) |
| `--tables <csv>` | restrict EDA to these schemas/tables (comma-separated) |
| `--max-rows <n>` | cap rows per result (advisory; SQL is LIMIT-capped) |
| `--connection <name>` | `snow` connection NAME (required for `--execute` with `snowflake`) |
| `--warehouse-command <cmd>` | warehouse CLI invocation (default `snow`) |
| `--query-timeout <ms>` | per-query subprocess timeout in ms |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

**Writes:** `eda.md`. `--warehouse snowflake --execute` runs live read-only EDA via
the `snow` CLI (only a connection **NAME** crosses the boundary — never credentials);
it requires an explicit `--connection` (or `warehouse.connection` in `oswald.yml`).
When `snow` is absent or no connection is configured it falls back to the mock
provider — visibly, via the `providers:` table (e.g. `warehouse:
snowflake→MOCK (snow CLI not found on PATH)`); with `--strict-providers` (or
`policies.strict_providers: true`) that fallback is refused with exit 1
instead. See the README's "Real Snowflake EDA via the `snow` CLI" section.

### `oswald design <ticket>`
Convert business language into precise metric/semantic definitions.

| Option | Description |
|--------|-------------|
| `--json` | emit one machine-readable JSON step report on stdout |
| `-C, --cwd <dir>` | project root |

**Writes:** `design.md`.

### `oswald plan <ticket>`
Plan layered dbt models + tests and emit an intended-changes manifest.

| Option | Description |
|--------|-------------|
| `--json` | emit one machine-readable JSON step report on stdout |
| `-C, --cwd <dir>` | project root |

**Writes:** `plan.md`.

### `oswald build <ticket>`
Turn the implementation plan into a change preview, or — with `--apply` — write
conservative example dbt scaffolding.

| Option | Description |
|--------|-------------|
| `--dry-run` | write a change preview + manifest only; touch no project files (default) |
| `--apply` | generate conservative example dbt SQL/YAML under the model dir (approval-gated) |
| `-y, --yes` | grant explicit approval required by `--apply` |
| `--json` | emit one machine-readable JSON step report on stdout |
| `-C, --cwd <dir>` | project root |

**Writes:** `build.md` (always); with `--apply` + approval, dbt SQL/YAML under the
configured `model_dir`/`test_dir`. **Exit:** `0` / `1` (e.g. `1` if `--apply`
lacks approval or a precondition fails). `build` is the one pipeline command
that does not route through the shared runner, but `--json` emits the exact
same step-report document (its `exit_code` is `0`/`1` per this command's
contract).

### `oswald validate <ticket>`
Verify generated work against acceptance criteria. Stays fully local by default;
running dbt is opt-in and guarded.

| Option | Description |
|--------|-------------|
| `--dbt` | run dbt parse/build/test (requires a wired command runner) |
| `--skip-external` | stay fully local: never run any external command (default) |
| `--json` | emit one machine-readable JSON step report on stdout |
| `-C, --cwd <dir>` | project root |

**Writes:** `validation.md`. A failed gate moves state to `blocked` (recording
the origin phase in `status.blocked_from` and the run's fidelity in
`status.blocked_mode`: `external` when real external checks ran, `local`
otherwise) → **exit 2**. Recover with [`oswald resume`](#oswald-resume-ticket).

### `oswald pr <ticket>`
Package the change into a PR summary. Opening the PR is gated.

| Option | Description |
|--------|-------------|
| `--draft` | produce the PR summary as a draft only (default) |
| `--open` | open the pull request (requires approval + a repo provider) |
| `-y, --yes` | grant explicit approval for gated side effects |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

**Writes:** `pr.md`. Opening (`open_pull_request`) is approval-gated; direct push
to protected branches is prohibited.

### `oswald update-ticket <ticket>`
Write results back to the ticket. Posting is gated.

| Option | Description |
|--------|-------------|
| `--draft` | produce the ticket update as a draft only (default) |
| `--post` | post the update to the ticket (requires approval + provider) |
| `-y, --yes` | grant explicit approval for gated side effects |
| `--json` | emit one machine-readable JSON step report on stdout |
| `--strict-providers` | fail (exit 1) instead of falling back to a mock provider |
| `-C, --cwd <dir>` | project root |

**Writes:** `ticket-update.md`. Posting (`ticket_update`) is approval-gated.

---

## Finalization & maintenance

### `oswald ship <ticket>`
Finalize: verify a validation result and PR summary exist, check for artifact
drift, archive intermediate artifacts, and mark the ticket shipped.

| Option | Description |
|--------|-------------|
| `--allow-drift` | ship despite detected artifact drift (the override is recorded in the ship record) |
| `-C, --cwd <dir>` | project root |

Ship refuses when any upstream artifact drifted — unless `--allow-drift`
explicitly overrides (never a default; the override is written into the ship
record). `stale` findings clear by re-running the named downstream phase (a
byte-identical re-run counts); `modified` findings (hand-edits) clear by
re-running the producing phase or blessing the edit with
`oswald doctor --accept-drift`. Artifacts with no recorded baseline
(`unknown (no baseline)`, e.g. runs that predate drift tracking) never block
shipping.

**Writes:** `ship.md`; archives intermediates; advances state to `shipped`.
**Exit:** `0` on success; `1` if preconditions are unmet (missing validation/PR,
unresolved drift).

### `oswald compact`
Summarize artifacts into a `current_context.md` and archive noisy intermediates —
the context-rot-resistance maintenance step.

| Option | Description |
|--------|-------------|
| `-C, --cwd <dir>` | project root |

**Writes:** a compacted context summary; archives intermediates. **Exit:** `0` /
`1`.

### `oswald resume <ticket>`
Recover from a `blocked` workflow. Reports the recorded blockers, re-runs the
blocking check (the validation gate), and — on a pass — leaves `blocked` via a
legal transition, restoring the phase recorded in `status.blocked_from` when it
is legally reachable. Single-shot and deterministic: no retry loops, no
auto-fixing. Running it on a non-blocked workflow is a no-op that just reports
the recommended next command.

**Fidelity guard:** a block is never cleared at a lower fidelity than the run
that produced it. When `status.blocked_mode` is `external` (the blocking run
executed real dbt build/test or validation commands), a local-only `resume`
refuses to re-run anything and stays `blocked` (**exit 2**) — re-run with
`--dbt` (or another external knob) to clear it. The blocked hints printed by
the pipeline commands and `oswald next` include `--dbt` in that case.

| Option | Description |
|--------|-------------|
| `--command <cmd>` | extra validation command to run (repeatable) |
| `--dbt` | re-run with real dbt build + test when a dbt project is detected (turns on external execution) |
| `--skip-external` | stay fully local: never run any external command (default) |
| `--dbt-project-dir <dir>` | explicit dbt project dir (else auto-detected) |
| `--dbt-command <cmd>` | dbt invocation (e.g. `uvx --from dbt-core --with dbt-duckdb dbt`) |
| `--dbt-target <target>` | dbt target to build/test against (must look like a sandbox) |
| `-C, --cwd <dir>` | project root |

**Writes:** the validation artifacts (the re-run goes through the validate
tentacle) and updates `state.yml`. **Exit:** `0` unblocked (or nothing to
resume); `1` hard error; `2` the workflow stays `blocked` — either the blocking
check still fails, or an `external` block was attempted with a local-only
re-run (refused; nothing re-run).

### `oswald audit`
Inspect the persistent, tamper-evident audit ledger (`.oswald/audit.jsonl`).
Every approval decision, pipeline step outcome, SQL validation/execution
(statement **hash** — never raw SQL), provider fallback, and redaction/sanitizer
hit is appended as one JSON line carrying a rolling hash chain (`prev_hash` +
its own content hash). Ledger writes are fail-open (they never crash a
command); reading back is strict.

| Option | Description |
|--------|-------------|
| `-n, --tail <n>` | number of recent records to show (default `20`) |
| `-C, --cwd <dir>` | project root |

Without a subcommand it prints a readable summary: record counts by event type,
chain status, and the most recent records. **Writes:** nothing. **Exit:** `0`.

#### `oswald audit export`
Bundle the ledger for compliance review.

| Option | Description |
|--------|-------------|
| `--format <format>` | `json` (records + chain verification result) or `csv`; default `json` |
| `--out <file>` | write to a file instead of stdout |

**Writes:** only the `--out` file, when given. **Exit:** `0` / `1` (export failure).

#### `oswald audit verify`
Walk the hash chain strictly and report the **first broken link** (malformed
line, sequence gap, `prev_hash` mismatch, or altered record content). A
crash-truncated append (a partial line left by a kill/power loss mid-write) is
classified as an **aborted write**, not a break: the fragment is warned about
by line number and the chain — which provably continues across it — still
verifies.

**Writes:** nothing. **Exit:** `0` chain intact (or no ledger yet); `1` broken —
the report names the line and everything after it should be treated as
untrusted. (Truncating the tail of the file is the one edit a hash chain alone
cannot prove; anchor the latest hash externally if you need that.)

### `oswald brief`
Assemble an exec-readable stakeholder brief from the artifacts that already
exist — what was asked, where the work stands in business terms, what is
confirmed vs assumed vs still open (evidence-ledger tallies), blockers and who
is needed to unblock, and known limitations. Deterministic and read-only over
the pipeline: it runs no new analysis and never changes the workflow phase.

| Option | Description |
|--------|-------------|
| `--stdout-only` | print the brief without writing `brief.md` |
| `-C, --cwd <dir>` | project root |

**Writes:** `brief.md` (skipped with `--stdout-only`); always prints the brief.
Degrades gracefully — missing artifacts become "not yet known" statements.
Fenced code blocks (where artifacts embed the raw wrapped ticket text) are
excluded from the evidence tallies and stakeholder extraction, so ticket
content cannot forge tallies or steer the brief.
**Exit:** `0` / `1` (`1` only when no `.oswald/state.yml` exists yet).

---

## CI / machine output (`--json`)

Every pipeline command — the ten workflow-order commands from `intake` through
`update-ticket`, including `build` — accepts `--json` for CI/headless use.
Operator and finalization commands (`init`, `doctor`, `next`, `ship`,
`compact`) do not take `--json` and stay human-output only. The flag never
changes what a command *does* (consent stays default-deny; `--draft` still
forces draft-only) — only how the outcome is printed:

- **stdout** carries exactly **one JSON document per step** (the step report
  below) and nothing else. The human-formatted block is suppressed.
- **stderr** carries incidental diagnostics (logger warnings/errors), so stdout
  stays parseable even when things go wrong.
- The document is valid on **every** outcome: success, blocked, and hard error
  alike (errors serialize into the same shape with `ok: false`).
- The exit code follows the same `0` / `1` / `2` contract as the table above.

### Step report schema (`oswald.step_report/v1`)

Keys are snake_case and stable; new optional fields may be added, but existing
fields only change with a bump of the `schema` id.

| Field | Type | Meaning |
|-------|------|---------|
| `schema` | string | always `oswald.step_report/v1` |
| `ok` | boolean | `true` only on a clean success (`exit_code` 0) |
| `command` | string | the CLI verb that ran (e.g. `eda`, `pr`) |
| `ticket` | string \| null | ticket id the step targeted |
| `exit_code` | 0 \| 1 \| 2 | the documented exit-code contract |
| `phase_before` | string \| null | workflow phase before the run |
| `phase_after` | string \| null | workflow phase after the run (`null` on hard error) |
| `blocked` | boolean | the workflow landed in `blocked` |
| `blockers` | string[] | workflow blockers currently recorded in state |
| `summary` | string \| null | the tentacle's one-line summary |
| `warnings` | string[] | non-fatal warnings from the run |
| `open_questions_count` | number | open questions a human must answer |
| `artifacts` | string[] | artifacts written this run, **relative** to the project root |
| `approvals` | object[] | every approval decision taken (see below) |
| `next_command` | string \| null | recommended next CLI command |
| `error` | string \| null | error message on hard failure |

Each entry in `approvals` records one decision by the ApprovalService:

| Field | Type | Meaning |
|-------|------|---------|
| `action` | string | gated action class (`open_pull_request`, `ticket_update`, …) |
| `decision` | string | `allowed` / `denied` / `prohibited` |
| `allowed` | boolean | whether the side effect was permitted |
| `reason` | string | why (default-deny, policy gate, prohibit list, consent) |
| `consent_source` | string | the flag that decided consent: `--yes` / `--post` / `--open` / `--apply`, `--draft` (forces deny), or `none` |

Example (formatted; the CLI emits it on a single line):

```json
{
  "schema": "oswald.step_report/v1",
  "ok": false,
  "command": "validate",
  "ticket": "AE-1234",
  "exit_code": 2,
  "phase_before": "validating",
  "phase_after": "blocked",
  "blocked": true,
  "blockers": ["2 acceptance check(s) deferred — must be executed"],
  "summary": "validate: 0 pass, 0 fail, 2 deferred",
  "warnings": [],
  "open_questions_count": 0,
  "artifacts": [".oswald/validation_report.md", ".oswald/test_results.md"],
  "approvals": [],
  "next_command": null,
  "error": null
}
```

Consumption tips: parse stdout with `jq`, gate on the exit code (a `2` means
*blocked — a human must resolve blockers*), and archive the artifact dir. A
ready-made GitHub Actions recipe lives at
[`examples/github-actions/oswald-pipeline.yml`](../examples/github-actions/oswald-pipeline.yml)
— it runs the pipeline draft-only on a sample ticket, uploads `.oswald/` as a
build artifact, and fails the job when a step exits `2`.

---

## Artifacts

Canonical filenames written under the artifact dir (default `.oswald/`):

| Phase | File |
|-------|------|
| state | `state.yml` |
| intake | `intake.md` |
| clarify | `clarifications.md` |
| context | `context.md` |
| eda | `eda.md` |
| design | `design.md` |
| plan | `plan.md` |
| build | `build.md` |
| validate | `validation.md` |
| pr | `pr.md` |
| update-ticket | `ticket-update.md` |
| ship | `ship.md` |
| brief | `brief.md` |
| audit ledger | `audit.jsonl` |
