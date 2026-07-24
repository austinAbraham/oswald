# Changelog

All notable changes to `@oswald-ai/oswald-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/austinAbraham/oswald/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/austinAbraham/oswald/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/austinAbraham/oswald/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/austinAbraham/oswald/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/austinAbraham/oswald/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/austinAbraham/oswald/releases/tag/v0.1.0
