#!/usr/bin/env node
// Single source of truth for "which openclaw version are we supposed to be on?".
// CLI:
//   node scripts/openclaw-version.mjs latest      # print the latest release version
//   node scripts/openclaw-version.mjs matrix [n]  # print JSON array of the latest n patch lines
//   node scripts/openclaw-version.mjs check       # fail if package.json lags behind latest

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// X.Y.Z, optionally followed by a numeric re-release suffix (-N).
const RELEASE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

export function isReleaseVersion(version) {
  return RELEASE_RE.test(version);
}

/** Parse into [major, minor, patch, revision]; revision 0 means "no -N suffix". */
function parseVersion(version) {
  const m = RELEASE_RE.exec(version);
  if (!m) throw new Error(`Not an openclaw release version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 0 : Number(m[4])];
}

/**
 * Compare two openclaw release versions. Negative if a < b, 0 if equal, positive if a > b.
 * Note: `X.Y.Z-2` sorts ABOVE `X.Y.Z` (it is a later re-release), which is the
 * opposite of strict semver pre-release ordering. That is deliberate — see header.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function stripRange(spec) {
  return String(spec).replace(/^[\^~>=<\s]+/, "").trim();
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  return result.stdout;
}

/** All published openclaw release versions (pre-releases excluded), oldest first. */
export function openclawReleaseVersions() {
  const all = JSON.parse(capture("npm", ["view", "openclaw", "versions", "--json"]));
  const releases = (Array.isArray(all) ? all : [all]).filter(isReleaseVersion);
  if (releases.length === 0) throw new Error("No openclaw release versions found on npm.");
  return releases.sort(compareVersions);
}

/**
 * The version users get from `npm install openclaw`. The `latest` dist-tag is
 * authoritative; we only fall back to the highest published release if that tag
 * points at something we don't recognise as a release (e.g. tagged to a beta).
 */
/**
 * Release versions collapsed to the newest respin of each X.Y.Z line, oldest
 * first. Testing 2026.7.1, 2026.7.1-1 and 2026.7.1-2 is near-redundant — one
 * leg per patch line buys real coverage breadth for the same CI time.
 */
export function latestPerPatchLine(releases = openclawReleaseVersions()) {
  const newestByLine = new Map();
  for (const version of releases) {
    const line = version.split("-")[0];
    const seen = newestByLine.get(line);
    if (!seen || compareVersions(version, seen) > 0) newestByLine.set(line, version);
  }
  return [...newestByLine.values()].sort(compareVersions);
}

export function latestOpenclawVersion() {
  const releases = openclawReleaseVersions();
  const distTags = JSON.parse(capture("npm", ["view", "openclaw", "dist-tags", "--json"]));
  const tagged = distTags?.latest;
  if (typeof tagged === "string" && isReleaseVersion(tagged)) return tagged;
  const fallback = releases[releases.length - 1];
  console.warn(
    `Warning: openclaw dist-tag 'latest' is "${tagged}", which is not a release version. ` +
      `Falling back to the highest published release (${fallback}).`,
  );
  return fallback;
}

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
}

/** The package.json fields that must track the latest openclaw release. */
export function pinnedVersions(pkg = readPkg()) {
  return [
    { label: "devDependencies.openclaw", raw: pkg.devDependencies?.openclaw },
    { label: "openclaw.build.openclawVersion", raw: pkg.openclaw?.build?.openclawVersion },
    { label: "openclaw.compat.builtWithOpenClawVersion", raw: pkg.openclaw?.compat?.builtWithOpenClawVersion },
    { label: "openclaw.compat.pluginSdkVersion", raw: pkg.openclaw?.compat?.pluginSdkVersion },
  ];
}

/** Version currently pinned in devDependencies.openclaw, range prefix stripped. */
export function currentDevVersion() {
  const raw = readPkg().devDependencies?.openclaw;
  if (!raw) throw new Error("devDependencies.openclaw is missing from package.json");
  return stripRange(raw);
}

/** Emit a GitHub Actions error annotation (falls back to plain text locally). */
function annotateError(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`);
}

function checkCommand() {
  const latest = latestOpenclawVersion();
  console.log(`Latest openclaw release on npm: ${latest}`);

  let failed = false;
  for (const { label, raw } of pinnedVersions()) {
    if (raw === undefined) {
      annotateError(`${label} is missing from package.json.`);
      failed = true;
      continue;
    }
    const version = stripRange(raw);
    if (!isReleaseVersion(version)) {
      annotateError(`${label} is "${raw}", which is not a recognised openclaw release version.`);
      failed = true;
      continue;
    }
    // Only lagging behind is a failure — being ahead (e.g. openclaw published a
    // new version minutes after the release was cut) must not block a publish.
    if (compareVersions(version, latest) < 0) {
      annotateError(`${label} is "${raw}" (resolves to ${version}), latest on npm is ${latest}. Bump it before releasing.`);
      failed = true;
    }
  }

  if (failed) {
    console.error("Run: npm run bump:openclaw && commit + re-cut the release.");
    process.exit(1);
  }
  console.log(`All openclaw version fields are up to date (>= ${latest}).`);
}

function main() {
  const [command = "latest", arg] = process.argv.slice(2);

  if (command === "latest") {
    console.log(latestOpenclawVersion());
    return;
  }
  if (command === "matrix") {
    const count = Number(arg ?? 3);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid matrix count: ${arg}`);
    console.log(JSON.stringify(latestPerPatchLine().slice(-count)));
    return;
  }
  if (command === "check") {
    checkCommand();
    return;
  }
  throw new Error(`Unknown command: ${command}. Expected one of: latest, matrix, check.`);
}

// Only run the CLI when invoked directly, so the exports above stay importable.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}
