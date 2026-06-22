# MCP and the provider abstraction

Oswald is **MCP-native**: every external capability it needs — reading a ticket,
profiling a warehouse, opening a PR, fetching a design doc — is modeled as a
*tool provider*, and the intended transport for real deployments is the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io).

This document explains the concept, the provider abstraction Oswald actually
ships, what is supported today (mock providers) versus planned (real MCP
clients), and how each planned provider would be configured.

> **⚠️ No secrets in this repo, ever.** Oswald never writes credentials into
> generated files, config templates, or artifacts. `oswald.yml` describes *how to
> reach* an MCP server (command, args, URL) — it does **not** hold API tokens.
> Supply secrets through the host runtime's own configuration or environment
> (referenced as `env` keys), never by committing them. See
> [SECURITY_MODEL.md](./SECURITY_MODEL.md).

---

## What MCP is (in one paragraph)

MCP is an open, JSON-RPC-based protocol that lets a host (an AI agent runtime)
talk to *servers* that expose **tools** (callable functions), **resources**
(readable data), and **prompts**. A server runs either as a local subprocess
over **stdio** or as a remote endpoint over **streamable HTTP/SSE**. The host
lists the server's tools, then calls them by name with JSON arguments. Because
the contract is uniform, the same agent can drive Jira, GitHub, a warehouse, or
a document store without bespoke client code per system.

Oswald is designed to ride **the host runtime's own MCP connectors** (Claude
Code, Codex, Gemini CLI, etc.) rather than embedding its own. The runtime owns
the connection and the credentials; Oswald consumes the tools through its
provider interfaces.

---

## The provider abstraction

The pipeline code never imports a concrete transport. It depends only on the
typed interfaces in `src/tools/providers/types.ts`:

| Interface           | `kind`       | Representative methods                                                   |
|---------------------|--------------|-------------------------------------------------------------------------|
| `TicketProvider`    | `ticket`     | `getTicket`, `searchRelated`, `draftComment` (read), `postComment` (write) |
| `WarehouseProvider` | `warehouse`  | `listSchemas`, `listTables`, `describeTable`, `executeReadOnlySql`, `explainSql` |
| `RepoProvider`      | `repo`       | `currentBranch`, `changedFiles`, `createBranch` (write), `commit` (write), `openPullRequest` (write) |
| `DocumentProvider`  | `document`   | `search`, `fetchDocument`, `fetchWorkbook`                              |

Every provider also implements the base `ToolProvider` contract:
`name`, `kind`, `capabilities()`, `health()`, and a generic `invoke(toolName,
args, options)` escape hatch used by MCP passthrough and tests.

Two properties make this safe and swappable:

- **Write-classified capabilities.** Each `Capability` carries a `write: boolean`
  flag. Read methods (`draftComment`, `executeReadOnlySql`) never have side
  effects; write methods (`postComment`, `commit`, `openPullRequest`) take
  `InvokeOptions { yes?, reason? }` and are routed through the
  [ApprovalService](./SECURITY_MODEL.md#approval-gates) — they are **default-deny**.
- **Graceful degradation.** A command only receives the providers it needs
  (`src/cli/commands/_providers.ts`). Anything not wired is left `undefined`, and
  the tentacle degrades — e.g. EDA without a warehouse stays dry-run, delivery
  without a ticket provider stays draft-only. `oswald doctor` reports each
  provider's `health()` so the seams are visible.

The MCP seam slots in here unchanged: an MCP-backed provider is just another
`ToolProvider` implementation. The tentacles never know the difference.

---

## Supported today vs planned

### Supported (MVP): mock providers

The MVP ships **deterministic mock providers** under
`src/tools/providers/mock/` — `MockTicketProvider`, `MockWarehouseProvider`,
`MockRepoProvider`, `MockDocumentProvider`. They:

- run fully offline, with **no network and no secrets**, which is exactly what
  makes the data-residency story testable;
- back the example flows in `examples/` (sample ticket + `snowflake-schema.json`
  / `mock-eda-results.json` fixtures);
- exercise the **real** safety gates — the mock warehouse's `executeReadOnlySql`
  still runs through the SQL safety validator, and the mock ticket/repo writes
  still go through the approval gate. The mocks are not "fake safety," they are
  "real safety, fake data."

This is the tier that is GREEN and fully tested today.

### Planned (v1): real MCP clients

`src/tools/mcp/provider.ts` contains `McpToolProvider`, a **documented stub**
(it intentionally does not yet depend on `@modelcontextprotocol/sdk`). Every
method currently reports `unavailable - no MCP server configured`, so the system
degrades gracefully and `oswald doctor` shows the seam clearly. The file
documents the exact wiring steps for v1:

1. add `@modelcontextprotocol/sdk` as a dependency,
2. construct an MCP `Client` + transport in `connect()` from the server config,
3. implement `capabilities()` from `client.listTools()`,
4. implement `invoke()` via `client.callTool({ name, arguments })`,
5. map MCP tool names → `ProviderKind` and the write/read classification.

The planned real providers, and the official servers they would bind to:

| Provider (planned)             | `kind`      | Backing MCP / API | Official docs |
|--------------------------------|-------------|-------------------|---------------|
| **Atlassian Rovo** (Jira/Confluence) | ticket / document | Atlassian Rovo MCP server | <https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/> |
| **GitHub**                     | repo        | GitHub MCP server | <https://github.com/github/github-mcp-server> |
| **Snowflake (managed)**        | warehouse   | Snowflake managed MCP server / Cortex | <https://docs.snowflake.com/en/user-guide/snowflake-mcp-server> |
| **Microsoft Graph**            | document    | Microsoft Graph (Excel/SharePoint/OneDrive) | <https://learn.microsoft.com/en-us/graph/overview> |
| **dbt (local)**                | warehouse   | `dbt-mcp` (local CLI tool group) | <https://github.com/dbt-labs/dbt-mcp> |

> These rows describe *intended* bindings. In the current build they resolve to
> the mock providers (or `unavailable`) — see [ROADMAP.md](./ROADMAP.md).

---

## How to configure an MCP server (in principle)

MCP servers are declared in `oswald.yml` under `mcp_servers`. Keys are logical
names; values describe the transport. The schema
(`src/core/config/schema.ts`) is intentionally permissive (passthrough) so
transport-specific keys are preserved:

```yaml
mcp_servers:
  # stdio: launch a local server as a subprocess
  dbt:
    transport: stdio
    command: uvx
    args: ["dbt-mcp"]
    env:
      # Reference an env var the HOST provides — do NOT inline a secret.
      DBT_PROJECT_DIR: ${DBT_PROJECT_DIR}

  # streamable-http / SSE: a remote endpoint
  jira:
    transport: streamable-http
    url: http://localhost:9000/mcp
```

Configuration sketches per planned provider (consult each official doc above
for the authoritative, current setup):

- **Atlassian Rovo (Jira/Confluence)** — a remote MCP server; you authenticate
  through Atlassian's OAuth flow in your host runtime. Configure it as a
  `streamable-http` server pointing at the Atlassian remote MCP URL. Credentials
  live in the runtime's connector store, **not** in `oswald.yml`.
- **GitHub** — run the official GitHub MCP server (local Docker or the hosted
  remote server). For local stdio, point `command`/`args` at the server binary
  and provide a `GITHUB_TOKEN` via the host environment (an `env` reference, not
  a literal).
- **Snowflake (managed)** — Snowflake's managed MCP server is a remote endpoint;
  configure it as `streamable-http` with the account URL from the docs.
  Authentication is via Snowflake's mechanisms (key-pair / OAuth), supplied by
  the host — never committed.
- **Microsoft Graph** — accessed via a Graph MCP server or adapter; register an
  app in Entra ID, then supply the resulting credentials through the host
  runtime. Oswald only reads documents/workbooks through the `DocumentProvider`
  interface.

In all cases the rule is the same: **`oswald.yml` says where the server is and
which env vars to pass; the secrets themselves come from the host.**

---

## Why this design

- **One tool-calling path.** Tentacles call typed provider methods; whether the
  backing is a mock, a direct API client, or an MCP server is an
  implementation detail.
- **Runtime-agnostic.** Oswald rides the host's existing MCP connectors instead
  of duplicating credential management.
- **Safe by construction.** Write capabilities are flagged and gated at the
  abstraction boundary, so a new MCP provider inherits the approval and
  data-residency posture for free.
