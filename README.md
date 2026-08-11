# Apify Plugin for OpenClaw

Universal web scraping and data extraction via [Apify](https://apify.com) — 20k+ Actors across Instagram, Facebook, TikTok, YouTube, Google Maps, Google Search, e-commerce, and more.

## Install

```bash
openclaw plugins install @apify/apify-openclaw-plugin
```

Restart the Gateway after installation.

## Upgrading from 0.1.x to 0.2.x

Version 0.2.0 renamed the plugin id from `apify` to `apify-openclaw-plugin` to match the unscoped npm package name. If you installed 0.1.x, `openclaw plugins update apify` will fail with:

```
Failed to update apify: plugin id mismatch: expected apify, got apify-openclaw-plugin
```

Download and run the migration script once **before** updating:

```bash
curl -fsSL https://raw.githubusercontent.com/apify/apify-openclaw-plugin/main/scripts/migrate-id.mjs -o /tmp/apify-migrate-id.mjs
node /tmp/apify-migrate-id.mjs
```

(Inspect `/tmp/apify-migrate-id.mjs` first if you prefer.)

Then update normally:

```bash
openclaw plugins update apify-openclaw-plugin
```

The script reads `~/.openclaw/openclaw.json` (or `$OPENCLAW_CONFIG_PATH`), renames the `apify` id to `apify-openclaw-plugin` in `plugins.installs`, `plugins.entries`, `plugins.allow`, `plugins.deny`, and `plugins.slots.memory`, then writes the file back. It is safe to re-run.

**Note:** if your config is JSON5 (has comments or trailing commas), the script will refuse to parse it — apply the rename by hand instead.

## How it works

The plugin registers a single tool — `apify` — with three actions:

| Action | Purpose |
|--------|---------|
| `discover` + `query` | Search the Apify Store for Actors by keyword |
| `discover` + `actorId` | Fetch an Actor's input schema + README |
| `start` + `actorId` + `input` | Run any Apify Actor, returns `runId` / `datasetId` |
| `collect` + `runs` | Poll status and return results for completed runs |

The tool uses a **two-phase async pattern**: `start` fires off a run and returns immediately. `collect` fetches results when the run completes. The agent does other work in between.

The plugin also ships an `apify-scraper` skill (`skills/apify-scraper/SKILL.md`) carrying an **Actor routing table** — a curated lookup mapping a scraping need to the exact Apify Actor ID (tilde `username~actor-name` format) — so the agent can pick the right Actor directly instead of always searching the Store. OpenClaw loads it automatically via the manifest `skills` field.

## Get an API key

1. Create an Apify account at [https://console.apify.com/](https://console.apify.com/)
2. Generate an API token in Account Settings → Integrations.
3. Store it in plugin config or set the `APIFY_API_KEY` environment variable.

## Configure

```json5
{
  plugins: {
    entries: {
      "apify-openclaw-plugin": {
        config: {
          apiKey: "apify_api_...",     // optional if APIFY_API_KEY env var is set
          baseUrl: "https://api.apify.com",
          maxResults: 20,
          enabledTools: [],           // empty = all tools enabled
        },
      },
    },
  },
  // Make the tool available to agents:
  tools: {
    alsoAllow: ["apify"],   // or "apify" or "group:plugins"
  },
}
```

Or use the interactive setup wizard:

```bash
openclaw apify setup
```

## apify

### Workflow

```
discover (search) → discover (schema) → start → collect
```

1. **Search** — Find Actors: `{ action: "discover", query: "amazon price scraper" }`
2. **Schema** — Get input params: `{ action: "discover", actorId: "apify~google-search-scraper" }`
3. **Start** — Run the Actor: `{ action: "start", actorId: "apify~google-search-scraper", input: { queries: ["OpenAI"] } }`
4. **Collect** — Get results: `{ action: "collect", runs: [{ runId: "...", actorId: "...", datasetId: "..." }] }`

### Actor ID format

Actor IDs use the `username~actor-name` format (tilde separator, not slash).

### Known Actors

The tool description includes 20k+ Actors across these categories:

- **Instagram** — profiles, posts, comments, hashtags, reels, search, followers, tagged posts
- **Facebook** — pages, posts, comments, likes, reviews, groups, events, ads, reels, photos, marketplace
- **TikTok** — search, profiles, videos, comments, followers, hashtags, sounds, ads, trends, live
- **YouTube** — search, channels, comments, shorts, video-by-hashtag
- **Google Maps** — places, reviews, email extraction
- **Other** — Google Search, Google Trends, Booking.com, TripAdvisor, contact info, e-commerce

### Batching

Most Actors accept arrays of URLs/queries in their input (e.g., `startUrls`, `queries`). Always batch multiple targets into a single run — one run with 5 URLs is cheaper and faster than 5 separate runs.

### Examples

```javascript
// 1. Search the Apify Store
const search = await apify({
  action: "discover",
  query: "linkedin company scraper",
});

// 2. Get an Actor's input schema
const schema = await apify({
  action: "discover",
  actorId: "compass~crawler-google-places",
});

// 3. Start a Google Search scrape
const started = await apify({
  action: "start",
  actorId: "apify~google-search-scraper",
  input: { queries: ["OpenAI", "Anthropic"], maxPagesPerQuery: 1 },
  label: "search",
});
// -> { runs: [{ runId, actorId, datasetId, status }] }

// 4. Collect results
const results = await apify({
  action: "collect",
  runs: started.runs,
});
// -> { completed: [...], pending: [...] }

// Instagram profile scraping
await apify({
  action: "start",
  actorId: "apify~instagram-profile-scraper",
  input: { usernames: ["natgeo", "nasa"] },
});

// TikTok search
await apify({
  action: "start",
  actorId: "clockworks~tiktok-scraper",
  input: { searchQueries: ["AI tools"], resultsPerPage: 20 },
});
```

### Sub-agent delegation

The tool description instructs agents to delegate `apify` calls to a sub-agent. The sub-agent handles the full discover → start → collect workflow and returns only the relevant extracted data — not raw API responses or run metadata.

## Security

- **API keys** are resolved from plugin config or `APIFY_API_KEY` env var — never logged or included in output.
- **Base URL validation** — only `https://api.apify.com` prefix is allowed (SSRF prevention).
- **External content wrapping** — all scraped results are wrapped with untrusted content markers.

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build compiled output to dist/ (required for publish)
npm run build

# Pack (dry run) — npm runs `prepublishOnly` (build) automatically before packing
npm pack --dry-run
```

`dist/` is generated by `npm run build` and is not checked in. The published npm
tarball ships `dist/` so newer OpenClaw versions (which no longer JIT-load
TypeScript) can install the plugin.

## Support

For issues with this integration, contact [integrations@apify.com](mailto:integrations@apify.com).

## License

MIT
