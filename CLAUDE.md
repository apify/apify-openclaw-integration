# Apify OpenClaw Integration — Repository Guidelines

## Overview

This is a standalone OpenClaw plugin (`@apify/apify-openclaw-plugin`) that provides web scraping and data extraction via Apify's API. It registers **1 agent tool** (`apify`) — a universal scraper with 3 actions: `discover`, `start`, and `collect`.

- **Upstream repo:** https://github.com/openclaw/openclaw
- **Plugin docs:** https://docs.openclaw.ai/plugins/community
- **Agent tools guide:** https://docs.openclaw.ai/plugins/agent-tools
- **Plugin system docs:** https://docs.openclaw.ai/plugins
- **Apify console:** https://console.apify.com/
- **Support:** integrations@apify.com

## Project Structure

```
src/
  index.ts                    # Plugin entry point — registers apify + CLI
  apify-client.ts             # Shared Apify client factory, config helpers
  cli.ts                      # openclaw apify setup|status|test commands
  util.ts                     # Inlined utilities: ToolInputError, normalizeSecretInput, wrapExternalContent
  tools/
    apify-scraper-tool.ts     # Universal scraper — discover + start + collect
test/
  helpers.ts                  # makeMockFetch, standardRunResponses, TEST_CONFIG
  apify-scraper.test.ts       # Tool tests
openclaw.plugin.json          # Plugin manifest (configSchema + uiHints) — REQUIRED
package.json                  # npm package config
```

## The `apify` Tool

Single tool with 3 actions:

| Action | Purpose |
|--------|---------|
| `discover` + `query` | Search Apify Store for actors by keyword |
| `discover` + `actorId` | Fetch actor's input schema + README |
| `start` + `actorId` + `input` | Fire an actor run, returns runId/datasetId |
| `collect` + `runs` | Poll status, return results for completed runs |

### Tool Description Guidance

The tool description includes instructions for the agent:
- **Sub-agent delegation:** Tool should be used by a sub-agent that returns only relevant extracted data, not raw dumps.
- **Batching:** Batch multiple URLs into a single run (e.g. `startUrls: [{url: "..."}, ...]`).
- **Known actors:** Compact comma-separated list of 20k+ actors across Instagram, Facebook, TikTok, YouTube, Google Maps, and more.
- **Support:** Directs users to integrations@apify.com for issues.

## Key Architecture Decisions

- **Single tool, multiple actions:** All scraping goes through `apify` with `discover`/`start`/`collect` actions.
- **Async two-phase pattern:** `start` returns immediately with run references. `collect` polls and fetches results. The agent does other work between calls.
- **`apify-client` SDK:** Uses the official `apify-client` npm package (not raw HTTP). Client created via `createApifyClient(apiKey, baseUrl)`.
- **Inlined utilities (`util.ts`):** `ToolInputError`, `normalizeSecretInput`, and `wrapExternalContent` are NOT exported from `openclaw/plugin-sdk`. We carry local copies.
- **No build step:** OpenClaw loads plugins via `jiti` (TypeScript JIT). We ship `.ts` source directly.
- **No skills:** Skills were removed — the tool description and `discover` action provide all needed guidance.

## Apify Actor IDs

**Format: `username~actor-name`** (tilde separator, not slash).

The `~` format avoids URL path ambiguity. The `discover` action builds slugs as `${username}~${name}`.

## Setup Wizard — Direct Config Write

`openclaw apify setup` (in `src/cli.ts`) writes config directly to the OpenClaw config file.

It uses:
- `api.runtime.config.loadConfig()` → returns current `OpenClawConfig`
- `api.runtime.config.writeConfigFile(cfg)` → writes it back to disk

The wizard merges safely: preserves existing config, adds to `tools.alsoAllow` without duplicates, uses `group:plugins` when all tools are selected.

## Build, Test, and Development

- **Runtime:** Node 22+ (required by openclaw peer dependency).
- **Install:** `npm install`
- **Type-check:** `npx tsc --noEmit`
- **Test:** `npx vitest run`
- **Pack (dry run):** `npm pack --dry-run`
- **Bump OpenClaw to latest:** `npm run bump:openclaw` *(install-tests against the latest stable openclaw, then updates `devDependencies.openclaw` + both `compat` fields if it passes; user reviews and commits)*
- **Current state:** 1 test file, 10 tests passing.

## Updating the OpenClaw Version

The `OpenClaw Version Test` workflow blocks any PR whose pinned openclaw version lags behind the latest stable on npm. To keep up:

1. Run `npm run bump:openclaw`. The script packs the plugin, installs it against `openclaw@latest` in a temp directory, runs `plugins list` + `plugins inspect` (same smoke as CI), then runs local `typecheck` + `vitest`. If any step fails, no files are touched.
2. On success, `package.json` (`devDependencies.openclaw`, `openclaw.compat.builtWithOpenClawVersion`, `openclaw.compat.pluginSdkVersion`) and `package-lock.json` are updated. Review `git diff`, then commit as `chore: bump openclaw to <version>`.
3. `peerDependencies.openclaw` uses `">="` and is intentionally not touched.

Claude should default to this script when asked to bump OpenClaw or when the version test is failing — do not run the underlying `npm install --save-dev openclaw@X` + `npm pkg set ...` commands manually.

## CI Workflows

### `ci.yml` — fast PR gate
- Runs `npx tsc --noEmit` + `npx vitest run` on Node 22.
- Triggers on push/PR to `main`.

### `openclaw_version_tests.yml` — OpenClaw runtime compatibility matrix
Validates the plugin actually installs and loads inside a real OpenClaw runtime.

- **Triggers:**
  - `pull_request` to `main` — packs the PR branch (`npm install && npm pack`) and installs that tarball, so each PR is validated against its own diff.
  - `schedule` — Mondays at `07:00` UTC (`0 7 * * 1`), which is 8am Prague (CET) in winter / 9am Prague (CEST) in summer.
  - `workflow_dispatch` — manual re-run.
- **Schedule / dispatch mode:** installs `@apify/apify-openclaw-plugin@latest` from npm (validates the currently-shipping release).
- **Versions tested:** the `discover` job calls `npm view openclaw versions --json`, drops pre-releases (anything containing `-`), `sort -V | tail -n 3` to pick the latest 3 stable versions. Auto-updates — no manual list maintenance.
- **Smoke test per version:** all four phases run in **one consolidated bash step** that `cd`s to `$RUNNER_TEMP/openclaw-test` (splitting across steps with `working-directory:` caused a path mismatch — don't do that):
  1. `npm install openclaw@<matrix-version>` in a fresh `$RUNNER_TEMP/openclaw-test` dir.
  2. `npx openclaw plugins install <spec>` (tarball path on PR; `@latest` on schedule).
  3. `npx openclaw plugins list` — must contain `apify-openclaw-plugin`.
  4. `npx openclaw plugins inspect apify-openclaw-plugin --runtime --json` — must surface the `apify` tool name (matched loosely via `jq '.. | strings | select(. == "apify")'` since the JSON shape may evolve across OpenClaw versions).
- **Aggregator job (`required`)** — runs after the matrix with `if: always()`, fails if `discover` or `test` didn't succeed. This is the **stable required status check** in branch protection — the per-version matrix legs (`OpenClaw 2026.x.y`) rotate as discovery picks up new releases, so don't pin those.
- **Slack notification** — a `notify` job is scaffolded but commented out. To re-enable, uncomment it and add a `SLACK_WEBHOOK_URL` repo secret; it only fires on `schedule` failures.

### Branch protection on `main`
- `required` (the aggregator job above) is enforced as a required status check via the GitHub branch protection API.
- Set up via `gh api -X PUT repos/apify/apify-openclaw-plugin/branches/main/protection --input -` with a JSON body — the flag-form `-F nested.key=value` doesn't work for the nested object schema.

## Coding Style

- TypeScript (ESM). Prefer strict typing; avoid `any`.
- Tool names: `snake_case` (e.g., `apify`).
- Plugin id / config keys: `kebab-case` (e.g., `apify`).
- Keep files concise. Add comments for non-obvious logic.
- Tool schema guardrails: avoid `Type.Union`. Use `stringEnum` for string enums, `Type.Optional(...)` instead of nullable types.

---

## How the OpenClaw Plugin System Works

This section documents how OpenClaw discovers, loads, and runs plugins. Reference this when modifying the plugin or debugging integration issues.

### Plugin Lifecycle

```
Discovery → Manifest Loading → Config Validation → Module Loading → Registration → Tool Resolution
```

#### 1. Discovery

OpenClaw scans for plugins in strict precedence order:

1. **Config paths** (`plugins.load.paths`) — highest priority
2. **Workspace extensions** (`<workspace>/.openclaw/extensions/`)
3. **Global extensions** (`~/.config/openclaw/extensions/` or `~/.openclaw/extensions/`)
4. **Bundled extensions** (shipped with OpenClaw) — lowest priority

For npm-installed plugins: `openclaw plugins install <npm-spec>` runs `npm pack`, extracts the tarball into `~/.openclaw/extensions/<id>/`, and runs `npm install --ignore-scripts` for dependencies.

The plugin id is derived from the **unscoped** npm package name. For `@apify/apify-openclaw-plugin`, the id = `apify-openclaw-plugin`. The manifest, default export, and `plugins.entries` config key all use this id.

#### 2. Manifest Loading

Every plugin **must** ship `openclaw.plugin.json` in its root. This file is loaded **without executing plugin code** and provides:

- `id` (string, required) — canonical plugin identifier
- `configSchema` (JSON Schema, required) — validated before code runs
- `uiHints` (optional) — field labels, placeholders, sensitive flags for the Control UI

#### 3. Config Validation

Plugin config from `plugins.entries.<id>.config` is validated against the manifest's `configSchema` using JSON Schema. Invalid config blocks the plugin from loading entirely.

#### 4. Module Loading via Jiti

OpenClaw uses [Jiti](https://github.com/unjs/jiti) to import the plugin entry file with an alias from `"openclaw/plugin-sdk"` → the local OpenClaw SDK.

**Critical gotcha:** If `register()` returns a Promise, the async work is **silently ignored**. All registration must be synchronous.

#### 5. Registration

Our plugin calls `api.registerTool(tool)` for `apify` and `api.registerCli(...)` for the `apify` CLI subcommand.

#### 6. Tool Resolution at Runtime

Tool names that collide with core tool names are silently dropped. Plugin tools are gated by allowlists (`tools.alsoAllow`).

### Gateway Config Structure

```json5
{
  plugins: {
    enabled: true,
    entries: {
      "apify-openclaw-plugin": {
        enabled: true,
        config: {
          apiKey: "apify_api_...",     // or use APIFY_API_KEY env var
          baseUrl: "https://api.apify.com",
          maxResults: 20,
          enabledTools: [],           // empty = all tools enabled
        },
      },
    },
  },
  tools: {
    alsoAllow: ["group:plugins"],   // or "apify" or "apify"
  },
}
```

Config changes require a gateway restart (`openclaw gateway restart`).

---

## External Content Security Model

All scraped data is **untrusted external content**. The `wrapExternalContent(content, options)` function (in `util.ts`) sanitizes marker strings and wraps content between boundary markers with source metadata.

---

## Security

- **API keys:** Resolved from plugin config `apiKey` or `APIFY_API_KEY` env var. Never logged or included in tool output.
- **Base URL validation:** Only `https://api.apify.com` prefix allowed. Rejects other URLs to prevent SSRF.
- **External content wrapping:** All scraped results wrapped with untrusted content markers.

---

## Important Gotchas

1. **Async `register()` is ignored.** Must be synchronous. Our `register()` is sync.
2. **`openclaw.plugin.json` is mandatory.** Without it, the plugin never loads.
3. **Tool name collisions are silent drops.** If a tool name collides with a core tool, it gets skipped.
4. **Config validation happens before code.** Invalid config = plugin won't load.
5. **`workspace:*` deps break outside the monorepo.** We use `"openclaw": "^2026.2.18"` in devDependencies.
6. **Plugin tools are gated by allowlists.** Users must add tool names or `group:plugins` to `tools.alsoAllow`.
7. **No `Type.Union` in schemas.** OpenClaw rejects `anyOf`/`oneOf`/`allOf`. Use `stringEnum()` and `Type.Optional()`.
8. **Don't rename the plugin id.** It was renamed `apify` → `apify-openclaw-plugin` between v0.1.0 and v0.2.0 and broke every existing user's update flow (OpenClaw's installer rejects id mismatches before any migration logic runs). `scripts/migrate-id.mjs` exists as the user-facing workaround. If a future rename is unavoidable, ship another migration script and document it in the README.
