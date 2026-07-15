#!/usr/bin/env node

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { extractAsar } = require("./lib/asar-utils");
const { PROJECT_ROOT, PLATFORM } = require("./lib/constants");
const { ensureDir, readText, sha256File } = require("./lib/fs-utils");
const { PATCH_CHECK_ASAR_ROOT_ENV } = require("./patch-util");

const PATCHES = [
  "patch-copyright.js",
  "patch-fast-mode.js",
  "patch-plugin-capabilities.js",
  "patch-api-key-model-availability.js",
  "patch-update-channel.js",
];

function verifyOriginalAsar({ projectRoot = PROJECT_ROOT } = {}) {
  const srcPlatform = path.join(projectRoot, "src", PLATFORM);
  const metadata = JSON.parse(readText(path.join(srcPlatform, "upstream-metadata.json")));
  const expectedAppPath = path.join(srcPlatform, "upstream", "Codex.app");
  if (metadata.appPath !== path.relative(projectRoot, expectedAppPath)) {
    throw new Error("upstream metadata appPath does not reference the stable upstream app");
  }
  const asarPath = path.join(expectedAppPath, "Contents", "Resources", "app.asar");
  if (!fs.statSync(asarPath).isFile()) {
    throw new Error("original app.asar is not a regular file");
  }
  if (sha256File(asarPath) !== metadata.appAsarSha256) {
    throw new Error("original app.asar hash does not match upstream metadata");
  }
  return asarPath;
}

async function createCheckSnapshot({
  projectRoot = PROJECT_ROOT,
  extractAsarImpl = extractAsar,
} = {}) {
  const asarPath = verifyOriginalAsar({ projectRoot });
  const cacheDir = path.join(projectRoot, ".cache");
  ensureDir(cacheDir);
  const tempRoot = fs.mkdtempSync(path.join(cacheDir, "patch-check-"));
  const asarRoot = path.join(tempRoot, "_asar");
  try {
    await extractAsarImpl(asarPath, asarRoot);
    return { tempRoot, asarRoot };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function runPatchScripts({ argv, env, spawnSyncImpl = spawnSync }) {
  for (const script of PATCHES) {
    const result = spawnSyncImpl(
      process.execPath,
      [path.join(__dirname, script), ...argv],
      { stdio: "inherit", env },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

async function run({
  argv = process.argv.slice(2),
  projectRoot = PROJECT_ROOT,
  spawnSyncImpl = spawnSync,
  extractAsarImpl = extractAsar,
} = {}) {
  const check = argv.includes("--check");
  const childEnv = { ...process.env };
  delete childEnv[PATCH_CHECK_ASAR_ROOT_ENV];
  let snapshot = null;
  try {
    if (check) {
      snapshot = await createCheckSnapshot({ projectRoot, extractAsarImpl });
      childEnv[PATCH_CHECK_ASAR_ROOT_ENV] = snapshot.asarRoot;
      console.log("[patch-check] using temporary snapshot from verified original app.asar");
    }
    return runPatchScripts({ argv, env: childEnv, spawnSyncImpl });
  } finally {
    if (snapshot) {
      fs.rmSync(snapshot.tempRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  run()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  PATCHES,
  createCheckSnapshot,
  runPatchScripts,
  verifyOriginalAsar,
  run,
};
