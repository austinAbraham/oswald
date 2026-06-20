# Setup & install

> **Status: early / experimental.** The code is built and the test suite is green (131 tests), but the **live end-to-end run has not yet been verified by a human** — if you run a real ticket, you're effectively the first. Expect rough edges and plan to iterate. Please file what breaks.

Oswald has two surfaces, and you set them up separately:

1. **The Claude Code skill** (`/oswald:run`) — drives a ticket through the gated pipeline. Installed as a Claude Code plugin (or used straight from a clone in "pack mode").
2. **The `oswald` CLI** (`init` / `validate`) — scaffolds and preflights your config. Run from a clone with `uv`.

---

## Prerequisites

- **Python 3.12 or 3.13** and [`uv`](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- **Claude Code** (the skill runs inside it)
- **A dbt project + a warehouse** (Snowflake is the reference). Oswald drives *your* dbt project; it doesn't create one.
- **Optional but recommended:** the **Atlassian/Jira** and **GitHub** connectors already set up in Claude Code — Oswald can ride those instead of you wiring your own MCP servers (this is the "convenience posture").

---

## 1. Clone and install the CLI

```bash
git clone https://github.com/austinAbraham/oswald.git
cd oswald
uv sync           # creates the pinned Python 3.12 env
uv run oswald --help
```

> The `oswald init`/`validate` CLI currently runs from the clone via `uv run oswald …` (it scaffolds from the bundled `config.example.yaml`). A standalone/global install isn't packaged yet.

Sanity check that the build is sound:

```bash
uv run pytest -q     # expect: all green
```

## 2. Install the Claude Code plugin

In Claude Code:

```
/plugin marketplace add austinAbraham/oswald
/plugin install oswald@oswald
```

This registers the skills (`oswald:run`, `oswald:eda`, `oswald:model`) and the bundled MCP server config. 

**Pack-mode alternative (no install):** just open the cloned `oswald/` repo in Claude Code — the skills under `.claude/skills/` are auto-discovered and run as `/oswald-run` (note: `oswald-run`, not `oswald:run`, in pack mode).

> Known upstream issue: env-var (`${ENV}`) expansion inside a *plugin-bundled* `.mcp.json` can be flaky on some Claude Code versions ([#9427](https://github.com/anthropics/claude-code/issues/9427)). If MCP servers don't pick up your env vars after installing the plugin, use pack mode (run from the clone), where the project-scope `.mcp.json` expansion is reliable.

## 3. Scaffold your config

From your dbt repo (or anywhere you want to run from):

```bash
uv run oswald init --dir .
```

This writes `config.yaml` (from the template) and `tickets/DEMO-1.md` (an example *ready* ticket). Open `config.yaml` and fill it in — the comments walk you through every field.

## 4. Configure: posture, connectors, secrets

The config has two ideas that decide how much you have to wire up:

**`posture:`** — `convenience` (default) or `locked-down`.
- `convenience` — ride the connectors Claude Code already has (Jira, GitHub) and use Claude as the model. Trust boundary = "Anthropic + the connectors you chose." Lowest friction.
- `locked-down` — everything runs as local servers + a self-hosted model, and the egress allowlist is enforced. For air-gapped / regulated setups.

**`bindings:`** — which MCP server backs each role (`warehouse`, `ticketing`, `git`). Pick a `profile` (`dbt-local` / `github` / `atlassian` / `custom`) or map roles individually. To ride a host connector, point a role at it and map the tool names, e.g.:

```yaml
bindings:
  profile: dbt-local
  warehouse:
    server: dbt-eda          # the local dbt-mcp (always local — see "known limitations")
  ticketing:
    server: atlassian        # ride your existing Atlassian connector
    tool_map:
      get_issue: getJiraIssue
      search_issues: searchJiraIssues
  git:
    server: github           # ride your existing GitHub connector
    tool_map:
      open_pr: create_pull_request
```

**Point dbt at your project.** The `dbt-eda` / `dbt-build` MCP servers in the config launch
`dbt-mcp` against the dbt project at `DBT_PROFILES_DIR` (default `./dbt_project`). Change that
to your real dbt project's profiles location (or run from a directory where it resolves), so
the EDA/build tools actually see your models and warehouse connection.

**Secrets — only export what your setup actually needs:**
- `MODEL_API_KEY` — **not needed in convenience mode** (the run uses Claude Code's model). Only for `locked-down` / a self-hosted model endpoint.
- `BOT_TOKEN` (git) — **not needed if `git` rides your host GitHub connector** (it carries its own auth). Only for a self-run git MCP.
- `SF_ACCOUNT` / `SF_RO_USER` / `SF_SANDBOX_USER` / `SF_WH` — the warehouse credentials the local `dbt-mcp` uses. This is just **your existing dbt connection** — if your `dbt_project/profiles.yml` already connects, you're set. Each developer typically has their own sandbox schema; point `sandbox.schema_name` at yours.

See [`docs/minimal-permissions.md`](docs/minimal-permissions.md) for the exact warehouse grants and git scopes.

## 5. Preflight

```bash
uv run oswald validate
```

`validate` probes MCP connectivity, the warehouse/repo access, the connector bindings, and the Rule-of-Two checks (it refuses to let any write/merge tool reach a read agent). **Every failure names the exact misconfiguration** — read the FAIL lines and fix what they point at.

A couple of things to expect on first run: `validate` actually **launches the `dbt-mcp` servers via `uvx`** (the first run downloads `dbt-mcp` from PyPI, so it needs `uvx` + initial network access), and `dbt-mcp` prints a lot of `INFO`/`WARNING` log lines — the actual `[PASS]` / `[WARN]` / `[FAIL]` report is at the **end** of the output. Run it from your dbt project (so `DBT_PROFILES_DIR` resolves) or the dbt tools report themselves disabled.

> In this early version `validate` still probes the `model:` endpoint even in convenience mode, so if you haven't configured a separate model endpoint you'll see the model probe FAIL — that's a known rough edge we're refining (the model key should be conditional on posture). The skill run in step 6 uses Claude Code's model and works regardless.

## 6. Run a ticket

In Claude Code, from your dbt repo:

```
/oswald:run DEMO-1        # plugin mode  (or /oswald-run DEMO-1 in pack mode)
```

It walks five stages with three human gates:

1. **Intake + EDA** (read-only) → proposes a refined spec → **you approve** (→ writes the refined spec back to the ticket)
2. **Plan** → **you approve** before any code/build
3. **Model + build** (into your sandbox schema) + dbt tests → **you approve** before it opens the PR
4. **Opens a PR** — and stops. It never merges; that's you.

---

## What works today vs. what's first-run

- ✅ **Built & tested with mocks:** the CLI, config schema + bindings + posture, the validate probes, the Rule-of-Two enforcement, the data-residency egress test, the gated-flow + spec-level write-back logic.
- 🧪 **Not yet verified live (you may be first):** the plugin install riding a real Atlassian/GitHub connector, and a full ticket → real Snowflake build → real PR. The mocks prove the wiring; only a live run proves the integration.

## Known limitations (early)

- **The CLI runs from a clone** (`uv run oswald`), not a standalone install yet.
- **Warehouse is pinned to local `dbt-mcp`.** Querying Snowflake directly via a Snowflake MCP/connector for EDA/validation is a planned refinement — today the warehouse read+build both go through `dbt-mcp` (which still queries your real Snowflake).
- **Convenience-mode credential handling is being tightened** — `validate` over-asks for a model endpoint even when the run will use Claude; treat a model-probe FAIL as expected if you haven't set one.
- **Plugin-bundled `${ENV}` expansion** can be flaky (upstream #9427) — pack mode is the reliable path.

## Reporting

This is moving fast and the live path is unproven — please open an issue with what you tried, your `posture`/`bindings`, and the `oswald validate` output (it's secret-free by design).
