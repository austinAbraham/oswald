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

*SEC-05 draft — Phase 1 (M1). The full minimal-permissions doc with multi-warehouse
and multi-git adapter grants is an M4 deliverable.*
