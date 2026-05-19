#!/usr/bin/env node
// Migration: rename plugin id `apify` -> `apify-openclaw-plugin` in the OpenClaw config.
// Required because v0.2.0 changed the plugin id to match the unscoped npm package name,
// which makes `openclaw plugins update apify` fail with a "plugin id mismatch" error for
// users coming from v0.1.x. Run this once before updating.
//
// Idempotent. No backup. Requires strict JSON — JSON5 (comments / trailing commas) is rejected; see README.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OLD_ID = "apify";
const NEW_ID = "apify-openclaw-plugin";

function expandHome(p) {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function resolveConfigPath() {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    const expanded = expandHome(override);
    if (fs.existsSync(expanded)) return { path: expanded, candidates: [expanded] };
    return { path: null, candidates: [expanded] };
  }

  const candidates = [
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
    path.join(os.homedir(), ".clawdbot", "clawdbot.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, candidates };
  }
  return { path: null, candidates };
}

function replaceIdInList(list) {
  if (!Array.isArray(list)) return { list, changed: false };
  let changed = false;
  const next = [];
  for (const entry of list) {
    const value = entry === OLD_ID ? NEW_ID : entry;
    if (value !== entry) changed = true;
    if (!next.includes(value)) next.push(value);
    else changed = true;
  }
  return { list: next, changed };
}

function needsMigration(cfg) {
  const plugins = cfg?.plugins;
  if (!plugins) return false;
  if (plugins.installs && OLD_ID in plugins.installs) return true;
  if (plugins.entries && OLD_ID in plugins.entries) return true;
  if (Array.isArray(plugins.allow) && plugins.allow.includes(OLD_ID)) return true;
  if (Array.isArray(plugins.deny) && plugins.deny.includes(OLD_ID)) return true;
  if (plugins.slots?.memory === OLD_ID) return true;
  return false;
}

// Mirrors openclaw's migratePluginConfigId (node_modules/openclaw/dist/update-*.js).
function migrate(cfg) {
  if (!needsMigration(cfg)) return { cfg, changes: [] };

  const changes = [];
  const plugins = { ...cfg.plugins };

  if (plugins.installs && OLD_ID in plugins.installs) {
    const installs = { ...plugins.installs };
    const record = installs[OLD_ID];
    if (record && !(NEW_ID in installs)) installs[NEW_ID] = record;
    delete installs[OLD_ID];
    plugins.installs = installs;
    changes.push(`plugins.installs: renamed "${OLD_ID}" -> "${NEW_ID}"`);
  }

  if (plugins.entries && OLD_ID in plugins.entries) {
    const entries = { ...plugins.entries };
    const oldEntry = entries[OLD_ID];
    if (oldEntry) {
      // If new id already exists, the newer entry wins on conflicts (matches SDK).
      entries[NEW_ID] = entries[NEW_ID] ? { ...oldEntry, ...entries[NEW_ID] } : oldEntry;
    }
    delete entries[OLD_ID];
    plugins.entries = entries;
    changes.push(`plugins.entries: renamed "${OLD_ID}" -> "${NEW_ID}"`);
  }

  const allow = replaceIdInList(plugins.allow);
  if (allow.changed) {
    plugins.allow = allow.list;
    changes.push(`plugins.allow: renamed "${OLD_ID}" -> "${NEW_ID}"`);
  }

  const deny = replaceIdInList(plugins.deny);
  if (deny.changed) {
    plugins.deny = deny.list;
    changes.push(`plugins.deny: renamed "${OLD_ID}" -> "${NEW_ID}"`);
  }

  if (plugins.slots?.memory === OLD_ID) {
    plugins.slots = { ...plugins.slots, memory: NEW_ID };
    changes.push(`plugins.slots.memory: "${OLD_ID}" -> "${NEW_ID}"`);
  }

  return { cfg: { ...cfg, plugins }, changes };
}

function main() {
  const { path: configPath, candidates } = resolveConfigPath();
  if (!configPath) {
    console.log("No OpenClaw config found. Checked:");
    for (const c of candidates) console.log(`  - ${c}`);
    console.log("Nothing to migrate.");
    process.exit(0);
  }

  console.log(`Reading: ${configPath}`);
  const raw = fs.readFileSync(configPath, "utf8");

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${configPath} as JSON: ${err instanceof Error ? err.message : String(err)}`);
    console.error("If your config is JSON5 (has comments or trailing commas), edit it by hand:");
    console.error(`  rename "${OLD_ID}" to "${NEW_ID}" in plugins.installs, plugins.entries, plugins.allow, plugins.deny, plugins.slots.memory`);
    process.exit(1);
  }

  const { cfg: next, changes } = migrate(cfg);
  if (changes.length === 0) {
    console.log("Already migrated, nothing to do.");
    process.exit(0);
  }

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
  console.log("Applied:");
  for (const c of changes) console.log(`  - ${c}`);
  console.log("");
  console.log(`Next: openclaw plugins update ${NEW_ID}`);
}

main();
