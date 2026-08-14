import { describe, it, expect } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { removeApifyConfigFromDraft, removeConfigChanges } from "../src/cli.js";

const PLUGIN_ID = "apify-openclaw-plugin";

/** Cast a plain object literal to OpenClawConfig for the pure-function tests. */
function asConfig(obj: unknown): OpenClawConfig {
  return obj as OpenClawConfig;
}

/** A config exactly as `openclaw apify setup` writes it (apify only). */
function setupOnlyConfig(): OpenClawConfig {
  return asConfig({
    plugins: {
      allow: [PLUGIN_ID],
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          config: { apiKey: "apify_api_secret", maxResults: 20 },
        },
      },
    },
    tools: { alsoAllow: ["group:plugins"] },
  });
}

describe("removeApifyConfigFromDraft", () => {
  it("removes plugins.entries[id] including the stored API key", () => {
    const cfg = setupOnlyConfig();
    const { removed } = removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    expect(cfg.plugins?.entries?.[PLUGIN_ID]).toBeUndefined();
    // The API key is gone with the entry.
    expect(JSON.stringify(cfg)).not.toContain("apify_api_secret");
    expect(removed).toContain(`plugins.entries.${PLUGIN_ID}`);
  });

  it("removes the id from plugins.allow, leaving other ids intact", () => {
    const cfg = asConfig({
      plugins: {
        allow: [PLUGIN_ID, "other"],
        entries: { [PLUGIN_ID]: { config: { apiKey: "k" } } },
      },
      tools: { alsoAllow: ["group:plugins"] },
    });

    const { removed } = removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    expect(cfg.plugins?.allow).toEqual(["other"]);
    expect(removed).toContain(`plugins.allow[${PLUGIN_ID}]`);
  });

  it("removes the bare 'apify' tool name from tools.alsoAllow", () => {
    const cfg = asConfig({
      plugins: {
        allow: [PLUGIN_ID],
        entries: { [PLUGIN_ID]: { config: { apiKey: "k" } } },
      },
      tools: { alsoAllow: ["apify", "some-other-tool"] },
    });

    const { removed } = removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    expect(cfg.tools?.alsoAllow).toEqual(["some-other-tool"]);
    expect(removed).toContain("tools.alsoAllow[apify]");
  });

  it("removes 'group:plugins' only when no other plugin entries remain", () => {
    const cfg = setupOnlyConfig();

    const { removed } = removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    expect(cfg.tools?.alsoAllow).toEqual([]);
    expect(removed).toContain("tools.alsoAllow[group:plugins]");
  });

  it("keeps 'group:plugins' when another plugin entry still exists", () => {
    const cfg = asConfig({
      plugins: {
        allow: [PLUGIN_ID, "other-plugin"],
        entries: {
          [PLUGIN_ID]: { config: { apiKey: "k" } },
          "other-plugin": { config: { foo: "bar" } },
        },
      },
      tools: { alsoAllow: ["group:plugins"] },
    });

    const { removed } = removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    // Shared group entry stays — other-plugin relies on it.
    expect(cfg.tools?.alsoAllow).toEqual(["group:plugins"]);
    expect(removed).not.toContain("tools.alsoAllow[group:plugins]");
  });

  it("never deletes config unrelated to Apify", () => {
    const cfg = asConfig({
      plugins: {
        allow: [PLUGIN_ID, "other-plugin"],
        entries: {
          [PLUGIN_ID]: { config: { apiKey: "k" } },
          "other-plugin": { enabled: true, config: { foo: "bar" } },
        },
        deny: ["blocked-plugin"],
      },
      tools: { alsoAllow: ["group:plugins", "some-core-tool", "another"] },
      agents: { defaults: { workspace: "/tmp/ws" } },
    });

    removeApifyConfigFromDraft(cfg, PLUGIN_ID);

    // Unrelated subtrees survive exactly.
    expect(cfg.plugins?.entries?.["other-plugin"]).toEqual({
      enabled: true,
      config: { foo: "bar" },
    });
    expect(cfg.plugins?.allow).toEqual(["other-plugin"]);
    expect(cfg.plugins?.deny).toEqual(["blocked-plugin"]);
    // group:plugins kept (other-plugin present); only apify-owned keys removed.
    expect(cfg.tools?.alsoAllow).toEqual(["group:plugins", "some-core-tool", "another"]);
    expect((cfg as { agents?: unknown }).agents).toEqual({ defaults: { workspace: "/tmp/ws" } });
  });

  it("is a no-op on an empty config and does not throw", () => {
    const cfg = asConfig({});
    expect(() => removeApifyConfigFromDraft(cfg, PLUGIN_ID)).not.toThrow();
    expect(removeApifyConfigFromDraft(cfg, PLUGIN_ID).removed).toEqual([]);
  });

  it("tolerates missing plugins/entries/allow/tools/alsoAllow containers", () => {
    const cases: unknown[] = [
      { plugins: {} },
      { plugins: { entries: {} } },
      { plugins: { allow: [] } },
      { tools: {} },
      { tools: { alsoAllow: [] } },
      { plugins: { entries: {}, allow: [] }, tools: { alsoAllow: [] } },
    ];
    for (const c of cases) {
      const cfg = asConfig(c);
      expect(() => removeApifyConfigFromDraft(cfg, PLUGIN_ID)).not.toThrow();
      expect(removeApifyConfigFromDraft(cfg, PLUGIN_ID).removed).toEqual([]);
    }
  });

  it("is idempotent — running twice matches running once", () => {
    const once = setupOnlyConfig();
    removeApifyConfigFromDraft(once, PLUGIN_ID);

    const twice = setupOnlyConfig();
    removeApifyConfigFromDraft(twice, PLUGIN_ID);
    const secondPass = removeApifyConfigFromDraft(twice, PLUGIN_ID);

    expect(twice).toEqual(once);
    // Second pass finds nothing left to remove.
    expect(secondPass.removed).toEqual([]);
  });
});

describe("removeConfigChanges", () => {
  it("drives mutateConfigFile, derives the id from api.id, and removes the entry", async () => {
    const draft = setupOnlyConfig();
    let restartReason: string | undefined;

    const api = {
      id: PLUGIN_ID,
      runtime: {
        config: {
          mutateConfigFile: async (params: {
            afterWrite: { mode: string; reason: string };
            mutate: (cfg: OpenClawConfig, ctx: unknown) => unknown;
          }) => {
            restartReason = params.afterWrite.reason;
            await params.mutate(draft, {});
            return { result: undefined };
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    const removed = await removeConfigChanges(api);

    expect(removed).toContain(`plugins.entries.${PLUGIN_ID}`);
    expect(draft.plugins?.entries?.[PLUGIN_ID]).toBeUndefined();
    expect(restartReason).toBe("Remove Apify plugin config");
  });

  it("throws a clear error when the config write API is unavailable", async () => {
    const api = { id: PLUGIN_ID, runtime: {} } as unknown as OpenClawPluginApi;
    await expect(removeConfigChanges(api)).rejects.toThrow(/Config write API not available/);
  });
});
