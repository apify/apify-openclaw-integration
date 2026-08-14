#!/usr/bin/env node
// Publish the plugin to ClawHub under the ClawHub-specific id.
//
// WHY THIS SCRIPT EXISTS
// ----------------------
// The plugin's canonical id (openclaw.plugin.json "id") is `apify-openclaw-plugin`
// — that is what ships to npm and what the OpenClaw installer keys on. ClawHub,
// however, already has this plugin registered under the shorter id `apify` (that
// is what every existing ClawHub user has installed). If we published the
// canonical id to ClawHub it would either register a *different* plugin or break
// those users' updates. So for ClawHub — and ONLY for ClawHub — we rename the id.
//
// The reusable ClawHub publish workflow packs the repo verbatim and offers no
// id/name override, so we can't do this rename through it. Instead this script:
//   1. rewrites openclaw.plugin.json "id" -> CLAWHUB_ID in place,
//   2. runs `clawhub package publish`,
//   3. ALWAYS restores the original manifest (even on failure),
// so the working tree / committed repo is never left mutated.
//
// The id lives in exactly ONE literal place in the repo (openclaw.plugin.json);
// the only ClawHub-specific override lives in exactly ONE place: CLAWHUB_ID below.
//
// Usage:
//   node scripts/publish-clawhub.mjs                # real publish
//   node scripts/publish-clawhub.mjs --dry-run      # preview, no upload
//   (any extra args are forwarded to `clawhub package publish`)
//
// Auth: the ClawHub CLI does NOT read CLAWHUB_TOKEN directly — it authenticates
// from its own on-disk config. So CI must first run
// `clawhub login --token "$CLAWHUB_TOKEN"` (or point CLAWHUB_CONFIG_PATH at a
// pre-seeded config file) before invoking this script; locally it relies on an
// existing interactive `clawhub login`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "openclaw.plugin.json");

// The id ClawHub knows this plugin by. This is the single, deliberate deviation
// from the canonical manifest id and the only place it is declared.
const CLAWHUB_ID = "apify";
// Publish under this ClawHub owner/organisation handle.
const CLAWHUB_OWNER = "apify";

const extraArgs = process.argv.slice(2);

const originalRaw = fs.readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(originalRaw);
const canonicalId = manifest.id;

function restoreManifest() {
  fs.writeFileSync(MANIFEST_PATH, originalRaw);
}

if (canonicalId === CLAWHUB_ID) {
  console.log(`Manifest id is already "${CLAWHUB_ID}" — publishing as-is.`);
} else {
  console.log(`Renaming manifest id "${canonicalId}" -> "${CLAWHUB_ID}" for ClawHub publish.`);
  // Preserve formatting: swap only the id value, keep the rest of the file byte-identical
  // on restore. We re-serialize with 2-space indent (matches the repo style) for the
  // temporary publish copy; the original text is restored verbatim afterwards.
  manifest.id = CLAWHUB_ID;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// Restore on any exit path (normal, throw, or signal) so we never leave the repo dirty.
let restored = false;
function restoreOnce() {
  if (restored) return;
  restored = true;
  try {
    restoreManifest();
    console.log(`Restored manifest id -> "${canonicalId}".`);
  } catch (err) {
    console.error(`WARNING: failed to restore ${MANIFEST_PATH}: ${err.message}`);
    console.error(`Restore it manually: set "id" back to "${canonicalId}".`);
  }
}
process.on("exit", restoreOnce);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const args = [
  "package",
  "publish",
  ".",
  "--family",
  "code-plugin",
  "--owner",
  CLAWHUB_OWNER,
  ...extraArgs,
];

console.log(`\n$ clawhub ${args.join(" ")}\n`);
const result = spawnSync("clawhub", args, { stdio: "inherit", shell: false, cwd: REPO_ROOT });

if (result.error) {
  console.error(`Failed to run clawhub: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
