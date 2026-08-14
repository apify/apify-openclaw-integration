import readline from "readline";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { normalizeSecretInput } from "./util.js";
import { createApifyClient, DEFAULT_APIFY_BASE_URL } from "./apify-client.js";

// ---------------------------------------------------------------------------
// readline helpers (following OuraClaw pattern)
// ---------------------------------------------------------------------------

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`${question} ${hint} `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const apify = program
        .command("apify")
        .description("Apify plugin — web scraping and data extraction");

      apify
        .command("setup")
        .description("Interactive setup wizard for the Apify plugin")
        .action(async () => runSetupCommand(api));

      apify
        .command("status")
        .description("Show Apify plugin configuration and test API connection")
        .action(async () => runStatusCommand(api));

      apify
        .command("test")
        .description("Test Apify API connection")
        .action(async () => runStatusCommand(api));

      apify
        .command("uninstall")
        .description(
          "Remove Apify plugin configuration written by `apify setup` (API key, allowlist entries)",
        )
        .action(async () => runUninstallCommand(api));
    },
    { commands: ["apify"] },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(api: OpenClawPluginApi): string | undefined {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const fromConfig = typeof config.apiKey === "string" ? normalizeSecretInput(config.apiKey) : "";
  const fromEnv = normalizeSecretInput(process.env.APIFY_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function getBaseUrl(api: OpenClawPluginApi): string {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const raw = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  return raw || DEFAULT_APIFY_BASE_URL;
}

const ALL_TOOLS: { name: string; desc: string }[] = [
  { name: "apify", desc: "Universal scraper — any Apify Actor (15k+ Actors)" },
];

// ---------------------------------------------------------------------------
// Config write helpers
// ---------------------------------------------------------------------------

async function applyConfigChanges(
  api: OpenClawPluginApi,
  apiKey: string,
  selectedTools: string[],
  allSelected: boolean,
): Promise<void> {
  if (!api.runtime?.config?.mutateConfigFile) {
    throw new Error("Config write API not available — update OpenClaw and retry.");
  }

  await api.runtime.config.mutateConfigFile({
    afterWrite: { mode: "restart", reason: "Apply Apify plugin config" },
    mutate: (cfg) => {
      // Merge plugin entry
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      const existing = cfg.plugins.entries[api.id] ?? {};
      const existingPluginConfig =
        typeof existing.config === "object" && existing.config !== null
          ? (existing.config as Record<string, unknown>)
          : {};
      cfg.plugins.entries[api.id] = {
        ...existing,
        enabled: true,
        config: {
          ...existingPluginConfig,
          apiKey,
          maxResults: existingPluginConfig.maxResults ?? 20,
        },
      };

      // Pin trust: add plugin id to plugins.allow so OpenClaw doesn't warn about
      // discovered non-bundled plugins auto-loading.
      if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
      if (!cfg.plugins.allow.includes(api.id)) {
        cfg.plugins.allow.push(api.id);
      }

      // Merge tools.alsoAllow (add selected tools, avoid duplicates)
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.alsoAllow) cfg.tools.alsoAllow = [];
      const toolsToAdd = allSelected ? ["group:plugins"] : selectedTools;
      for (const t of toolsToAdd) {
        if (!cfg.tools.alsoAllow.includes(t)) {
          cfg.tools.alsoAllow.push(t);
        }
      }
    },
  });
}

/**
 * Reverse of {@link applyConfigChanges}: surgically remove everything
 * `openclaw apify setup` wrote for this plugin from an OpenClaw config draft.
 *
 * It mutates `cfg` in place and returns the list of removed config keys (for
 * user-facing output). Exported so it can be unit-tested against plain config
 * objects without a live runtime.
 *
 * Safety rules (see issue #39 — "do not delete any other config"):
 *  - `plugins.entries[pluginId]` is deleted (this holds the API key + config).
 *  - `pluginId` is filtered out of `plugins.allow` (other ids are kept).
 *  - `tools.alsoAllow`: the bare `"apify"` tool name is apify-owned and always
 *    removed; `"group:plugins"` is SHARED by every plugin and is removed ONLY
 *    when no other plugin entries remain (i.e. Apify was the last/only plugin),
 *    so we never disable other plugins' tools.
 *
 * The function is idempotent and defensive: it tolerates missing `plugins`,
 * `plugins.entries`, `plugins.allow`, `tools`, and `tools.alsoAllow`, and never
 * deletes the parent `plugins` / `tools` containers or entries it does not own.
 */
export function removeApifyConfigFromDraft(
  cfg: OpenClawConfig,
  pluginId: string,
): { removed: string[] } {
  const removed: string[] = [];
  const plugins = cfg.plugins;

  // 1. Plugin entry — contains the API key and all other apify config.
  if (plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
    delete plugins.entries[pluginId];
    removed.push(`plugins.entries.${pluginId}`);
    // Leave an emptied `entries` object as-is; never delete the parent `plugins`.
  }

  // 2. Plugin allowlist — drop exact matches of this plugin id, keep the rest.
  if (plugins && Array.isArray(plugins.allow) && plugins.allow.includes(pluginId)) {
    plugins.allow = plugins.allow.filter((id) => id !== pluginId);
    removed.push(`plugins.allow[${pluginId}]`);
  }

  // 3. tools.alsoAllow — remove only the entries setup added, safely.
  const tools = cfg.tools;
  if (tools && Array.isArray(tools.alsoAllow)) {
    // 3a. Bare "apify" tool name — apify-owned, always safe to remove.
    if (tools.alsoAllow.includes("apify")) {
      tools.alsoAllow = tools.alsoAllow.filter((t) => t !== "apify");
      removed.push("tools.alsoAllow[apify]");
    }
    // 3b. "group:plugins" is shared across ALL plugins. Remove it only when no
    // other plugin entries remain, otherwise other plugins rely on it.
    const remainingEntries = plugins?.entries;
    const noOtherPlugins = !remainingEntries || Object.keys(remainingEntries).length === 0;
    if (noOtherPlugins && tools.alsoAllow.includes("group:plugins")) {
      tools.alsoAllow = tools.alsoAllow.filter((t) => t !== "group:plugins");
      removed.push("tools.alsoAllow[group:plugins]");
    }
  }

  return { removed };
}

/**
 * Persist the removal of Apify config via the same host API `setup` uses.
 * Returns the list of removed config keys. Exported for unit testing with a
 * mocked `api.runtime.config.mutateConfigFile`.
 */
export async function removeConfigChanges(api: OpenClawPluginApi): Promise<string[]> {
  if (!api.runtime?.config?.mutateConfigFile) {
    throw new Error("Config write API not available — update OpenClaw and retry.");
  }

  let removed: string[] = [];
  await api.runtime.config.mutateConfigFile({
    afterWrite: { mode: "restart", reason: "Remove Apify plugin config" },
    mutate: (cfg) => {
      removed = removeApifyConfigFromDraft(cfg, api.id).removed;
    },
  });
  return removed;
}

function printManualUninstall(pluginId: string): void {
  console.log("\n══════════════════════════════════════════");
  console.log("  Manual cleanup — remove these keys from your OpenClaw config:\n");
  console.log("  plugins:");
  console.log("    entries:");
  console.log(`      ${pluginId}:      # delete this entry (contains your API key)`);
  console.log("    allow:");
  console.log(`      - ${pluginId}    # delete this list entry`);
  console.log();
  console.log("  tools:");
  console.log("    alsoAllow:");
  console.log('      - apify           # delete if present');
  console.log('      - group:plugins   # delete ONLY if Apify was your last plugin');
  console.log();
  console.log("  Leave every other entry untouched.");
  console.log("  Then restart: openclaw gateway restart");
  console.log("══════════════════════════════════════════\n");
}

function printManualConfig(
  pluginId: string,
  apiKey: string,
  selectedTools: string[],
  allSelected: boolean,
): void {
  const toolAllow = allSelected
    ? "      - group:plugins   # all Apify tools"
    : selectedTools.map((t) => `      - ${t}`).join("\n");

  console.log("\n══════════════════════════════════════════");
  console.log("  ✓ Setup complete!\n");
  console.log("  Add this to your OpenClaw config:\n");
  console.log("  plugins:");
  console.log("    allow:");
  console.log(`      - ${pluginId}`);
  console.log("    entries:");
  console.log(`      ${pluginId}:`);
  console.log("        enabled: true");
  console.log("        config:");
  console.log(`          apiKey: "${apiKey}"`);
  console.log("          maxResults: 20");
  console.log();
  console.log("  tools:");
  console.log("    alsoAllow:");
  console.log(toolAllow);
  console.log();
  if (!allSelected) {
    console.log(`  Selected tools: ${selectedTools.join(", ")}`);
    console.log();
  }
  console.log("  Then restart: openclaw gateway restart");
  console.log("══════════════════════════════════════════\n");
}

// ---------------------------------------------------------------------------
// setup command
// ---------------------------------------------------------------------------

async function runSetupCommand(api: OpenClawPluginApi): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n╔══════════════════════════════════════╗");
    console.log("║      Apify Plugin Setup Wizard       ║");
    console.log("╚══════════════════════════════════════╝\n");

    // ── Step 1: API key ──────────────────────────────────────────────────────
    console.log("Step 1 of 2 — API Key\n");

    const existingKey = getApiKey(api);
    let apiKey: string;

    if (existingKey) {
      console.log(`  ✓ API key already configured: ${existingKey.slice(0, 12)}…\n`);
      const change = await confirm(rl, "  Replace it with a new key?", false);
      if (change) {
        apiKey = await ask(rl, "\n  Enter new API key (from https://console.apify.com/settings/integrations?utm_source=openclaw&utm_medium=integrations)");
        apiKey = normalizeSecretInput(apiKey);
      } else {
        apiKey = existingKey;
      }
    } else {
      console.log("  No API key found. Get yours at:");
      console.log("  https://console.apify.com/settings/integrations?utm_source=openclaw&utm_medium=integrations\n");
      apiKey = await ask(rl, "  Paste your Apify API key");
      apiKey = normalizeSecretInput(apiKey);
    }

    if (!apiKey) {
      console.log("\n  ✗ No API key provided. Setup cancelled.\n");
      return;
    }

    // ── Step 2: Verify ───────────────────────────────────────────────────────
    console.log("\nStep 2 of 2 — Verifying connection…\n");
    const baseUrl = getBaseUrl(api);
    let accountInfo = "";

    try {
      process.stdout.write("  Connecting to Apify API… ");
      const client = createApifyClient(apiKey, baseUrl);
      const user = await client.user("me").get();
      accountInfo = `@${user.username ?? "unknown"} (${user.plan?.id ?? "unknown"} plan)`;
      console.log(`done.\n  ✓ Connected as ${accountInfo}\n`);
    } catch (err) {
      console.log("failed.");
      console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      const cont = await confirm(rl, "  Key seems invalid. Continue anyway?", false);
      if (!cont) {
        console.log("\n  Setup cancelled.\n");
        return;
      }
    }

    // ── Write config or print manual instructions ────────────────────────────
    const selectedTools = ALL_TOOLS.map((t) => t.name);
    const allSelected = true;

    console.log();
    const writeDirectly = await confirm(rl, "  Write config directly to your OpenClaw config file?", true);

    if (writeDirectly) {
      try {
        process.stdout.write("\n  Writing config… ");
        await applyConfigChanges(api, apiKey, selectedTools, allSelected);
        console.log("done.\n");
        console.log("══════════════════════════════════════════");
        console.log("  ✓ Config saved!\n");
        if (!allSelected) {
          console.log(`  Tools enabled: ${selectedTools.join(", ")}\n`);
        } else {
          console.log("  All tools enabled.\n");
        }
        console.log("  Restart OpenClaw to apply: openclaw gateway restart");
        console.log("══════════════════════════════════════════\n");
      } catch (err) {
        console.log("failed.");
        console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
        console.log("\n  Falling back to manual config:\n");
        printManualConfig(api.id, apiKey, selectedTools, allSelected);
      }
    } else {
      printManualConfig(api.id, apiKey, selectedTools, allSelected);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// uninstall command
// ---------------------------------------------------------------------------

async function runUninstallCommand(api: OpenClawPluginApi): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     Apify Plugin Config Cleanup      ║");
  console.log("╚══════════════════════════════════════╝\n");
  console.log("  Removing the configuration written by 'openclaw apify setup'");
  console.log("  (API key + allowlist entries). Unrelated config is left untouched.\n");

  try {
    process.stdout.write("  Updating config… ");
    const removed = await removeConfigChanges(api);
    console.log("done.\n");

    if (removed.length === 0) {
      console.log("  No Apify config found. Nothing to remove.\n");
      return;
    }

    console.log("══════════════════════════════════════════");
    console.log("  ✓ Removed:");
    for (const key of removed) {
      console.log(`      - ${key}`);
    }
    console.log();
    console.log("  Restart OpenClaw to apply: openclaw gateway restart");
    console.log("══════════════════════════════════════════\n");
  } catch (err) {
    console.log("failed.");
    console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
    console.log("\n  Falling back to manual cleanup instructions:");
    printManualUninstall(api.id);
  }
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

async function runStatusCommand(api: OpenClawPluginApi): Promise<void> {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const apiKey = getApiKey(api);
  const baseUrl = getBaseUrl(api);

  console.log("\n=== Apify Plugin Status ===\n");
  console.log(`  API key:       ${apiKey ? `configured (${apiKey.slice(0, 12)}…)` : "NOT SET — run 'openclaw apify setup'"}`);
  console.log(`  Base URL:      ${baseUrl}`);
  console.log(`  Max results:   ${config.maxResults ?? 20} per run`);

  const enabledTools =
    Array.isArray(config.enabledTools) && config.enabledTools.length > 0
      ? (config.enabledTools as string[]).join(", ")
      : "all (no restriction)";
  console.log(`  Tools:         ${enabledTools}`);
  console.log(`  Plugin:        ${config.enabled === false ? "disabled" : "enabled (when API key is set)"}`);

  // Connection test
  if (!apiKey) {
    console.log(`\n  ✗ Cannot test connection: API key not configured.`);
    console.log("    Run 'openclaw apify setup' to configure.\n");
    return;
  }

  process.stdout.write("\n  Testing connection… ");

  try {
    const client = createApifyClient(apiKey, baseUrl);
    const user = await client.user("me").get();
    console.log("done.\n");
    console.log(`  ✓ Connected successfully!`);
    console.log(`    Account: ${user.username ?? "unknown"}`);
    console.log(`    Plan:    ${user.plan?.id ?? "unknown"}`);
    console.log();
  } catch (err) {
    console.log("failed.\n");
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    console.log("    Check that your API key is correct.\n");
  }
}
