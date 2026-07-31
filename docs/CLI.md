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
  draft-only — including over any `policies.autonomy` grant. (The
  `policies.autonomy` block can pre-approve specific action classes for
  callers that pass no consent flag at all; the `policies.prohibit` list still
  always wins.) See [SECURITY_MODEL.md](./SECURITY_MODEL.md#approval-gates).
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

Operator commands (`doctor`, `status`, `ship`, `compact`, `next`, `init`) use
`0`/`1` (`doctor` returns `1` on any fail-status check; `ship`/`compact` return
`1` on a precondition failure; `status` is read-only and returns `0` even when
the project is uninitialized).

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
machine.

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

---

## Pipeline commands (workflow order)

These advance the linear state machine
`intake → clarification → context → eda → design → planning → building →
validating → ready_for_pr → ready_for_ticket_update → shipped` (`blocked` is a
recoverable side state). Each prints a standard block: what it did, the
provider resolution table, warnings, open questions, artifacts written, and the
suggested next command. All return `0` / `1` / `2` per the table above.

### `oswald intake [ticketOrInput]`
Ingest a ticket and draft structured requirements. The positional is either a
ticket id (when a provider is given) or inline ticket text.

| Option | Description |
|--------|-------------|
| `--from-file <path>` | read raw ticket markdown from a local file |
| `--provider <name>` | ticket source: `jira` / `github` / `local` / `mock` |
| `--output <dir>` | artifact output dir override (advisory) |
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
