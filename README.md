# Oswald — Open dbt Modeling Agent Harness

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12--3.13-blue.svg)](pyproject.toml)

An open-source, self-hostable harness that drives a dbt-modeling ticket through an
AI-agent pipeline — intake → EDA → planning → modeling → validation → PR — with human
approval gates, running **entirely inside your own environment**. Bring your own LLM, your
own MCP servers, your own warehouse. Nothing leaves the boundary except calls to endpoints
you configure.

It's for analytics engineers and analysts who turn business requirements into dbt models by
hand today, and for any org that wants a vendor-neutral, bring-your-own-everything
alternative to proprietary dbt agent tools.

> "Oswald" is the project codename; the product is the open dbt modeling agent harness.

## Core value

From a *well-specified* ticket, Oswald produces dbt models that build cleanly into a sandbox
schema, pass their tests, and arrive as a PR for a human to merge — with **zero manual SQL
writing**, running entirely inside your own boundary.

## Why it's different

- **Bring-your-own-everything.** Your LLM (via [LiteLLM](https://github.com/BerkeleyAI/litellm)),
  your warehouse, your MCP servers. Schema, EDA samples, and ticket text never leave your
  environment — a CI-verified egress-allowlist test asserts only configured endpoints are
  contacted, with telemetry off by default.
- **Outbound-only.** No public URL, ingress, TLS, or firewall hole required — deployable in
  locked-down / near-air-gapped VPCs.
- **Security built in, not bolted on — the Rule of Two.** No single agent role ever
  concentrates read-untrusted-text + touch-warehouse + post-comments powers:
  - intake/EDA uses a **read-only** warehouse role with no write or PR tools;
  - `dbt build` runs **sandbox-schema only**;
  - the git bot identity can **open PRs but cannot merge** (enforced by branch protection).
  These are enforced at the role/tool-set level, not by prompts.
- **Open and local.** Apache-2.0, uses the **local** `dbt-mcp` flavor (runs against
  dbt-core, no paid plan).
- **Deterministic where it should be.** Running dbt, opening the PR, and pinging reviewers
  are code, not LLM calls. Agents are used only for intake/EDA, planning, modeling, and
  review judgment.

## Status

🚧 **Early development.** Milestone 1 (the portable pack + secured single-ticket run) is
built and unit/integration-tested; the live end-to-end run against a real warehouse is the
current human-verification gate.

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M1** | The pack (config schema, dbt conventions, intake-spec, EDA/modeling skills), MCP wiring, `oswald init`/`validate` CLI, Rule-of-Two split, CI-verified data-residency egress test | ✅ built · live run pending |
| **M2** | Watcher + durable Postgres state (`docker compose up`), two-layer intake completeness check, restart-safe reconciler | ⬜ planned |
| **M3** | Full gated pipeline (plan → approve → model → validate → PR), acceptance-criteria reconciliation as a pre-merge gate, structured audit log | ⬜ planned |
| **M4** | Swappable warehouse/ticketing/git adapters, Helm chart, optional Temporal HA tier, docs site | ⬜ planned |
| **M5** | Optional inbound webhook to reduce poll latency (polling cursor stays source of truth) | ⬜ optional |

## Quickstart (M1 assisted run)

Requires Python 3.12–3.13 and [`uv`](https://docs.astral.sh/uv/).

```bash
# 1. Install dependencies into a pinned uv environment
uv sync

# 2. Scaffold a starter config + example ticket
uv run oswald init

# 3. Fill in config.yaml — secrets are referenced from env vars, never inline:
#    export SF_ACCOUNT=... MODEL_API_KEY=... BOT_TOKEN=...
#    (see config.example.yaml and docs/minimal-permissions.md)

# 4. Preflight: checks MCP connectivity, model reachability + a capability probe,
#    and repo/warehouse access — failing with a specific, actionable error.
uv run oswald validate

# 5. Drive one ready ticket end-to-end inside Claude Code via the gated skill:
#    run the /oswald-run skill on your ticket. It orchestrates read-only EDA,
#    modeling on a feature branch, a sandbox dbt build + grain tests, and opens a PR.
```

The pack is **runtime-agnostic** — the same config, conventions, intake-spec, and prompts
that power the assisted run in Claude Code today will be wrapped by the autonomous service
runtime in M2.

## Tech stack

Python 3.12 · dbt-core + [`dbt-mcp`](https://github.com/dbt-labs/dbt-mcp) (local flavor) ·
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) (M1 assisted runtime) ·
[Pydantic](https://docs.pydantic.dev/) · [LiteLLM](https://docs.litellm.ai/) (BYO-LLM
routing) · [`uv`](https://docs.astral.sh/uv/) · `pytest` + `pytest-socket` (the egress
invariant). The autonomous service runtime (M2) adds Pydantic-AI + DBOS on Postgres.

## Security & data residency

- **Rule of Two** is enforced architecturally — see [`docs/minimal-permissions.md`](docs/minimal-permissions.md)
  for the exact warehouse grants and git scopes required.
- **Data residency** is a CI-verified invariant: `tests/test_egress_allowlist.py` runs a
  scripted single-ticket harness under a deny-by-default socket policy and asserts only the
  configured endpoints are contacted, including a negative control that fails if a stray
  telemetry callback would leak off-boundary.
- Secrets are resolved from environment variables only; the config schema **rejects inline
  secrets** with a named validation error.

## Contributing

Issues and PRs welcome. This is early-stage; the [`/.planning`](.planning) directory
documents the roadmap, requirements, and design decisions if you want to understand where
it's headed.

## License

[Apache License 2.0](LICENSE).
