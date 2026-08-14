import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createApifyScraperTool } from "./tools/apify-scraper-tool.js";
import { registerCli } from "./cli.js";

// NOTE: the plugin id is intentionally NOT declared here. OpenClaw reads the
// canonical id from openclaw.plugin.json (the manifest, loaded before any code
// runs) — that file is the single source of truth. If an `id` is present on
// this export it must match the manifest or the plugin fails to load, so we
// omit it to avoid duplicating the value. Access it at runtime via `api.id`.
export default {
  name: "Apify",
  description:
    "Web scraping and data extraction via Apify — scrape any platform using 20k+ actors across social media, maps, search, e-commerce, and more.",
  register(api: OpenClawPluginApi) {
    const cfg = { pluginConfig: api.pluginConfig };
    const tool = createApifyScraperTool(cfg);
    if (tool) api.registerTool(tool);
    registerCli(api);
  },
};
