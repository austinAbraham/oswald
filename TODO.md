# Oswald TODO / backlog

Backlog items not yet built. See [docs/ROADMAP.md](./docs/ROADMAP.md) for the
phased view.

## Model A — CLI-owned MCP client (v1 backlog)

**Status:** backlog. **Model B ships first.**

### What
A Model Context Protocol client owned by the Oswald **CLI itself**, so the
pipeline can fetch external data and perform gated actions from a plain terminal
or any runtime that does *not* expose host MCP connectors.

### Why
Today Oswald ships **Model B**: when it runs *inside* Claude Code, the generated
slash-command prompts instruct Claude to use the **host's own** MCP tools
(`mcp__atlassian__*`, `mcp__github__*`, a warehouse connector). That keeps Oswald
MCP-client-free in that runtime. But it only works where the host already has
connectors. Model A makes Oswald **runtime-agnostic**: the CLI can connect to MCP
servers directly so terminal / CI / non-Claude-Code users get the same pipeline.

### Scope
- Add an MCP client (e.g. `@modelcontextprotocol/sdk`) behind the existing
  provider interfaces in `src/tools/` — no tentacle code changes.
- Connect to, behind the provider abstraction:
  - **Atlassian** (Jira / Confluence) — ticket + document providers.
  - **GitHub** — repo provider (branches, commits, PRs).
  - **Snowflake (managed)** — read-only warehouse provider.
  - **Microsoft Graph** — document/workbook provider.
- Map MCP tool names → provider kind + write classification (reuse the
  Rule-of-Two / verb-stem write detection).
- Every call stays wrapped by the SQL-safety gate, PII/secret redaction, and the
  default-deny approval service. Untrusted content from any server is sanitized
  and treated as evidence, never instructions.
- Secrets supplied by the operator via env / secret manager — never written by
  Oswald.

### Sequencing
1. **Model B** — connector-aware Claude Code prompts. ✅ shipped.
2. **Model A** — CLI-owned MCP client. ⬜ this item.
