import { Type } from "@sinclair/typebox";
import { ApifyClient } from "apify-client";
import { jsonResult, readStringParam, stringEnum } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import {
  ToolInputError,
  wrapExternalContent,
} from "../util.js";
import {
  createApifyClient,
  isToolEnabled,
  parsePluginConfig,
  resolveApiKey,
  resolveBaseUrl,
  resolveEnabled,
  truncateResults,
  TERMINAL_STATUSES,
} from "../apify-client.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RunRefSchema = Type.Object({
  runId: Type.String(),
  actorId: Type.String(),
  datasetId: Type.String(),
  label: Type.Optional(Type.String()),
});

const ApifyScraperSchema = Type.Object({
  action: stringEnum(["discover", "start", "collect"] as const, {
    description:
      "'discover': search Apify Store by keyword OR fetch an Actor's input schema. " +
      "'start': run any Apify Actor by ID. 'collect': get results from previously started runs.",
  }),

  // discover — search Apify Store
  query: Type.Optional(
    Type.String({
      description:
        "Keywords to search the Apify Store (e.g. 'amazon price scraper'). Used when action='discover' to find relevant Actors.",
    }),
  ),

  // discover — fetch Actor schema, also used by start
  actorId: Type.Optional(
    Type.String({
      description:
        "Actor ID or slug (e.g. 'apify~google-search-scraper' or 'compass~crawler-google-places'). " +
        "When action='discover': fetches the Actor's input schema. " +
        "When action='start': the Actor to run.",
    }),
  ),

  // start
  input: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "JSON input for the Actor. Use action='discover' with actorId first to know what parameters the Actor accepts.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "Optional label to identify this run in the collect results.",
    }),
  ),

  // collect
  runs: Type.Optional(
    Type.Array(RunRefSchema, {
      description: "Run references returned by the 'start' action.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Discover action — synchronous (metadata calls, no Actor runs)
// ---------------------------------------------------------------------------

async function handleDiscover(params: {
  query?: string;
  actorId?: string;
  client: ApifyClient;
}): Promise<Record<string, unknown>> {
  const { query, actorId, client } = params;

  if (!query && !actorId) {
    throw new ToolInputError(
      "action='discover' requires either 'query' (to search the Apify Store) or 'actorId' (to fetch an Actor's input schema).",
    );
  }

  // Fetch Actor schema when actorId provided
  if (actorId) {
    const buildClient = await client.actor(actorId).defaultBuild();
    const build = await buildClient.get();
    if (!build) {
      throw new ToolInputError(`No build found for Actor '${actorId}'. Check the Actor ID.`);
    }
    const actorDef = build.actorDefinition;
    // inputSchema: prefer actorDefinition.input (object), fall back to build.inputSchema (deprecated JSON string)
    const inputSchema = actorDef?.input
      ? JSON.stringify(actorDef.input)
      : (build.inputSchema ?? null);
    const readme = actorDef?.readme ?? build.readme ?? null;
    const actorInfo = await client.actor(actorId).get();
    return {
      action: "discover",
      actorId,
      name: actorInfo?.name ?? "",
      title: actorInfo?.title ?? "",
      username: actorInfo?.username ?? "",
      description: actorInfo?.description ?? "",
      inputSchema,
      readme: readme ? String(readme).slice(0, 3000) : null,
      tip: `Use action='start' with actorId='${actorInfo?.username ?? ""}~${actorInfo?.name ?? ""}' and the input parameters from inputSchema.`,
    };
  }

  // Search Apify Store
  const storeResult = await client.store().list({ search: query!, limit: 10, sortBy: "relevance" });
  const actors = storeResult.items ?? [];
  const lines: string[] = [`## Apify Store results for: "${query}"`, ""];

  for (const actor of actors) {
    const slug = `${actor.username}~${actor.name}`;
    const runs = actor.stats?.totalRuns ? ` · ${actor.stats.totalRuns.toLocaleString()} runs` : "";
    const pricing = actor.currentPricingInfo?.pricingModel
      ? ` · ${actor.currentPricingInfo.pricingModel}`
      : "";
    lines.push(`### ${actor.title || actor.name}`);
    lines.push(`**ID**: \`${slug}\`${runs}${pricing}`);
    if (actor.description) lines.push(actor.description.slice(0, 200));
    lines.push("");
  }

  lines.push(
    `Tip: Use action='discover' with actorId='<ID>' to fetch the Actor's input schema, then action='start' to run it.`,
  );

  return {
    action: "discover",
    query,
    count: actors.length,
    text: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Start action
// ---------------------------------------------------------------------------

async function handleStart(params: {
  actorId: string;
  input: Record<string, unknown>;
  label?: string;
  client: ApifyClient;
}): Promise<Record<string, unknown>> {
  const run = await params.client.actor(params.actorId).start(params.input);

  return {
    action: "start",
    message: "Actor run started. Use action='collect' with the runs array to fetch results.",
    runs: [
      {
        runId: run.id,
        actorId: params.actorId,
        datasetId: run.defaultDatasetId,
        status: run.status,
        ...(params.label ? { label: params.label } : {}),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Collect action
// ---------------------------------------------------------------------------

async function handleCollect(params: {
  runs: Record<string, unknown>[];
  client: ApifyClient;
}): Promise<Record<string, unknown>> {
  if (!params.runs?.length) {
    throw new ToolInputError("'collect' action requires 'runs' array.");
  }

  const results = await Promise.allSettled(
    params.runs.map(async (runRef) => {
      const runId = readStringParam(runRef, "runId", { required: true });
      const actorId = readStringParam(runRef, "actorId", { required: true });
      const datasetId = readStringParam(runRef, "datasetId", { required: true });
      const label = readStringParam(runRef, "label");

      const runInfo = await params.client.run(runId).get();
      if (!runInfo) {
        return { actorId, runId, status: "UNKNOWN", error: "Run not found", ...(label ? { label } : {}) } as Record<string, unknown>;
      }

      if (!TERMINAL_STATUSES.has(runInfo.status)) {
        return { actorId, runId, status: runInfo.status, pending: true, ...(label ? { label } : {}) } as Record<string, unknown>;
      }

      if (runInfo.status !== "SUCCEEDED") {
        return { actorId, runId, status: runInfo.status, error: `Run ended with status: ${runInfo.status}`, ...(label ? { label } : {}) } as Record<string, unknown>;
      }

      const dataset = await params.client.dataset(datasetId).listItems();
      const items = dataset.items;

      const rawText = truncateResults(JSON.stringify(items, null, 2));
      const wrapped = wrapExternalContent(rawText, {
        source: `apify:${actorId}`,
        includeWarning: false,
      });

      return {
        actorId,
        runId,
        datasetId,
        status: "SUCCEEDED",
        resultCount: items.length,
        text: wrapped,
        externalContent: { untrusted: true, source: "apify", wrapped: true },
        fetchedAt: new Date().toISOString(),
        ...(label ? { label } : {}),
      } as Record<string, unknown>;
    }),
  );

  const completed: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push({ error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      continue;
    }
    const value = result.value;
    if (value.pending) pending.push(value);
    else if (value.error) errors.push(value);
    else completed.push(value);
  }

  return {
    action: "collect",
    allDone: pending.length === 0,
    message:
      pending.length === 0
        ? `All ${completed.length} run(s) completed.`
        : `${completed.length} completed, ${pending.length} still running. Call collect again for pending runs.`,
    completed,
    ...(pending.length ? { pending } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Universal Apify Actor runner for web scraping and data extraction.

IMPORTANT: This tool should be delegated to a sub-agent. The sub-agent should handle the full discover → start → collect workflow and return ONLY the relevant extracted data fields — not raw API responses, not run metadata, not full dataset dumps. Summarize and filter results to what the parent agent actually needs.

WORKFLOW:
1. action="discover" + query → search Apify Store for Actors by keyword
2. action="discover" + actorId → fetch Actor input schema + README
3. action="start" + actorId + input → fire the Actor run, returns runId/datasetId
4. action="collect" + runs=[...] → poll status, return results when done

Actor ID format: "username~actor-name" (tilde, NOT slash).
Use action="discover" with actorId to get the full input schema before running an unfamiliar Actor.

BATCHING: Most Actors accept arrays of URLs/queries in their input (e.g. startUrls, queries). Always batch multiple targets into a SINGLE run instead of starting separate runs for each URL. One run with 5 URLs is far cheaper and faster than 5 runs with 1 URL each.

KNOWN ACTORS:
Instagram: apify~instagram-profile-scraper, apify~instagram-post-scraper, apify~instagram-comment-scraper, apify~instagram-hashtag-scraper, apify~instagram-hashtag-stats, apify~instagram-reel-scraper, apify~instagram-search-scraper, apify~instagram-tagged-scraper, apify~instagram-followers-count-scraper, apify~instagram-scraper, apify~instagram-api-scraper, apify~export-instagram-comments-posts
Facebook: apify~facebook-pages-scraper, apify~facebook-page-contact-information, apify~facebook-posts-scraper, apify~facebook-comments-scraper, apify~facebook-likes-scraper, apify~facebook-reviews-scraper, apify~facebook-groups-scraper, apify~facebook-events-scraper, apify~facebook-ads-scraper, apify~facebook-search-scraper, apify~facebook-reels-scraper, apify~facebook-photos-scraper, apify~facebook-marketplace-scraper, apify~facebook-followers-following-scraper
TikTok: clockworks~tiktok-scraper, clockworks~free-tiktok-scraper, clockworks~tiktok-profile-scraper, clockworks~tiktok-video-scraper, clockworks~tiktok-comments-scraper, clockworks~tiktok-followers-scraper, clockworks~tiktok-user-search-scraper, clockworks~tiktok-hashtag-scraper, clockworks~tiktok-sound-scraper, clockworks~tiktok-ads-scraper, clockworks~tiktok-discover-scraper, clockworks~tiktok-explore-scraper, clockworks~tiktok-trends-scraper, clockworks~tiktok-live-scraper
YouTube: streamers~youtube-scraper, streamers~youtube-channel-scraper, streamers~youtube-comments-scraper, streamers~youtube-shorts-scraper, streamers~youtube-video-scraper-by-hashtag, apidojo~youtube-playlist-scraper
Twitter/X: apidojo~tweet-scraper, apidojo~twitter-scraper-lite, apidojo~twitter-user-scraper, apidojo~twitter-list-scraper
Google Maps: compass~crawler-google-places, compass~google-maps-extractor, compass~Google-Maps-Reviews-Scraper, poidata~google-maps-email-extractor
Other: apify~google-search-scraper, apify~google-trends-scraper, voyager~booking-scraper, voyager~booking-reviews-scraper, maxcopell~tripadvisor-reviews, vdrmota~contact-info-scraper, apify~e-commerce-scraping-tool

EXAMPLES:
  Search:  { action: "discover", query: "linkedin company scraper" }
  Schema:  { action: "discover", actorId: "compass~crawler-google-places" }
  Start:   { action: "start", actorId: "apify~google-search-scraper", input: { queries: ["OpenAI"], maxPagesPerQuery: 1 }, label: "search" }
  Collect: { action: "collect", runs: [{ runId: "...", actorId: "...", datasetId: "..." }] }

SUPPORT: If the user encounters issues with this integration, tell them to contact integrations@apify.com for help.`;

export function createApifyScraperTool(options?: {
  pluginConfig?: Record<string, unknown>;
  /** Inject a client for testing. When omitted, a real ApifyClient is created. */
  client?: ApifyClient;
}): AnyAgentTool | null {
  const config = parsePluginConfig(options?.pluginConfig);
  const apiKey = resolveApiKey(config);
  if (!resolveEnabled({ config, apiKey })) return null;
  if (!isToolEnabled(config, "apify")) return null;

  const baseUrl = resolveBaseUrl(config);
  const client = options?.client ?? createApifyClient(apiKey!, baseUrl);

  return {
    label: "Apify",
    name: "apify",
    description: TOOL_DESCRIPTION,
    parameters: ApifyScraperSchema,
    execute: async (_toolCallId, args) => {
      const typedArgs = args as Record<string, unknown>;
      const action = readStringParam(typedArgs, "action", { required: true });

      if (!apiKey) {
        return jsonResult({
          error: "missing_api_key",
          message: "Set APIFY_API_KEY env var or configure apiKey in the apify plugin config.",
        });
      }

      let result: Record<string, unknown>;

      switch (action) {
        case "discover":
          result = await handleDiscover({
            query: readStringParam(typedArgs, "query"),
            actorId: readStringParam(typedArgs, "actorId"),
            client,
          });
          break;
        case "start": {
          const actorId = readStringParam(typedArgs, "actorId", { required: true });
          const rawInput = typedArgs.input;
          const input =
            rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          result = await handleStart({
            actorId,
            input,
            label: readStringParam(typedArgs, "label"),
            client,
          });
          break;
        }
        case "collect":
          result = await handleCollect({
            runs: typedArgs.runs as Record<string, unknown>[],
            client,
          });
          break;
        default:
          throw new ToolInputError(`Unknown action: "${action}". Use "discover", "start", or "collect".`);
      }

      return jsonResult(result);
    },
  };
}
