#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  PROJECT_ROOT,
  SRC_DIR,
  OUT_DIR,
  PLATFORM,
  APP_BUNDLE_NAME,
  APP_NAME,
  BUNDLE_ID,
  FEED_URL,
} = require("./lib/constants");
const { ensureDir, readText, run, sha256File } = require("./lib/fs-utils");
const { packAsar, computeAsarHeaderHash } = require("./lib/asar-utils");
const { assertBundleExecutable } = require("./lib/app-bundle-utils");
const { plutilGet, plutilSet } = require("./lib/plist-utils");
const {
  assertBuildNumberGreater,
  validateBuildNumber,
} = require("./lib/version-utils");
const { resolvePreviousMaxBuildNumber } = require("./lib/github-release-utils");
const { readPublicKey } = require("./patch-update-channel");

const UPSTREAM_HELPER_ID = "com.openai.codex.helper";

function mapHelperBundleId(originalId) {
  if (originalId === UPSTREAM_HELPER_ID) {
    return `${BUNDLE_ID}.helper`;
  }
  if (originalId.startsWith(`${UPSTREAM_HELPER_ID}.`)) {
    return `${BUNDLE_ID}.helper.${originalId.slice(UPSTREAM_HELPER_ID.length + 1)}`;
  }
  return `${BUNDLE_ID}.helper.${sanitizeBundleIdSegment(originalId.split(".").at(-1))}`;
}

function sanitizeBundleIdSegment(value) {
  const segment = String(value || "App").replaceAll(/[^A-Za-z0-9-]/g, "");
  return segment || "App";
}

function helperRoleFromAppPath(helperAppPath) {
  const name = path.basename(helperAppPath, ".app");
  const parenthesized = name.match(/\(([^)]+)\)\s*$/);
  if (parenthesized) {
    return sanitizeBundleIdSegment(parenthesized[1]);
  }
  return "";
}

function mapHelperBundleIdForApp(originalId, helperAppPath) {
  const role = helperRoleFromAppPath(helperAppPath);
  if (role && role !== "Service" && originalId === UPSTREAM_HELPER_ID) {
    return `${BUNDLE_ID}.helper.${role}`;
  }
  if (role === "Renderer" && originalId === `${UPSTREAM_HELPER_ID}.renderer`) {
    return `${BUNDLE_ID}.helper.Renderer`;
  }
  return mapHelperBundleId(originalId);
}

function isElectronHelperApp(appPath) {
  return appPath.split(path.sep).includes("Helpers") && path.basename(appPath).endsWith(".app");
}

function findHelperInfoPlists(appPath) {
  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  const result = [];

  function visit(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.endsWith(".app")) {
        const plist = path.join(full, "Contents", "Info.plist");
        if (isElectronHelperApp(full) && fs.existsSync(plist)) {
          result.push(plist);
        }
        continue;
      }
      visit(full);
    }
  }

  visit(frameworksDir);
  return result.sort();
}

function helperAppPathFromInfoPlist(plistPath) {
  return path.dirname(path.dirname(plistPath));
}

function setPlistString(plistPath, key, value) {
  try {
    plutilSet(plistPath, key, value);
    return;
  } catch {}
  run("plutil", ["-insert", key, "-string", String(value), plistPath]);
}

function rewriteHelperBundleIds(appPath) {
  const plists = findHelperInfoPlists(appPath);
  if (plists.length === 0) {
    throw new Error("No Electron helper app Info.plist files found");
  }

  const seen = new Map();
  for (const plist of plists) {
    const helperAppPath = helperAppPathFromInfoPlist(plist);
    const original = plutilGet(plist, "CFBundleIdentifier");
    const mapped = mapHelperBundleIdForApp(original, helperAppPath);
    if (seen.has(mapped)) {
      throw new Error(
        `Duplicate helper bundle id after rewrite: ${mapped} (${seen.get(mapped)} and ${plist})`,
      );
    }
    seen.set(mapped, plist);
    setPlistString(plist, "CFBundleIdentifier", mapped);
  }
}

function rewriteAppIdentity(appPath, metadata, buildNumber, publicKey) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  setPlistString(infoPlist, "CFBundleIdentifier", BUNDLE_ID);
  setPlistString(infoPlist, "CFBundleName", APP_NAME);
  setPlistString(infoPlist, "CFBundleDisplayName", APP_NAME);
  setPlistString(infoPlist, "CFBundleShortVersionString", metadata.upstreamVersion);
  setPlistString(infoPlist, "CFBundleVersion", buildNumber);
  setPlistString(infoPlist, "SUFeedURL", FEED_URL);
  setPlistString(infoPlist, "SUPublicEDKey", publicKey);
  rewriteHelperBundleIds(appPath);
}

function updateAsarIntegrity(infoPlist, asarHeaderHash) {
  plutilSet(infoPlist, "ElectronAsarIntegrity.Resources/app\\.asar.hash", asarHeaderHash);
  plutilSet(infoPlist, "ElectronAsarIntegrity.Resources/app\\.asar.algorithm", "SHA256");
}

function projectPath(value) {
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

function verifyUpstreamMetadata(metadata) {
  if (metadata.platform !== PLATFORM) {
    throw new Error(`upstream metadata platform must be ${PLATFORM}`);
  }
  if (!metadata.upstreamVersion) {
    throw new Error("upstream metadata missing upstreamVersion");
  }

  const archivePath = projectPath(metadata.archivePath);
  const appPath = projectPath(metadata.appPath);
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");

  if (!fs.existsSync(appPath)) {
    throw new Error(`upstream app not found: ${appPath}`);
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error(`upstream app.asar not found: ${asarPath}`);
  }
  assertBundleExecutable(appPath, metadata.upstreamExecutable);
  if (
    metadata.archiveSha256 &&
    fs.existsSync(archivePath) &&
    sha256File(archivePath) !== metadata.archiveSha256
  ) {
    throw new Error("upstream archiveSha256 mismatch");
  }
  if (sha256File(asarPath) !== metadata.appAsarSha256) {
    throw new Error("upstream appAsarSha256 mismatch");
  }
}

function readBuildNumber(env = process.env) {
  const buildNumber = env.REBUILD_BUILD_NUMBER;
  validateBuildNumber(buildNumber, "REBUILD_BUILD_NUMBER");
  return buildNumber;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const metadataPath = path.join(SRC_DIR, PLATFORM, "upstream-metadata.json");
  const metadata = JSON.parse(readText(metadataPath));
  const buildNumber = readBuildNumber(env);
  const publicKey = readPublicKey();
  const allowNoPreviousRelease =
    argv.includes("--allow-no-previous-release") || env.REBUILD_ALLOW_NO_PREVIOUS_RELEASE === "1";
  const previousMax = await resolvePreviousMaxBuildNumber({ allowNoPreviousRelease });
  assertBuildNumberGreater(buildNumber, previousMax);
  verifyUpstreamMetadata(metadata);

  const upstreamApp = projectPath(metadata.appPath);
  const outDir = path.join(OUT_DIR, PLATFORM);
  const outApp = path.join(outDir, APP_BUNDLE_NAME);
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  run("ditto", [upstreamApp, outApp], { stdio: "inherit" });

  const asarPath = path.join(outApp, "Contents", "Resources", "app.asar");
  await packAsar(path.join(SRC_DIR, PLATFORM, "_asar"), asarPath);
  rewriteAppIdentity(outApp, metadata, buildNumber, publicKey);

  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  updateAsarIntegrity(infoPlist, computeAsarHeaderHash(asarPath));
  assertBundleExecutable(outApp, metadata.upstreamExecutable);

  run("codesign", ["--remove-signature", outApp], { stdio: "pipe" });
  run("codesign", ["--sign", env.CODESIGN_IDENTITY || "-", "--force", "--deep", outApp], {
    stdio: "inherit",
  });
  run("codesign", ["--verify", "--deep", "--strict", outApp], { stdio: "inherit" });

  const releaseDir = path.join(OUT_DIR, "release");
  ensureDir(releaseDir);
  const zipName = `Codex-rebuild-darwin-arm64-${metadata.upstreamVersion}-${buildNumber}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  fs.rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", outApp, zipPath], { stdio: "inherit" });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  mapHelperBundleId,
  rewriteAppIdentity,
  rewriteHelperBundleIds,
  findHelperInfoPlists,
  verifyUpstreamMetadata,
  mapHelperBundleIdForApp,
  updateAsarIntegrity,
};
