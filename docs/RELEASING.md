# Releasing `@oswald-ai/oswald-core`

This project follows [Semantic Versioning](https://semver.org/) and publishes to
npm under the `@oswald-ai` scope via **Trusted Publishing** — GitHub Actions
authenticates to npm with a short-lived OIDC token, so there is **no npm token to
store, leak, or rotate**, and provenance is emitted automatically. The
`Release` workflow (`.github/workflows/release.yml`) can be run from the Actions
tab ("Run workflow") or triggered by pushing a `vX.Y.Z` tag.

## One-time setup

1. **Create the npm org.** Create the free `oswald-ai` organization on
   [npmjs.com](https://www.npmjs.com/org/create). The scoped package
   (`@oswald-ai/oswald-core`) lives under it. *(Done.)*
2. **Configure Trusted Publishing.** On npmjs.com, open the package
   (`@oswald-ai/oswald-core`) → **Settings → Trusted Publisher → GitHub Actions**,
   and enter:
   - **Organization or user:** `austinAbraham`
   - **Repository:** `oswald`
   - **Workflow filename:** `release.yml`
   - **Environment:** *(leave blank)*

   That's it — no token, no `NPM_TOKEN` secret. The workflow's
   `permissions: id-token: write` lets npm verify the run came from this exact
   repo + workflow. (Trusted Publishing requires the package to already exist, so
   the very first version is published manually — see *Manual fallback*.)

## Cutting a release

1. **Bump the version** in `package.json` (`npm version <patch|minor|major>` or by
   hand) — never reuse a version; unpublished versions are retired permanently.
2. **Update `CHANGELOG.md`** — move items from `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section.
3. **Get the bump onto GitHub**, then publish one of two ways:
   - **Run workflow (recommended):** GitHub → Actions → **Release → Run workflow**
     (or `gh workflow run Release`).
   - **Tag push:** `git tag vX.Y.Z && git push --follow-tags`.
4. The `Release` workflow lints, typechecks, tests, builds, **publishes with
   provenance** via Trusted Publishing, and opens a **GitHub Release**. If that
   version is already on npm it safely no-ops (so re-runs never fail confusingly).

## Manual fallback

For the very first publish, or if CI is unavailable, publish from a clean checkout
(needs an npm account with publish rights to the scope, and 2FA — either an OTP at
the prompt or an Automation / bypass-2FA token):

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm login                     # owner's account
npm publish --access public   # --provenance only emits from CI/Trusted Publishing
```

`prepublishOnly` (`npm run build && npm test`) and `prepack` (`npm run build`)
guard the tarball so a stale or missing `dist/` can never be published.

## Dry-run checklist (no real publish)

```bash
npm run typecheck && npm test
npm pack --dry-run      # tarball ships only dist/, README, LICENSE, CHANGELOG, package.json
npm publish --dry-run   # exits clean, performs no real publish
```
