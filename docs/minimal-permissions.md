# Minimal Permissions (SEC-05 draft)

Oswald's security model is the **Rule of Two**: never concentrate the powers to
*read untrusted text*, *touch the warehouse*, and *write the repo / merge* in one
identity. This document lists the **exact, minimal** Snowflake grants and GitHub
token scopes Oswald needs, and explains why the "bot can open a PR but cannot
merge" guarantee is enforced by **branch protection**, not a token scope.

Everything below is config **you (the operator) apply** inside your own boundary.
Oswald ships no privileged defaults — it consumes the roles/scopes you grant.

Required environment variables (all secrets are env-only — never inline in
`config.yaml`; see `config.example.yaml`):

| Env var | Purpose |
|---------|---------|
| `SF_ACCOUNT` | Snowflake account identifier |
| `SF_RO_USER` | EDA user, attached to the `OSWALD_READ_ONLY` role |
| `SF_SANDBOX_USER` | build user, attached to the `OSWALD_SANDBOX` role |
| `SF_WH` | Snowflake warehouse |
| `MODEL_API_KEY` | BYO-LLM model endpoint key (LiteLLM-routed) |
| `BOT_TOKEN` | GitHub bot token (PR-only identity — see below) |

---

## 1. Snowflake roles (the warehouse half of the Rule of Two)

Two roles realise the read-only-EDA vs sandbox-build split at the **warehouse-role
level** — the load-bearing backstop that holds even if every other layer (dbt
target, dbt-mcp tool whitelist, prompt) were bypassed.

### `OSWALD_READ_ONLY` — the EDA path (SELECT only, no write anywhere)

Used by the `dbt-eda` dbt-mcp instance (default target `eda_ro`). It can read the
warehouse to profile sources for EDA and **cannot write anything** — no `CREATE`,
`INSERT`, `UPDATE`, or `DELETE` on any schema.

```sql
-- READ-ONLY role for EDA (holds untrusted ticket + warehouse read, never write)
CREATE ROLE IF NOT EXISTS OSWALD_READ_ONLY;
GRANT USAGE ON WAREHOUSE <wh> TO ROLE OSWALD_READ_ONLY;
GRANT USAGE ON DATABASE ANALYTICS TO ROLE OSWALD_READ_ONLY;
GRANT USAGE ON ALL SCHEMAS IN DATABASE ANALYTICS TO ROLE OSWALD_READ_ONLY;
GRANT SELECT ON ALL TABLES IN DATABASE ANALYTICS TO ROLE OSWALD_READ_ONLY;
GRANT SELECT ON FUTURE TABLES IN DATABASE ANALYTICS TO ROLE OSWALD_READ_ONLY;  -- new tables
-- (NO CREATE / INSERT / UPDATE / DELETE anywhere)
```

### `OSWALD_SANDBOX` — the build path (write ONLY the sandbox schema)

Used by the `dbt-build` dbt-mcp instance (target `sandbox`). It can `dbt build`
into the dedicated `ANALYTICS.OSWALD_SANDBOX` schema **and nowhere else**, and can
`SELECT` from prod to model against it. It has **no write grant on any prod
schema**. The `generate_schema_name` override
(`dbt_project/macros/generate_schema_name.sql`) forces every build into
`OSWALD_SANDBOX` as a second backstop; `clone` is omitted from the build tool
whitelist (highest blast radius).

```sql
-- SANDBOX write role for build (write the sandbox schema only)
CREATE ROLE IF NOT EXISTS OSWALD_SANDBOX;
GRANT USAGE ON WAREHOUSE <wh> TO ROLE OSWALD_SANDBOX;
GRANT USAGE ON DATABASE ANALYTICS TO ROLE OSWALD_SANDBOX;
CREATE SCHEMA IF NOT EXISTS ANALYTICS.OSWALD_SANDBOX;
GRANT ALL ON SCHEMA ANALYTICS.OSWALD_SANDBOX TO ROLE OSWALD_SANDBOX;     -- write here only
GRANT SELECT ON ALL TABLES IN DATABASE ANALYTICS TO ROLE OSWALD_SANDBOX; -- read prod to model
GRANT SELECT ON FUTURE TABLES IN DATABASE ANALYTICS TO ROLE OSWALD_SANDBOX;
-- (NO write grants — CREATE / INSERT / UPDATE / DELETE — on any prod schema)
```

Attach `SF_RO_USER` to `OSWALD_READ_ONLY` and `SF_SANDBOX_USER` to
`OSWALD_SANDBOX`. Keeping the two users distinct is what makes the split real.

---

## 2. GitHub bot identity (the repo half of the Rule of Two)

The bot opens a PR from `oswald/ticket-<id>` and pings reviewers. It must be able
to **push a branch and open a PR**, and it must be **unable to merge**.

### Token scopes (fine-grained PAT, M1)

Grant the bot's fine-grained Personal Access Token exactly these repository
permissions on the target repo — nothing broader:

| Permission | Level | Why |
|------------|-------|-----|
| `contents` | **write** | push the feature branch `oswald/ticket-<id>` |
| `pull-requests` | **write** | open the PR and request reviewers |

No `administration`, no `workflows`, no org-level scopes.

### The no-merge guarantee is BRANCH PROTECTION, not a token scope

> **Critical:** GitHub fine-grained PATs **cannot separate "create a PR" from
> "merge a PR"** — there is no scope that grants one without the other. (Verified:
> GitHub community discussion #182732.) Granting `pull-requests: write` so the bot
> can *open* a PR inherently lets the token's holder *merge* via the API **unless
> branch protection forbids it.**

Therefore the no-merge control is **branch protection**, which is **repo config the
user applies** (Oswald cannot ship it for you):

1. Protect the `protected_branch` (e.g. `main`) with **Require a pull request
   before merging** + **Require approvals** (>= 1 human review).
2. **Do NOT add the bot to the bypass-allowed actors list.** If the bot can bypass
   required reviews, the guarantee is void.
3. Optionally require status checks (sandbox `dbt build`, sqlfluff) to pass.

With branch protection on and the bot excluded from bypass, the bot can open a PR
but the API rejects any merge attempt — merge stays a **human-only gate** (the
final, irreversible Rule-of-Two step). This is exactly the contract the
`mock_github_api` test models: `open_pull_request` succeeds, `merge_pull_request`
raises.

### Validate-time check (implemented in plan 05)

`oswald validate` checks that the bot can open a PR against the target repo and
**WARNs when branch protection is absent or lists the bot as a bypass actor**
(SEC-03 gray area). A warning, not a hard failure, because branch protection is the
user's repo policy — Oswald surfaces the risk; it does not own the setting.

### PAT now, GitHub App later

A fine-grained **PAT** is the simpler path for M1. A **GitHub App** bot identity
(cleaner identity, short-lived installation tokens) is the M4 portability story —
the enforcement model (branch protection as the no-merge control) is identical
either way.

---

## 3. BYO-LLM endpoint

The model endpoint key (`MODEL_API_KEY`) authenticates to your configured,
self-hosted LiteLLM / model gateway only. Telemetry is off by default
(`callbacks: []`, `turn_off_message_logging: true`) so no prompt, EDA sample, or
ticket text leaves the boundary — asserted by the egress-allowlist test (SEC-04).

---

## 4. Connector binding — local vs borrowed host connectors

Oswald binds **logical roles** (warehouse-read, warehouse-build, ticketing,
git/PR) to **concrete MCP servers**. A binding is either:

- **local** — a server Oswald launches inside your boundary (the bundled
  `dbt-mcp` instances `dbt-eda`/`dbt-build`, or a local warehouse/ticketing/git
  MCP you point it at). Data stays in your environment; you scope the server's
  tools.
- **borrowed** — a connector already configured in the **host** (Claude Code's
  own GitHub or Atlassian/Rovo connector). It is convenient (no extra server to
  run) but Oswald **cannot disable its destructive tools at the source** — the
  host owns the tool surface.

**The warehouse role always defaults to local** (D-05, D-08): the warehouse half
of the Rule of Two is the residency-critical path, so it is never bound to a
hosted/off-boundary connector (e.g. a managed Snowflake MCP). Only *peripheral*
roles (ticketing, git, docs) may be borrowed.

---

## 5. Posture — `convenience` vs `locked-down`

A single `posture` setting names the trust boundary you accept:

| Posture | Peripheral connectors (tickets/git/docs) | Warehouse + model SQL | What it enforces |
|---------|------------------------------------------|-----------------------|------------------|
| `convenience` | May be **borrowed** host connectors; their egress is **documented**, not blocked (their data already lives in that SaaS) | **Stays local** — unchanged from M1 (D-08) | Documents the boundary; warehouse/model path still local-only |
| `locked-down` | Local servers only | **Stays local** | Enforces local MCP servers + a self-hosted model endpoint + the full egress allowlist; a non-allowlisted peripheral host is BLOCKED |

The load-bearing invariant (D-08): **the warehouse-data-stays-local guarantee
holds in BOTH postures.** `convenience` relaxes only peripheral systems whose
data already lives in that SaaS; it never relaxes the warehouse or model-SQL
path. A leak of warehouse data to a non-configured host still raises
`SocketConnectBlockedError` under either posture (asserted by the SEC-04 egress
negative control).

---

## 6. Borrowed-connector Rule-of-Two backstop

A borrowed host connector exposes **un-scopable destructive tools** — Oswald
cannot turn them off at the source (Pitfall 5). The Rule-of-Two over borrowed
tools is enforced in depth:

1. **Per-fork `allowed-tools` allowlists** (primary): the `oswald-eda` fork holds
   only read tools; ticket *write* belongs only to the deterministic write-back
   glue, never the EDA fork (D-10).
2. **`oswald validate` binding probe** (D-06): connects each bound server,
   `list_tools()`, and **WARNs naming** any un-scopable borrowed destructive tool
   reachable by an agent (e.g. `mcp__github__merge_pull_request`,
   `mcp__atlassian__editJiraIssue`). It is a warning, not a hard failure —
   borrowed-connector scoping is the host's policy; Oswald surfaces the risk.
3. **`.claude/settings.json` deny backstop** (always-on net): the borrowed
   destructive tools are denied project-wide as defense-in-depth —
   `mcp__github__merge_pull_request` (GitHub connector merge) and the Atlassian
   write tools `mcp__atlassian__editJiraIssue` / `createJiraIssue` /
   `transitionJiraIssue` / `addCommentToJiraIssue`. These sit alongside the M1
   LOCAL-git baseline (`mcp__git__merge_pull_request`, `mcp__git__merge`,
   `mcp__dbt-build__clone`, `mcp__ticketing__delete_issue`).

Merge stays a **human-only gate behind branch protection** (SEC-03) — borrowed or
local, Oswald never holds a merge tool in any role.

> **Plugin-mode caveat (#9427):** when Oswald is installed as a Claude Code
> plugin, a host bug in plugin-bundled `.mcp.json` env-var expansion
> (anthropics/claude-code#9427) is version-dependent and out of CI scope. **Pack
> mode** (clone the repo, project-scope `.mcp.json` with verified `${VAR}` /
> `${VAR:-default}` expansion) is the residency-guaranteed path; verify
> plugin-mode secret delivery at the live human-verify checkpoint on your
> installed Claude Code version.

---

*SEC-05 draft — Phase 1 (M1) + Phase 1.1 binding/posture/borrowed-connector
sections. The full minimal-permissions doc with multi-warehouse and multi-git
adapter grants is an M4 deliverable.*
