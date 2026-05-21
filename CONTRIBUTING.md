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

Releases are published to two registries by the GitHub Actions workflow at `.github/workflows/publish.yml`:

- npm: [`@apify/apify-openclaw-plugin`](https://www.npmjs.com/package/@apify/apify-openclaw-plugin)
- ClawHub: [`@apify/apify-openclaw-plugin`](https://clawhub.ai/plugins/@apify/apify-openclaw-plugin) (org: `apify`)

The workflow triggers when a GitHub **release** is published (creating a tag alone is not enough). It needs three repo secrets configured: `APIFY_SERVICE_ACCOUNT_GITHUB_TOKEN` (commit the version bump back), `NPM_TOKEN` (publish to npm), `CLAWHUB_TOKEN` (publish to ClawHub).

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
4. Watch the **Actions** tab. The workflow has two jobs:
   - `release`:
     1. Installs dependencies (`npm ci`).
     2. Bumps `package.json` `version` to match the release tag (`npm version --no-git-tag-version`).
     3. Runs `npx tsc --noEmit` and `npx vitest run`.
     4. Commits `package.json` + `package-lock.json` back to `main` as `chore(release): vX.Y.Z [skip ci]`.
     5. Publishes to npm with `--provenance --access public`. Idempotent: re-running the same release detects the version is already on npm and skips.
   - `publish-clawhub` (runs after `release`):
     - Calls the official reusable workflow `openclaw/clawhub/.github/workflows/package-publish.yml`.
     - Passes `ref: ${{ github.event.release.target_commitish }}` so ClawHub fetches `main` **after** the version-bump commit has been pushed (the release tag itself still points at the pre-bump commit).
     - Publishes under owner `apify`; family is auto-detected from `openclaw.plugin.json` (`code-plugin`).
5. Verify: `npm view @apify/apify-openclaw-plugin@X.Y.Z` and `clawhub package inspect @apify/apify-openclaw-plugin --version X.Y.Z` (or check `https://clawhub.ai/plugins/@apify/apify-openclaw-plugin`).

### Recovery

- **Workflow failed after the version-bump commit was pushed but before npm publish succeeded.** Just re-run the workflow; the bump commit will be a no-op and the publish step will retry.
- **npm publish succeeded but ClawHub publish failed.** Re-run only the `publish-clawhub` job from the Actions tab. The reusable workflow re-fetches `main` so the bumped version is still picked up.
- **You need to abandon a release entirely.** Delete the GitHub release **and** the tag, revert the `chore(release)` commit on `main`, and start over with a fresh tag.
