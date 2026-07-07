#!/usr/bin/env node

const path = require("node:path");
const { FEED_URL, PUBLIC_KEY_PATH, SRC_DIR, PLATFORM } = require("./lib/constants");
const { readText, writeText } = require("./lib/fs-utils");

const PUBLIC_KEY_SENTINEL = "ed25519-test-public-key-change-before-release";

function readPublicKey(publicKeyPath = PUBLIC_KEY_PATH) {
  const value = readText(publicKeyPath).trim();
  if (!value || value === PUBLIC_KEY_SENTINEL) {
    throw new Error(
      "config/sparkle/public-ed-key.txt must contain the real Sparkle public EdDSA key",
    );
  }
  return value;
}

function patchPackageJson(pkg, publicKey) {
  if (!Object.prototype.hasOwnProperty.call(pkg, "codexSparkleFeedUrl")) {
    throw new Error("codexSparkleFeedUrl field not found");
  }
  if (!Object.prototype.hasOwnProperty.call(pkg, "codexSparklePublicKey")) {
    throw new Error("codexSparklePublicKey field not found");
  }
  return {
    ...pkg,
    codexSparkleFeedUrl: FEED_URL,
    codexSparklePublicKey: publicKey,
  };
}

function run({
  check = false,
  packagePath = path.join(SRC_DIR, PLATFORM, "_asar", "package.json"),
  publicKeyPath = PUBLIC_KEY_PATH,
} = {}) {
  const publicKey = readPublicKey(publicKeyPath);
  const pkg = JSON.parse(readText(packagePath));
  const patched = patchPackageJson(pkg, publicKey);
  console.log(
    `[update-channel] ${packagePath}: codexSparkleFeedUrl,codexSparklePublicKey`,
  );
  if (!check) {
    writeText(packagePath, JSON.stringify(patched, null, 2) + "\n");
  }
}

if (require.main === module) {
  run({ check: process.argv.includes("--check") });
}

module.exports = { patchPackageJson, readPublicKey, run };
