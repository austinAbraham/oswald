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

- **Installs as a Claude Code plugin — bring your connectors, or use ours.** In the default
  **convenience posture** Oswald rides the MCP connectors you already have in Claude Code
  (Atlassian/Jira, GitHub, …) instead of making you stand up your own; a config `posture`
  flips it to a **locked-down**, all-local, egress-enforced mode for air-gapped orgs.
- **Bring-your-own-everything.** Your LLM (via [LiteLLM](https://github.com/BerriAI/litellm)),
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

🚧 **Early / experimental.** The harness is built and the test suite is green (131 tests),
but **the live end-to-end run has not yet been verified by a human** — if you run a real
ticket you're effectively the first. See [`SETUP.md`](SETUP.md) for what works today vs.
what's first-run, and please file what breaks.

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M1** | The pack (config schema, dbt conventions, intake-spec, EDA/modeling skills), MCP wiring, `oswald init`/`validate` CLI, Rule-of-Two split, CI-verified data-residency egress test | ✅ built · live run pending |
| **M1.1** | Claude Code plugin packaging, connector binding (ride host MCP connectors), `convenience`/`locked-down` posture, the 3-gate human-in-the-loop flow + approval-gated ticket write-back | ✅ built · live run pending |
| **M2** | Watcher + durable Postgres state (`docker compose up`), two-layer intake completeness check, restart-safe reconciler | ⬜ planned |
| **M3** | Full gated pipeline (plan → approve → model → validate → PR), acceptance-criteria reconciliation as a pre-merge gate, structured audit log | ⬜ planned |
| **M4** | Swappable warehouse/ticketing/git adapters, Helm chart, optional Temporal HA tier, docs site | ⬜ planned |
| **M5** | Optional inbound webhook to reduce poll latency (polling cursor stays source of truth) | ⬜ optional |

## Quickstart

**Full step-by-step (read this first): [`SETUP.md`](SETUP.md).** The short version:

```bash
# 1. Clone + install the CLI (Python 3.12–3.13 + uv)
git clone https://github.com/austinAbraham/oswald.git && cd oswald
uv sync
uv run pytest -q                 # sanity: all green

# 2. Scaffold + configure
uv run oswald init               # writes config.yaml + tickets/DEMO-1.md
#   edit config.yaml: pick `posture` (convenience default) + `bindings`
#   convenience mode: no model key / git token needed — it rides Claude Code's
#   model + your existing Atlassian/GitHub connectors. Warehouse = your dbt connection.

# 3. Preflight (names exactly what's missing)
uv run oswald validate
```

Then, in **Claude Code**:

```
/plugin marketplace add austinAbraham/oswald
/plugin install oswald@oswald
/oswald:run DEMO-1               # walk the 3 gates → a PR
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

Issues and PRs welcome — this is early-stage and the live path is unproven, so bug reports
from real runs are especially useful. See [`SETUP.md`](SETUP.md) for how to try it and what
to expect. When filing, include your `posture`/`bindings` and the `oswald validate` output
(it's secret-free by design).

## License

[Apache License 2.0](LICENSE).
