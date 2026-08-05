# Changelog

All notable changes to `@oswald-ai/oswald-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-05

### Added

- **`oswald run <ticket>` single-command pipeline driver.** Executes exactly one
  recommended step, or with `--auto` loops until a terminal phase (exit 0), a
  blocked workflow / hard error (exit 2/1), an approval gate (exit 3), or the
  `--max-steps` cap (default 20). Auto mode never synthesizes consent flags — it
  parks in front of approval-gated deliverables (`build --apply`, `pr --open`,
  `update-ticket --post`) naming the exact command to proceed, refuses to drive a
  ticket other than the one in state, and hands intake back to the human.
- **`oswald status` — read-only run dashboard.** One screen with phase, ticket,
  completeness bar, blockers, open questions, canonical artifacts present/missing,
  provider health, and the recommended next command, plus a `--json` mirror.
- **`oswald resume` — first-class recovery from `blocked`.** Records
  `status.blocked_from`, re-runs the blocking gate with the same external
  fidelity that blocked the run, and leaves `blocked` via legal transitions;
  `oswald next` now recommends `resume` instead of dead-ending.
- **`oswald brief` — exec-readable stakeholder brief.** Deterministic read-only
  business-language status assembled from existing artifacts (what was asked,
  phase in plain terms, confirmed vs assumed vs open evidence, blockers and who
  unblocks them, known limitations). Writes `brief.md`; `--stdout-only` skips it.
- **`oswald audit` + tamper-evident audit ledger.** Every safety-relevant event is
  appended to `.oswald/audit.jsonl` with a rolling hash chain, so edits, reorders,
  insertions and deletions are detectable. Approval decisions, SQL safety verdicts
  (statement hash + leading keyword, never raw SQL), prompt-injection detections,
  PII redaction counts by kind, step outcomes, and warehouse fallbacks are all
  recorded. The command offers a readable summary/tail, `export --format json|csv`,
  and strict `verify` (exit 1 at the first broken link). Ledger writes are
  fail-open — a write failure warns once and the pipeline continues.
- **Real git `RepoProvider` with multi-forge PR support.** New `src/tools/repo/`
  mirrors the Snowflake CLI path: argv-only no-shell runner, SIGKILL timeout,
  bounded stdout, credential-scrubbed errors. Reads and writes run through the
  `git` CLI, every write routes through the `create_branch` / `commit` /
  `open_pull_request` approval action classes, and PRs open via the forge CLI
  selected from the remote URL (`gh`, `glab`, `az repos`). Pushing main/master or
  the PR base is structurally refused. Opt-in via a new `repo:` config block
  (default `mock`); a missing `git` binary warns and falls back to the mock.
- **`oswald next --explain` teach mode.** Explains *why* the recommended command
  is next: pipeline position, the input artifacts the step actually reads, what it
  writes, gating blockers/open questions, provider needs vs wiring, and which
  consent flags its side effects would require. Blocked states get the exact
  re-run command.
- **CI/headless `--json` step reports.** One stable machine-readable
  `oswald.step_report/v1` per step on stdout for every pipeline command
  (diagnostics on stderr), valid on every outcome (0/1/2), plus a draft-only
  GitHub Actions recipe that uploads `.oswald/` artifacts and fails loudly on
  `blocked`.
- **Ticket readiness gate.** Dimension-by-dimension readiness scorecard
  (`readiness.md` + state), an optional `policies.readiness.min_score` gate at
  clarify (blocked/exit 2), an auto-drafted `missing_information_request.md` keyed
  to failed dimensions, approval-gated posting, and `clarify --override-readiness`
  with a recorded decision.
- **Artifact drift checker.** Content hashes recorded at the `ArtifactManager`
  write point, an explicit upstream→downstream consumption-edge table, drift
  reporting in `oswald doctor`, and a hard gate at `ship` with an explicit
  override. Byte-identical re-runs clear stale gates.
- **Provider resolution report + `--strict-providers`.** Every pipeline command
  prints a one-line requested-vs-resolved provider table with fallback reasons.
  The new flag (and `policies.strict_providers` config key) turns any silent
  fallback (e.g. `snowflake` → `mock`) into a hard exit-1 failure with a
  remediation hint, before any artifacts are written. Default behavior unchanged.
- **`policies.autonomy` config.** A `level` (`draft_only` | `auto_safe`, default
  `draft_only`) plus a per-action `auto_approve` list using the existing
  action-class vocabulary. Existing configs stay valid and behave identically.
- **`docs/BACKLOG.md`** — ranked 40-feature candidate backlog, linked from
  `ROADMAP.md`.

### Changed

- **Workflow transitions are enforced twice, before any side effect.** A shared
  `assertLegalTransition(from, to)` guard now pre-flights `current → advancesTo`
  in `runTentacleCommand` (and the constant targets for `build` / `ship`) *before*
  the state write and before the tentacle executes, with `advanceWorkflow` keeping
  the same assertion as a backstop. Out-of-order commands now exit 1 with no
  provider calls, no artifacts, no project-tree writes, and state untouched —
  previously an out-of-order `clarify --post-comment --yes` had already posted the
  comment. Legitimate non-linear moves (intake bootstrap, skipping optional
  clarify/eda phases, finalizing from `ready_for_pr`, ship-over-documented
  -limitations from `blocked`) are enumerated explicitly and covered by tests.
- **Policy consent is a structural opt-in.** `runTentacleCommand` defaults to
  `consentMode: 'explicit'`, collapsing an absent approval argument to
  `yes: false`; only a deliberate `consentMode: 'policy'` leaves flag-less runs
  open to `policies.autonomy`, and `--draft` still wins.
- **`push` and `direct_push_to_protected_branch` are separate action classes.**
  The previous alias conflation would have made the default prohibition veto every
  feature-branch push.
- **`ARTIFACT_FILES.audit`** renamed from `audit.log` to `audit.jsonl`.

### Fixed

- **Ref-qualified push bypass.** A branch named `refs/heads/main` or `heads/main`
  passed `isSafeRefName` and dodged the exact-string protected-branch guard.
  `isSafeRefName` now refuses any leading `refs/` or `heads/` segment
  (case-insensitive), and pushes use a fully qualified
  `refs/heads/<branch>:refs/heads/<branch>` refspec.
- **`policies.prohibit: ["push"]` was silently ignored** — nothing consulted the
  push action class before the only real `git push`. `openPullRequest` now
  requires push approval before anything spawns, and `oswald.yml` policies are
  threaded into the repo providers.
- **Delivery never committed before opening a PR**, so `oswald pr <T> --open
  --yes` pushed a branch with zero commits ahead of base while `pr_summary`
  claimed the files were packaged. Delivery now commits the classified changed-file
  list (gated under the `commit` action class) and skips push+PR with actionable
  guidance when a fresh branch got no commit.
- **`push` can never receive policy-granted consent**, even with an emptied
  prohibit list — a hard floor in `ApprovalService` plus a Zod refinement
  rejecting `push` / `direct_push_to_protected_branch` entries in
  `policies.autonomy.auto_approve` at config load.
- **Audit coverage gaps.** `SensitiveFieldDetector` now carries the audit sink and
  records `redaction_applied` from the method tentacles actually persist through,
  and `SnowflakeWarehouseProvider` records `sql_executed` at its single runner
  seam (health probes, metadata queries, `EXPLAIN`, and executed EDA SQL).
- **Crash-truncated audit appends.** A partial final line is isolated by
  prepending a newline before the next append, and `verify()` classifies such junk
  as an aborted write (`truncatedLines`) rather than a permanent,
  tamper-indistinguishable break.
- **README** — resolved committed merge-conflict markers in the command table.

## [0.1.4] - 2026-07-11

### Added

- **Snowflake CLI EDA execution path (non-MCP).** `oswald eda --warehouse
  snowflake --execute` now runs Oswald's generated read-only EDA SQL against a
  real Snowflake account by shelling out to the `snow` CLI — mirroring the dbt
  runner's disciplined argv-only spawn (no `shell:true`, single `-q` argv
  element, `SIGKILL` timeout, captured stdout/stderr). New `src/tools/snowflake/`
  provides a `SnowflakeWarehouseProvider` (a structural clone of the mock: same
  read-only-before-spawn gate via `SqlSafetyValidator`, same PII redaction via
  `SensitiveFieldDetector`), a single `snow`-spawning `runner` that only ever
  emits the `sql` subcommand, a `detectSnow()` probe, and a `dialect:
  "snow" | "snowsql"` field (snowsql is a reserved stub). Metadata queries
  double-quote interpolated identifiers and single-quote string literals;
  parsed rows are defensively truncated client-side (`truncated=true`) on all
  paths. Only a connection **NAME** crosses the boundary — credentials live in
  `snow`'s own config and never touch argv/env/logs/artifacts.
- **New `eda` flags** — `--connection <name>`, `--warehouse-command <cmd>`, and
  `--query-timeout <ms>` (falling back to config). `--warehouse snowflake`
  attempts real execution when the `snow` CLI is detected and a connection is
  configured, else logs a clear warning and falls back to the deterministic mock;
  `--execute` requires an explicit connection.
- **New config** — a `warehouse` section (`command` default `snow`, optional
  `connection` NAME, `timeout_ms` default `120000`, `dialect` default `snow`).
  The row cap is reused from `policies.warehouse.max_result_rows` (not
  duplicated). `oswald doctor` now reports whether the `snow` CLI is available.

## [0.1.3] - 2026-06-23

### Changed

- **claude-code adapter emits plain slash commands instead of skills.** Each
  command is now rendered as a flat `.claude/commands/oswald-<command>.md` file
  (with `description` frontmatter) rather than a `.claude/skills/<cmd>/SKILL.md`
  directory. Skills are only surfaced in Claude Code's `/` menu subject to a
  description/model-invocation budget, so with many skills installed only some
  appeared; plain slash commands always appear in `/`. `oswald init --runtime
  claude-code --install` now writes `.claude/commands/oswald-*.md` (+ the
  `oswald-analyst` agent). The connector-aware body and safety gates are unchanged.

## [0.1.2] - 2026-06-22

### Added

- **`oswald init --install` flag** — for the `claude-code` runtime, writes
  Oswald's skills and the `oswald-analyst` subagent directly into the project's
  `.claude/` directory (`.claude/skills/oswald-<command>/SKILL.md` and
  `.claude/agents/oswald-analyst.md`) so the commands actually appear in Claude
  Code. Restart Claude Code, then invoke them as `/oswald-intake`, etc. Reference
  docs (`hooks/README.md`, `MCP-SETUP.md`) stay staged under `.oswald/`.

### Changed

- **claude-code adapter now emits modern Claude Code _skills_.** Each command is
  rendered as a directory with `SKILL.md` (`.claude/skills/oswald-<command>/SKILL.md`)
  using `name` / `description` / `disable-model-invocation: true` frontmatter
  (user-invoked only, matching Oswald's default-deny posture), replacing the
  deprecated `commands/oswald-<command>.md` layout. The connector-aware body,
  untrusted-evidence rule, and write-approval gates are unchanged.
- **`--version` is now read from `package.json`** so it can no longer drift from
  the published version (previously pinned to a literal `0.1.0`).

## [0.1.1] - 2026-06-22

First published release on npm. (0.1.0 was published then unpublished during
setup; per npm policy that version is permanently retired, so the initial
public release is 0.1.1. No functional difference from 0.1.0.)

Initial public MVP of Oswald the Analytical Octopus — a runtime-agnostic,
MCP-native, context-rot-resistant workflow layer for analytical-engineering AI
agents. The library never calls a live LLM; tentacles do deterministic work and
emit durable artifacts plus the next-step prompt.

### Added

- **Core engine** — config, durable `.oswald/` artifacts, explicit state
  (`state.yml`), workflow phases, logging/audit, `doctor`, and `compact`
  (summarize artifacts into `current_context.md` and archive noisy
  intermediates while preserving the decision log and evidence).
- **Eight tentacles**, each owning one pipeline phase: Requirements Intake,
  Clarification & Scoping, Context Gathering, Warehouse Discovery & EDA,
  Metric & Semantic Design, Model Planning & Implementation, Validation &
  Quality, and Delivery / PRs / Knowledge Capture.
- **14 CLI commands** (`oswald`): `init`, `doctor`, `intake`, `clarify`,
  `context`, `eda`, `design`, `plan`, `build`, `validate`, `pr`,
  `update-ticket`, `ship`, `compact`, and `next`.
- **Safety policy** — default-deny on every side effect (consent flag **and**
  policy permission both required), a read-only SQL safety gate, an
  untrusted-content / prompt-injection sanitizer, PII redaction, and gated
  action classes with a protected-branch push prohibition (Rule of Two).
- **Provider seam** — typed `ToolProvider` / per-domain provider interfaces with
  fully offline deterministic **mock providers**, plus a clearly-marked
  **MCP provider stub** (`src/tools/mcp/`) documenting the wiring plan.
- **Runtime adapters** — `oswald init --runtime <id>` generates command
  templates (no secrets written) for `generic`, `claude-code`, `codex`, and
  `gemini-cli`, with scaffolded `cursor` / `windsurf` support.
- **dbt integration** — `validate --dbt` runs a real `dbt build` + `dbt test`;
  `build --apply` scaffolds conservative, clearly-marked dbt model/test stubs.
  Ships a runnable `examples/dbt-project` (dbt-duckdb) and a guarded integration
  test.
- **Model-B connector-aware Claude Code prompts** — generated slash-command
  prompts instruct Claude Code to use the host's already-connected MCP
  connectors, keeping Oswald MCP-client-free in that runtime.

[Unreleased]: https://github.com/austinAbraham/oswald/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/austinAbraham/oswald/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/austinAbraham/oswald/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/austinAbraham/oswald/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/austinAbraham/oswald/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/austinAbraham/oswald/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/austinAbraham/oswald/releases/tag/v0.1.0
