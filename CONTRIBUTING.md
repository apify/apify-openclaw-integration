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

### Step 1 — Bump openclaw to the latest version (separate PR)

CI fails any PR (and any push to `main`) where `devDependencies.openclaw`, `openclaw.compat.builtWithOpenClawVersion`, or `openclaw.compat.pluginSdkVersion` are not the latest `openclaw` published on npm (per issue #8). Per the [OpenClaw plugin building guide](https://docs.openclaw.ai/plugins/building-plugins) plugins are expected to track openclaw releases proactively (test against beta tags, open a fix PR if something breaks), so this bump is a deliberate, reviewed change.

Before tagging a release:

```bash
LATEST=$(npm view openclaw version)
npm install --save-dev "openclaw@$LATEST"
npm pkg set "openclaw.compat.builtWithOpenClawVersion=$LATEST" \
            "openclaw.compat.pluginSdkVersion=$LATEST"
npx tsc --noEmit
npx vitest run
```

Open a PR with the resulting `package.json` + `package-lock.json` diff, get it reviewed and merged into `main`. If type-check or tests fail against the new openclaw, fix the incompatibility in the same PR (the title convention from the openclaw docs is `fix(apify-openclaw-plugin): <summary>`).

`peerDependencies.openclaw` is **not** part of this bump — it declares the minimum compatible OpenClaw version for end users, and narrowing it is a separate, deliberate decision.

### Step 2 — Cut a GitHub release

1. Make sure `main` is green (CI passes) and the openclaw bump from Step 1 is merged.
2. Decide the next semver version (e.g. `0.3.0`). You do **not** need to bump the `version` field in `package.json` yourself — the workflow does it.
3. Create a GitHub release:
   - **Tag**: `vX.Y.Z` (e.g. `v0.3.0`). The leading `v` is stripped by the workflow.
   - **Target**: `main`.
   - **Title / notes**: summarise the changes.
   - Click **Publish release**.
4. Watch the **Actions** tab. The `Release & Publish to npm` workflow will:
   1. Install dependencies (`npm ci`).
   2. Bump `package.json` `version` to match the release tag (`npm version --no-git-tag-version`).
   3. Run `npx tsc --noEmit` and `npx vitest run`.
   4. Commit `package.json` + `package-lock.json` back to `main` as `chore(release): vX.Y.Z [skip ci]`.
   5. Publish to npm with `--provenance --access public`. The step is idempotent: re-running the same release will detect the version is already on npm and skip the publish.
5. Verify: `npm view @apify/apify-openclaw-plugin@X.Y.Z`.

### Recovery

- **Workflow failed after the version-bump commit was pushed but before npm publish succeeded.** Just re-run the workflow; the bump commit will be a no-op and the publish step will retry.
- **You need to abandon a release entirely.** Delete the GitHub release **and** the tag, revert the `chore(release)` commit on `main`, and start over with a fresh tag.
