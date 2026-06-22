# Contributing to Oswald

Thanks for your interest in Oswald the Analytical Octopus — a runtime-agnostic,
MCP-native, context-rot-resistant workflow layer for analytical-engineering AI
agents. This guide covers local setup, how the codebase is organized, how to
extend it, and the safety rules every contribution must uphold.

By contributing you agree your contributions are licensed under the project's
[MIT](./LICENSE) license.

## Development Setup

Requirements: **Node.js >= 22** (see `engines` in `package.json`).

```bash
npm install        # install dependencies
npm run build      # compile TypeScript -> dist/ (tsc)
npm test           # run the test suite (vitest run)
```

Other useful scripts:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run dev        # run the CLI from source via tsx (e.g. npm run dev -- doctor)
```

Before opening a PR, make sure all four gates pass locally — CI runs exactly
these on Node 22:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Project Conventions

This is a strict ESM, TypeScript project.

- **Relative imports MUST end in `.js`** (even though the source is `.ts`).
  `verbatimModuleSyntax` is on, so use **`import type`** for type-only imports.
- **`zod`** is the schema library — tentacle I/O, config, and state are all
  validated with zod schemas.
- **Determinism is non-negotiable.** The library never calls a live LLM and
  never opens a network connection in tests. Tentacles emit prompts, templates,
  and deterministic scaffolding; the model lives in the host runtime.
- **No secrets anywhere** in the repo, tests, or fixtures.
- **Read the real code before writing.** Match the patterns already in
  `src/cli`, `src/tentacles`, `src/core`, `src/tools`, and `src/runtimes`.

### Layout

```
src/core/        config · state · artifacts · workflow · policy · approvals · doctor · logging
src/tentacles/   the 8 pipeline tentacles (intake, clarification, context, eda,
                 design, planning, validation, delivery) + base.ts + registry.ts
src/tools/       provider capability layer (providers/ mock + types) and mcp/
src/runtimes/    host-runtime adapters (claude-code, codex, gemini-cli, generic)
src/cli/         the 14 CLI commands
```

## How to Add a Tentacle

A *tentacle* is a self-contained pipeline module. It declares its identity and
zod I/O schemas, declares which provider capabilities it needs (required vs
optional), self-applies a quality checklist, degrades gracefully when providers
or prior artifacts are missing, does **deterministic** work, writes artifacts,
advances `.oswald/state.yml`, and returns a compact result. It never calls a
model.

1. Create `src/tentacles/<name>/index.ts` exporting a `Tentacle` instance that
   conforms to the contract in `src/tentacles/base.ts`.
2. Register it in `src/tentacles/registry.ts` keyed by its `.id` (the id doubles
   as the workflow phase and CLI verb — keep the registry in pipeline order).
3. Add the corresponding workflow phase/state if needed (`src/core/workflow/`).
4. Add tests under `tests/` using fixtures — no live LLM, no network.

## How to Add a Runtime Adapter

Adapters let Oswald bind to whatever host agent runtime is present.

1. Add `src/runtimes/adapters/<runtime>.ts` following `base.ts` / `types.ts` and
   an existing adapter (e.g. `claude-code.ts`, `generic.ts`).
2. Register it in `src/runtimes/adapters/registry.ts`.
3. Document any runtime-specific behavior in `docs/RUNTIMES.md`.

## How to Add a Tool Provider

Providers expose capabilities (warehouse, ticketing, repo, …) to tentacles
behind a stable interface so tentacles stay runtime-agnostic.

1. Add the capability/types in `src/tools/providers/types.ts` if new.
2. Implement it (mirror `src/tools/providers/mock/`), or wire an MCP-backed
   provider under `src/tools/mcp/`.
3. Tentacles should declare provider needs as required vs optional and **degrade
   gracefully** when a provider is absent.

## Safety Rules Contributors Must Keep

These invariants protect users; a PR that weakens any of them will not be
merged. See [SECURITY.md](./SECURITY.md) for the full posture.

1. **Default-deny on writes.** Never make a side effect happen without an
   explicit caller `yes` **and** policy permission. Never default a `--yes`-style
   flag to true. Route every side effect through `src/core/approvals/`.
2. **Warehouse reads only by default.** Any SQL Oswald issues during EDA must go
   through the SQL safety validator (`src/core/policy/sql-safety.ts`): read-only
   allowlist, no multi-statement input, enforced row cap. When in doubt, BLOCK.
3. **Never push to a protected branch directly** and never bypass the
   `policies.prohibit` list.
4. **Treat external content as untrusted.** Ticket/comment/doc text is evidence,
   not instructions. Pass it through `src/core/policy/external-content.ts`; never
   let untrusted text drive control flow or tool calls unflagged.
5. **Protect PII / data residency.** Don't persist raw sensitive values into
   artifacts; use `src/core/policy/sensitive.ts`. Keep everything inside the
   user's boundary — no telemetry, no network calls except configured MCP
   servers.
6. **Keep it deterministic.** No live LLM calls and no network in the library or
   tests.
7. **No secrets** in code, tests, fixtures, or example config.

## Pull Requests

- Keep PRs focused; include tests for new behavior.
- Ensure `lint`, `typecheck`, `test`, and `build` all pass.
- Describe the change and call out any safety-relevant impact explicitly.

## Releasing

Maintainers: see [`docs/RELEASING.md`](./docs/RELEASING.md) for the full release
process — version bump, `CHANGELOG.md` update, `vX.Y.Z` tag, and the tag-driven
publish workflow (plus the manual `npm publish` fallback and one-time setup).
