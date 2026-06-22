# Assumptions

The assumptions made while building Oswald the Analytical Octopus. They are
recorded so reviewers can see what was decided implicitly and where the build
diverges from the broader project's earlier (Python-stack) framing.

## Stack & platform

- **TypeScript / Node (ESM).** The implementation is TypeScript on Node **>= 22**
  (`package.json` `engines`), shipped as ESM (`"type": "module"`). This is a
  deliberate divergence from the project's earlier Python/Pydantic-AI framing:
  this codebase is a runtime-agnostic workflow *layer* meant to ride a host
  agent runtime's MCP connectors, not a standalone Python agent service.
- **ESM import conventions.** Relative imports end in `.js`; `import type` is used
  for type-only imports (`verbatimModuleSyntax` on). Assumed throughout.
- **Zod for schemas.** Config and structured contracts use Zod, with generous
  defaults so a minimal `oswald.yml` (just `project.name`) parses into a complete
  config.
- **Commander for the CLI.** Command/option parsing uses `commander`.

## Determinism & agents

- **Deterministic, heuristic tentacles.** All 8 tentacles are deterministic
  heuristics in the MVP — **no live LLM call and no network**. This makes the
  pipeline, the safety gates, and the data-residency story testable end-to-end
  offline. Live-model integration is deferred to v1.
- **Tests never touch the network or a live model.** Assumed as a hard
  invariant for the suite.

## Providers & data

- **Mock providers for the MVP.** The concrete providers are the local mocks
  (ticket / warehouse / repo / document). Real MCP-backed providers are a v1
  task; the `McpToolProvider` stub documents the seam and reports `unavailable`
  until wired.
- **Warehouse mock fallback.** `--warehouse snowflake` falls back to the mock
  warehouse provider in this tier (no offline Snowflake driver), so the EDA
  read-only gate is still exercised deterministically.
- **Write classification by intent, not enumeration.** Provider capabilities
  carry an explicit `write` flag rather than relying on a hardcoded list of
  tool names; the same posture applies to MCP tools when wired.

## Artifacts & state

- **Fixed per-phase artifact filenames.** Each phase writes a stable set of
  named artifacts under the artifact dir (default `.oswald/`). The actual set the
  tentacles emit is:
  - **intake** → `intake.md`, `requirements.md`, `acceptance_criteria.md`
  - **clarify** → `open_questions.md`, `scope_risks.md`, `clarification_comment.md`
  - **context** → `context_pack.md`, `existing_assets.md`, `lineage_notes.md`, `source_inventory.md`
  - **eda** → `eda_report.md`, `grain_analysis.md`, `join_analysis.md`, `data_quality_findings.md`, plus per-query files under `sql_queries/`
  - **design** → `metric_spec.yml`, `semantic_model_plan.md`, `dimension_contracts.yml`
  - **plan** → `model_plan.md`, `implementation_plan.md`, `changed_files.md`
  - **build** → `build_preview.md`, `changed_files.json`
  - **validate** → `validation_report.md`, `test_results.md`, `reconciliation_report.md`, `known_limitations.md`
  - **pr / update-ticket / ship** → `pr_summary.md`, `jira_update.md`, `release_notes.md`, `handoff_notes.md`, `decision_log.md`
  - **compact** → `current_context.md` (intermediate artifacts moved to `archive/`)

  Plus `state.yml` for lifecycle state. The full filename→key map for the
  current run is recorded in `state.yml` under `artifacts:`.
- **Audit trail is currently console-only.** Every command logs structured,
  prefixed lines (`[oswald]`, `[oswald:ok]`, `[oswald:warn]`, `[oswald:error]`)
  to stdout/stderr. A persisted `audit.log` file is **not** written in this tier;
  the `audit` key reserved in `ARTIFACT_FILES` is a forward-looking placeholder.
- **State drives navigation.** A single linear workflow state machine (with a
  recoverable `blocked` side state) powers `oswald next` and the "suggested next
  command" output. The CLI owns ticket identity; tentacles own phase transitions.

## Safety posture

- **Default-deny for all writes.** Side effects require an explicit consent flag
  *and* a permitting policy; absent consent, deny. `--draft` always overrides
  consent. Assumed safe-by-construction for any autonomous use.
- **Read-only EDA only.** Oswald only issues read-only SQL during EDA; the
  validator blocks everything outside a small allowlist and rejects
  multi-statement input.
- **Redaction is defense-in-depth, not a guarantee.** PII/secret masking is
  heuristic and layered on top of the read-only/aggregate-preferring policy; it
  is assumed to reduce, not eliminate, leakage risk.
- **No secrets in the repo.** Config, generated runtime templates, and artifacts
  never contain credentials. `oswald.yml` references env vars supplied by the
  host. Assumed and enforced as a hard rule.

## Runtime integration

- **Runtime-agnostic, generated assets.** Runtime adapters generate
  command-prompt files under `.oswald/runtime/<id>/`; Oswald's core behavior does
  not change per runtime. Unknown runtime ids fall back to `generic`.
- **Host owns MCP credentials.** Oswald is assumed to ride the host runtime's
  existing MCP connectors; it does not manage or store the credentials itself.
