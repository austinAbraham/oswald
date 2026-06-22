# Security Policy

Oswald the Analytical Octopus is a workflow layer that drives AI agents through
analytical-engineering tasks (reading tickets, profiling warehouses, writing dbt
models, opening PRs). Because it sits between untrusted inputs (ticket text,
warehouse data) and side-effecting tools (warehouses, git, ticketing systems),
its safety posture is a core feature, not an afterthought.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), or
- email the maintainers at the address listed on the repository's profile.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal config / ticket / repro is ideal),
- the affected version or commit, and
- any suggested remediation if you have one.

We aim to acknowledge reports within a few business days, agree on a disclosure
timeline with you, and credit reporters who wish to be named once a fix ships.

### Scope

In scope: the Oswald library and CLI (`src/`), the safety policy layer, the
shipped config defaults, and anything that could cause Oswald to perform an
un-approved side effect, leak data outside the user's boundary, or follow
instructions embedded in untrusted content.

Out of scope: vulnerabilities in third-party MCP servers, the host agent
runtime, the warehouse, or the user's own configuration choices — though reports
that show Oswald failing to *defend* against a misbehaving dependency are in
scope.

## Safety Posture (Summary)

Oswald is deterministic by design: **the library never calls a live LLM and
never opens network connections in tests.** The model lives in the host agent
runtime; tentacles only produce structured evidence, prompts, and scaffolding.
This keeps the trust boundary inspectable.

The following controls are built in, not bolted on. Each maps to a module under
`src/core/policy/` or `src/core/approvals/`.

### 1. Default-deny human-in-the-loop for every write

(`src/core/approvals/`)

Every side-effecting action class — `ticket_update`, `create_ticket`,
`create_branch`, `commit`, `push`, `open_pull_request`, `execute_write_sql`, … —
is gated. A write proceeds **only** when **both** hold:

1. an explicit `yes` is supplied by the caller (e.g. a `--yes` flag — never a
   default), **and**
2. the configured policy permits that action class
   (`policies.require_approval_for` gates an action; `policies.prohibit` forbids
   it outright, e.g. `direct_push_to_protected_branch`).

In non-interactive / test mode there is no prompt: absent an explicit `yes`, the
action is **denied**. The autonomous runtime is therefore safe by construction.

### 2. Read-only warehouse access by default + SQL safety gate

(`src/core/policy/sql-safety.ts`)

Oswald only issues read-only SQL during EDA. A deterministic validator:

- allows a small allowlist of read-only leading keywords and **blocks everything
  else** (when in doubt, BLOCK — it is a policy gate, not a SQL parser),
- rejects multi-statement input, and
- enforces a result-row cap by injecting/capping a `LIMIT`.

Policy defaults (`policies.warehouse`) keep `read_only_by_default: true`, cap
sample and result rows, and prefer aggregates over raw rows.

### 3. PII detection & redaction (data residency / least-leak)

(`src/core/policy/sensitive.ts`)

A defense-in-depth masking layer detects sensitive field names (email, phone,
SSN, DOB, credit card, …) and redacts sensitive values out of artifact content
before it is persisted, so EDA samples and ticket text never leak raw PII into
the repo. Governed by `policies.privacy` (`mask_sensitive_values`,
`pii_allowed_in_artifacts: false`).

### 4. Untrusted-content sanitizer (prompt-injection trust boundary)

(`src/core/policy/external-content.ts`)

Text from Jira, Confluence, comments, and documents is **untrusted** — evidence
to reason about, never instructions to follow. Oswald wraps such text in a
clearly delimited, instruction-neutralized block and produces a report of any
prompt-injection patterns it detected, so downstream agents and humans see them
**flagged rather than silently obeyed**.

### 5. Stays inside the user's boundary

Oswald runs entirely inside the user's environment with their own runtime and
their own MCP servers. It ships no telemetry and makes no network calls except
to the MCP servers the user configures. No secrets are stored in the repo;
credentials are supplied via the host runtime / environment, not `oswald.yml`.

## Supported Versions

Oswald is pre-1.0 (`0.x`). Security fixes are applied to the latest `main` /
latest released `0.x`. Pin a version and watch releases for advisories.
