import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createApifyScraperTool } from "./tools/apify-scraper-tool.js";
import { registerCli } from "./cli.js";

export default {
  id: "apify-openclaw-plugin",
  name: "Apify",
  description:
    "Web scraping and data extraction via Apify — scrape any platform using 57+ actors across social media, maps, search, e-commerce, and more.",
  register(api: OpenClawPluginApi) {
    const cfg = { pluginConfig: api.pluginConfig };
    const tool = createApifyScraperTool(cfg);
    if (tool) api.registerTool(tool);
    registerCli(api);
  },
};
