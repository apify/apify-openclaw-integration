# Contributing

## Development

Requirements: Node.js 22+.

```bash
npm install
npx tsc --noEmit   # type check
npx vitest run     # run tests
```

CI (`.github/workflows/ci.yml`) runs the same checks on every PR and push to `main`.

## Releasing a new version

Releases are published to npm as [`@apify/apify-openclaw-plugin`](https://www.npmjs.com/package/@apify/apify-openclaw-plugin) by the GitHub Actions workflow at `.github/workflows/publish.yml`. The workflow triggers when a GitHub **release** is published (creating a tag alone is not enough).

### Release flow

1. Make sure `main` is green (CI passes) and includes everything you want in the release.
2. Decide the next semver version (e.g. `0.3.0`). You do **not** need to bump `package.json` yourself — the workflow does it.
3. Create a GitHub release:
   - **Tag**: `vX.Y.Z` (e.g. `v0.3.0`). The leading `v` is stripped by the workflow.
   - **Target**: `main`.
   - **Title / notes**: summarise the changes.
   - Click **Publish release**.
4. Watch the **Actions** tab. The `Release & Publish to npm` workflow will:
   1. Install dependencies (`npm ci`).
   2. Bump `package.json` `version` to match the release tag.
   3. Look up the latest `openclaw` version on npm and:
      - update `devDependencies.openclaw` to `^<latest>`,
      - set `openclaw.compat.builtWithOpenClawVersion` to `<latest>`,
      - set `openclaw.compat.pluginSdkVersion` to `<latest>`.
   4. Run `npx tsc --noEmit` and `npx vitest run` against that latest `openclaw`. If either fails, the release is aborted — fix the incompatibility on `main` and re-cut the release.
   5. Commit `package.json` + `package-lock.json` back to `main` as `chore(release): vX.Y.Z (openclaw=<latest>) [skip ci]`.
   6. Publish to npm with `--provenance --access public`. The step is idempotent: re-running the same release will detect the version is already on npm and skip the publish.
5. Verify: `npm view @apify/apify-openclaw-plugin@X.Y.Z`.

### Notes

- `peerDependencies.openclaw` is **not** auto-bumped — it declares the minimum compatible OpenClaw version for end users. Raise it manually in a normal PR only when there is a real reason to drop support for older OpenClaw versions.
- If the release workflow fails after the version-bump commit was already pushed but before npm publish succeeded, just re-run the workflow from the Actions tab; the bump commit will be a no-op and the publish step will retry.
- If you need to abandon a release entirely, delete the GitHub release **and** the tag, revert the `chore(release)` commit on `main`, and start over with a fresh tag.
