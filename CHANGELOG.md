# Changelog

All notable changes to `@oswald-ai/oswald-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-22

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

[Unreleased]: https://github.com/austinAbraham/oswald/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/austinAbraham/oswald/releases/tag/v0.1.0
