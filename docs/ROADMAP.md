# Oswald roadmap

Honest status of what is built versus planned. The MVP is GREEN and fully tested;
v1 and v2 are forward-looking.

## MVP — done ✅

The current build delivers the full **runtime-agnostic, MCP-native,
context-rot-resistant** workflow layer, running deterministically with **no live
LLM and no network in tests**.

- **Core** — config (Zod-validated `oswald.yml` with generous defaults), state
  machine, artifact manager (canonical filenames), workflow engine.
- **Safety policy** (`src/core/policy/`) — read-only SQL safety validator
  (allow/deny lists, comment stripping, multi-statement rejection, LIMIT
  injection); PII redaction (sensitive-column detection, value-pattern scrubbing,
  the inline-secret and phone fixes); untrusted-content sanitizer
  (delimited block + injection detection + neutralization); **default-deny**
  approval service over the 8 side-effecting action classes.
- **Tool providers** — typed provider abstraction (ticket / warehouse / repo /
  document) with write-classified capabilities; **deterministic mock providers**
  for all four kinds; an MCP provider **stub** documenting the wiring seam.
- **Doctor** — environment/config/state/provider-health/policy diagnostics.
- **All 8 tentacles** — intake, clarification, context, eda, design, planning,
  validation, delivery (deterministic heuristics; no live model).
- **All CLI commands** — `init`, `doctor`, `intake`, `clarify`, `context`, `eda`,
  `design`, `plan`, `build`, `validate`, `pr`, `update-ticket`, `ship`, `next`,
  `compact` (see [CLI.md](./CLI.md)).
- **Runtime adapters** — `generic`, `claude-code`, `codex`, `gemini-cli`
  supported; `cursor`, `windsurf` scaffolded (see [RUNTIMES.md](./RUNTIMES.md)).
- **Examples** — sample retention ticket + mock warehouse fixtures under
  `examples/`.
- **Quality bar** — full test suite green; typecheck, build, and lint clean.

**MVP boundary:** providers are mocks. EDA against "snowflake" falls back to the
mock; tentacles are deterministic heuristics, not LLM calls. This is deliberate —
it makes the safety and data-residency guarantees testable end-to-end offline.

## v1 — real MCP clients & richer dbt 🔜

Replace the mock tier with real connectors by wiring the documented MCP seam
(`src/tools/mcp/provider.ts`), without changing any tentacle code.

- **Model A — CLI-owned MCP client** — a runtime-agnostic MCP client owned by the
  Oswald CLI itself, so the pipeline works from a plain terminal (or any non-MCP
  runtime) without depending on a host's connectors. It connects to Atlassian,
  GitHub, the managed Snowflake MCP, and Microsoft Graph servers behind the
  existing provider interfaces (`src/tools/`), with the SQL-safety, redaction, and
  default-deny approval gates wrapping every call. **Model B (connector-aware
  Claude Code prompts) ships first**; Model A is the runtime-agnostic complement.
  Tracked in [`TODO.md`](../TODO.md).
- **Real MCP client** — add `@modelcontextprotocol/sdk`; implement `connect()`,
  `capabilities()` from `listTools()`, and `invoke()` via `callTool()`; map MCP
  tool names → provider kind + write classification.
- **Atlassian Rovo** (Jira/Confluence) — real ticket + document providers.
- **GitHub** — real repo provider (branches, commits, PRs) via the GitHub MCP
  server.
- **Snowflake (managed)** — real read-only warehouse provider via the managed
  Snowflake MCP server; the SQL safety gate continues to wrap every query.
- **Microsoft Graph** — real document/workbook provider (Excel/SharePoint/OneDrive).
- **Richer dbt** — drive dbt parse/build/test through the local `dbt-mcp` tool
  group so `oswald validate --dbt` runs against a real project.
- **Live model integration** — let tentacles call the host runtime's model for
  the judgment-heavy steps (intake completeness, design, plan, review), keeping
  deterministic steps deterministic.

See provider docs URLs in [MCP.md](./MCP.md).

## v2 — breadth 🔭

- **BI lineage** — trace models to downstream dashboards.
- **Catalogs** — integrate data catalogs for richer context gathering.
- **Slack / Teams** — notifications and approval prompts in chat.
- **Semantic layer** — emit/consume semantic-layer metric definitions.
- **Multi-ticket** — concurrent ticket pipelines with isolation.
- **Team policies** — per-team approval/redaction policy profiles.
- **Audit UI** — a viewer over the structured audit log.
