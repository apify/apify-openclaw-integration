#!/usr/bin/env node
// Bump openclaw to the latest stable version on npm, gated on the same smoke checks CI runs.
//
// Flow:
//   1. Resolve latest stable openclaw version (skip pre-releases, semver-sort).
//   2. If devDependencies.openclaw is already at latest, exit 0.
//   3. Pack the plugin (npm pack) and install it against openclaw@latest in a temp workdir.
//   4. Run `openclaw plugins list` + `plugins inspect` smoke checks (mirrors openclaw_version_tests.yml).
//   5. Run local `npm run typecheck` and `npm run test`.
//   6. Only if all of the above pass, update devDependencies.openclaw and the two
//      openclaw.compat.* fields in package.json (via `npm install --save-dev` + `npm pkg set`).
//
// On any failure no package.json edits happen. The temp workdir and local .tgz tarball
// are always cleaned up. The user reviews `git diff` and commits manually — this script
// does not stage or commit anything.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "apify-openclaw-plugin";
const TOOL_NAME = "apify";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = opts.cwd ? ` (cwd: ${opts.cwd})` : "";
    throw new Error(`Command failed${where}: ${cmd} ${args.join(" ")}`);
  }
  return result;
}

function capture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: false,
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = opts.cwd ? ` (cwd: ${opts.cwd})` : "";
    throw new Error(`Command failed${where}: ${cmd} ${args.join(" ")}`);
  }
  return result.stdout;
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function latestStableOpenclaw() {
  const json = capture("npm", ["view", "openclaw", "versions", "--json"]);
  const all = JSON.parse(json);
  const stable = all.filter((v) => !v.includes("-"));
  if (stable.length === 0) throw new Error("No stable openclaw versions on npm.");
  stable.sort(compareSemver);
  return stable[stable.length - 1];
}

function currentDevVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const raw = pkg.devDependencies?.openclaw;
  if (!raw) throw new Error("devDependencies.openclaw is missing from package.json");
  return raw.replace(/^[\^~>=<\s]+/, "").trim();
}

function smokeTest(latest) {
  console.log(`\n=== Packing plugin ===`);
  run("npm", ["install"], { cwd: REPO_ROOT });
  const packOut = capture("npm", ["pack"], { cwd: REPO_ROOT });
  const tarballName = packOut.trim().split("\n").pop();
  const tarballPath = path.join(REPO_ROOT, tarballName);
  console.log(`Packed: ${tarballPath}`);

  // Snapshot user's global OpenClaw state so the smoke test leaves no trace.
  // `openclaw plugins install` writes to ~/.openclaw/extensions/<id>/ and updates
  // ~/.openclaw/openclaw.json. We snapshot both and restore in `finally`.
  const extDir = path.join(os.homedir(), ".openclaw", "extensions", PLUGIN_ID);
  const configFile = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const snapshot = { extBackup: null, configContents: null };

  if (fs.existsSync(extDir)) {
    snapshot.extBackup = `${extDir}.bump-backup-${Date.now()}`;
    fs.renameSync(extDir, snapshot.extBackup);
    console.log(`Snapshotted existing extension dir -> ${snapshot.extBackup}`);
  }
  if (fs.existsSync(configFile)) {
    snapshot.configContents = fs.readFileSync(configFile, "utf8");
    console.log(`Snapshotted ~/.openclaw/openclaw.json (will restore on exit)`);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bump-"));
  console.log(`\n=== Smoke-testing in ${workdir} ===`);

  try {
    run("npm", ["init", "-y"], { cwd: workdir });
    run("npm", ["install", `openclaw@${latest}`], { cwd: workdir });
    run("npx", ["--no-install", "openclaw", "plugins", "install", tarballPath], { cwd: workdir });

    const listOut = capture("npx", ["--no-install", "openclaw", "plugins", "list"], { cwd: workdir });
    process.stdout.write(listOut);
    if (!listOut.includes(PLUGIN_ID)) {
      throw new Error(`FAIL: '${PLUGIN_ID}' not present in 'plugins list' output`);
    }

    const inspectOut = capture(
      "npx",
      ["--no-install", "openclaw", "plugins", "inspect", PLUGIN_ID, "--runtime", "--json"],
      { cwd: workdir },
    );
    process.stdout.write(inspectOut);
    // openclaw --json sometimes wraps the payload with clack TUI chrome (e.g. "│\n◇  \n{...}").
    // Slice from the first `{` to the last `}` before parsing. clack chrome chars don't include braces.
    const firstBrace = inspectOut.indexOf("{");
    const lastBrace = inspectOut.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error("FAIL: no JSON object found in plugins inspect output");
    }
    let inspectJson;
    try {
      inspectJson = JSON.parse(inspectOut.slice(firstBrace, lastBrace + 1));
    } catch (err) {
      throw new Error(`FAIL: plugins inspect did not return valid JSON: ${err.message}`);
    }
    if (!containsStringValue(inspectJson, TOOL_NAME)) {
      throw new Error(`FAIL: '${TOOL_NAME}' tool not found in plugin runtime inspect output`);
    }

    console.log(`OK: plugin loaded and ${TOOL_NAME} tool is registered on openclaw ${latest}`);
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: failed to remove ${workdir}: ${err.message}`);
    }
    try {
      fs.rmSync(tarballPath, { force: true });
    } catch (err) {
      console.warn(`Warning: failed to remove ${tarballPath}: ${err.message}`);
    }

    // Restore user's global OpenClaw state to what it was before the smoke test.
    try {
      fs.rmSync(extDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: failed to remove ${extDir}: ${err.message}`);
    }
    if (snapshot.extBackup && fs.existsSync(snapshot.extBackup)) {
      try {
        fs.renameSync(snapshot.extBackup, extDir);
        console.log(`Restored ${extDir} from snapshot.`);
      } catch (err) {
        console.warn(`Warning: failed to restore ${extDir} from ${snapshot.extBackup}: ${err.message}`);
      }
    }
    if (snapshot.configContents !== null) {
      try {
        fs.writeFileSync(configFile, snapshot.configContents);
        console.log(`Restored ${configFile} from snapshot.`);
      } catch (err) {
        console.warn(`Warning: failed to restore ${configFile}: ${err.message}`);
      }
    }
  }
}

function containsStringValue(node, target) {
  if (typeof node === "string") return node === target;
  if (Array.isArray(node)) return node.some((n) => containsStringValue(n, target));
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) {
      if (containsStringValue(v, target)) return true;
    }
  }
  return false;
}

function applyBump(latest) {
  console.log(`\n=== Applying bump to package.json ===`);
  run("npm", ["install", "--save-dev", `openclaw@${latest}`], { cwd: REPO_ROOT });
  run(
    "npm",
    [
      "pkg",
      "set",
      `openclaw.compat.builtWithOpenClawVersion=${latest}`,
      `openclaw.compat.pluginSdkVersion=${latest}`,
    ],
    { cwd: REPO_ROOT },
  );
}

function main() {
  const latest = latestStableOpenclaw();
  const current = currentDevVersion();
  console.log(`Current devDependencies.openclaw: ${current}`);
  console.log(`Latest stable on npm:             ${latest}`);

  if (compareSemver(current, latest) >= 0) {
    console.log(`Already on openclaw@${current}. Nothing to do.`);
    return;
  }

  smokeTest(latest);

  console.log(`\n=== Local checks ===`);
  run("npm", ["run", "typecheck"], { cwd: REPO_ROOT });
  run("npm", ["run", "test"], { cwd: REPO_ROOT });

  applyBump(latest);

  console.log(`\nBumped openclaw ${current} -> ${latest} — review and commit.`);
}

try {
  main();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
