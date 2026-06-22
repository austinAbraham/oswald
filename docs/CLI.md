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
- **State** lives in `.oswald/state.yml`; the audit trail in `.oswald/audit.log`.
- **Consent flags are never defaults.** Writes are default-deny; a `--yes` /
  `--post` / `--open` / `--apply` is required, and `--draft` always forces
  draft-only. See [SECURITY_MODEL.md](./SECURITY_MODEL.md#approval-gates).

## Exit codes

Pipeline commands route through a shared runner (`src/cli/commands/_run.ts`) with
a uniform contract:

| Code | Meaning |
|------|---------|
| `0`  | success — the phase advanced; artifacts written |
| `1`  | hard error — the command threw, an unknown tentacle, or a precondition failed |
| `2`  | **blocked** — the workflow landed in `blocked` (e.g. a validation gate failed). Not a crash; artifacts are still written, but the non-zero code halts automation. |

Operator commands (`doctor`, `ship`, `compact`, `next`, `init`) use `0`/`1`
(`doctor` returns `1` on any fail-status check; `ship`/`compact` return `1` on a
precondition failure).

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
per-provider health, and policy mode.

| Option | Description |
|--------|-------------|
| `-C, --cwd <dir>` | project root |

**Writes:** nothing. **Exit:** `0` if no check has `fail` status, else `1`.

### `oswald next`
Show (or run) the recommended next command, derived from the workflow state
machine.

| Option | Description |
|--------|-------------|
| `--run` | execute the recommended next command (never skips validation) |
| `-C, --cwd <dir>` | project root |

**Writes:** nothing itself; with `--run`, the dispatched command writes its own
artifacts and sets its own exit code. **Exit:** `0` when showing; otherwise the
dispatched command's code.

---

## Pipeline commands (workflow order)

These advance the linear state machine
`intake → clarification → context → eda → design → planning → building →
validating → ready_for_pr → ready_for_ticket_update → shipped` (`blocked` is a
recoverable side state). Each prints a standard block: what it did, warnings,
open questions, artifacts written, and the suggested next command. All return
`0` / `1` / `2` per the table above.

### `oswald intake [ticketOrInput]`
Ingest a ticket and draft structured requirements. The positional is either a
ticket id (when a provider is given) or inline ticket text.

| Option | Description |
|--------|-------------|
| `--from-file <path>` | read raw ticket markdown from a local file |
| `--provider <name>` | ticket source: `jira` / `github` / `local` / `mock` |
| `--output <dir>` | artifact output dir override (advisory) |
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
| `-C, --cwd <dir>` | project root |

**Writes:** `eda.md`. (In this tier `snowflake` falls back to the mock provider.)

### `oswald design <ticket>`
Convert business language into precise metric/semantic definitions.

| Option | Description |
|--------|-------------|
| `-C, --cwd <dir>` | project root |

**Writes:** `design.md`.

### `oswald plan <ticket>`
Plan layered dbt models + tests and emit an intended-changes manifest.

| Option | Description |
|--------|-------------|
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
| `-C, --cwd <dir>` | project root |

**Writes:** `build.md` (always); with `--apply` + approval, dbt SQL/YAML under the
configured `model_dir`/`test_dir`. **Exit:** `0` / `1` (e.g. `1` if `--apply`
lacks approval or a precondition fails).

### `oswald validate <ticket>`
Verify generated work against acceptance criteria. Stays fully local by default;
running dbt is opt-in and guarded.

| Option | Description |
|--------|-------------|
| `--dbt` | run dbt parse/build/test (requires a wired command runner) |
| `--skip-external` | stay fully local: never run any external command (default) |
| `-C, --cwd <dir>` | project root |

**Writes:** `validation.md`. A failed gate moves state to `blocked` → **exit 2**.

### `oswald pr <ticket>`
Package the change into a PR summary. Opening the PR is gated.

| Option | Description |
|--------|-------------|
| `--draft` | produce the PR summary as a draft only (default) |
| `--open` | open the pull request (requires approval + a repo provider) |
| `-y, --yes` | grant explicit approval for gated side effects |
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
| `-C, --cwd <dir>` | project root |

**Writes:** `ticket-update.md`. Posting (`ticket_update`) is approval-gated.

---

## Finalization & maintenance

### `oswald ship <ticket>`
Finalize: verify a validation result and PR summary exist, archive intermediate
artifacts, and mark the ticket shipped.

| Option | Description |
|--------|-------------|
| `-C, --cwd <dir>` | project root |

**Writes:** `ship.md`; archives intermediates; advances state to `shipped`.
**Exit:** `0` on success; `1` if preconditions are unmet (missing validation/PR).

### `oswald compact`
Summarize artifacts into a `current_context.md` and archive noisy intermediates —
the context-rot-resistance maintenance step.

| Option | Description |
|--------|-------------|
| `-C, --cwd <dir>` | project root |

**Writes:** a compacted context summary; archives intermediates. **Exit:** `0` /
`1`.

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
| audit log | `audit.log` |
