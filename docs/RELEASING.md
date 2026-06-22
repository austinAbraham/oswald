# Releasing `@oswald-ai/oswald-core`

This project follows [Semantic Versioning](https://semver.org/) and publishes to
npm under the `@oswald-ai` scope. Releases are **tag-driven**: pushing a
`vX.Y.Z` tag triggers `.github/workflows/release.yml`, which lints, typechecks,
tests, builds, and then runs `npm publish --provenance --access public`.

## One-time setup

1. **Create the npm org.** Create the free `oswald-ai` organization on
   [npmjs.com](https://www.npmjs.com/org/create). The scoped package
   (`@oswald-ai/oswald-core`) lives under it.
2. **Add the publish token.** Generate an npm **Automation** access token with
   publish rights for the scope, then add it to the GitHub repository as a
   secret named **`NPM_TOKEN`**
   (Settings → Secrets and variables → Actions → New repository secret).
   Never commit a token to the repo.
3. (Optional, recommended) Configure this repo + the `Release` workflow as a
   **trusted publisher** for `@oswald-ai/oswald-core` on npmjs.com. The workflow
   requests `id-token: write` and publishes with `--provenance`, so npm can emit
   a verifiable provenance statement.

## Cutting a release

1. **Bump the version** in `package.json` (`npm version <patch|minor|major>`
   updates it and creates a commit; or edit by hand).
2. **Update `CHANGELOG.md`** — move items out of `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section, and update the compare links at the bottom.
3. **Verify green locally:**
   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   npm pack --dry-run        # confirm the tarball contents
   ```
4. **Commit, tag, and push the tag:**
   ```bash
   git commit -am "chore(release): vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```
5. The `Release` workflow runs on the tag and publishes to npm. Create a GitHub
   Release from the tag for the public changelog.

## Manual fallback

If CI publishing is unavailable, publish from a clean checkout:

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm login                          # interactive, owner's account
npm publish --access public        # --provenance only works from CI
```

`prepublishOnly` (`npm run build && npm test`) and `prepack` (`npm run build`)
guard the tarball so a stale or missing `dist/` can never be published.

## Dry-run checklist (no real publish)

```bash
npm run typecheck && npm test
npm pack --dry-run      # tarball ships only dist/, README, LICENSE, CHANGELOG, package.json
npm publish --dry-run   # exits clean, performs no real publish
```
