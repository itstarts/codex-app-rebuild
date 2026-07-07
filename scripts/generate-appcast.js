#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, PUBLIC_KEY_PATH } = require("./lib/constants");
const { run, writeText } = require("./lib/fs-utils");
const { readPublicKey } = require("./patch-update-channel");

const APPCAST_NAME = "appcast-darwin-arm64.xml";
const DEFAULT_MINIMUM_SYSTEM_VERSION = "14.0";
const ED25519_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function generateAppcastXml({
  version,
  shortVersion,
  upstreamBuild,
  url,
  length,
  signature,
  minimumSystemVersion = DEFAULT_MINIMUM_SYSTEM_VERSION,
}) {
  const numericLength = Number(length);
  if (!Number.isSafeInteger(numericLength) || numericLength < 0) {
    throw new Error("appcast enclosure length must be a non-negative integer");
  }
  if (!upstreamBuild) {
    throw new Error("upstreamBuild is required");
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:codexRebuild="https://github.com/itstarts/codex-app-rebuild/appcast">
  <channel>
    <title>Codex-rebuild macOS arm64 updates</title>
    <item>
      <title>${escapeXml(shortVersion)}</title>
      <codexRebuild:upstreamBuild>${escapeXml(upstreamBuild)}</codexRebuild:upstreamBuild>
      <sparkle:minimumSystemVersion>${escapeXml(minimumSystemVersion)}</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <enclosure
        url="${escapeXml(url)}"
        length="${numericLength}"
        type="application/octet-stream"
        sparkle:version="${escapeXml(version)}"
        sparkle:shortVersionString="${escapeXml(shortVersion)}"
        sparkle:edSignature="${escapeXml(signature)}" />
    </item>
  </channel>
</rss>
`;
}

function matchAttribute(output, name) {
  return output.match(new RegExp(`${name}=["']([^"']+)["']`))?.[1] || "";
}

function parseSignUpdateOutput(output) {
  const signature = matchAttribute(output, "sparkle:edSignature");
  const lengthText = matchAttribute(output, "length");
  const length = Number(lengthText);
  if (!signature || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("sign_update output did not include sparkle:edSignature and length");
  }
  return { signature, length };
}

function publicEdKeyObject(publicKeyBase64) {
  const raw = Buffer.from(publicKeyBase64.trim(), "base64");
  if (raw.length !== 32) {
    throw new Error("SUPublicEDKey must decode to 32 raw Ed25519 public key bytes");
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_PUBLIC_KEY_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function verifySparkleSignature(zipPath, signatureBase64, publicKeyBase64) {
  const signature = Buffer.from(signatureBase64.trim(), "base64");
  if (signature.length !== 64) {
    throw new Error("sparkle:edSignature must decode to a 64-byte Ed25519 signature");
  }
  const payload = fs.readFileSync(zipPath);
  const publicKey = publicEdKeyObject(publicKeyBase64);
  if (!crypto.verify(null, payload, publicKey, signature)) {
    throw new Error("sign_update signature does not verify with config/sparkle/public-ed-key.txt");
  }
}

function sparklePrivateKeyArgs(env = process.env) {
  if (env.SPARKLE_PRIVATE_KEY_FILE) {
    return { args: ["--ed-key-file", env.SPARKLE_PRIVATE_KEY_FILE] };
  }
  if (env.SPARKLE_PRIVATE_KEY) {
    return { args: ["--ed-key-file", "-"], input: `${env.SPARKLE_PRIVATE_KEY.trim()}\n` };
  }
  throw new Error("SPARKLE_PRIVATE_KEY or SPARKLE_PRIVATE_KEY_FILE is required for release signing");
}

function signUpdateArchive(
  zipPath,
  {
    env = process.env,
    publicKeyPath = PUBLIC_KEY_PATH,
    runner = run,
  } = {},
) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Release zip not found: ${zipPath}`);
  }
  const key = sparklePrivateKeyArgs(env);
  const signUpdate = env.SPARKLE_SIGN_UPDATE || "sign_update";
  const signed = parseSignUpdateOutput(
    runner(signUpdate, [...key.args, zipPath], {
      env,
      input: key.input,
      sensitive: true,
    }),
  );
  verifySparkleSignature(zipPath, signed.signature, readPublicKey(publicKeyPath));
  return signed;
}

function releaseZipPath(env) {
  if (env.REBUILD_ZIP_PATH) {
    return env.REBUILD_ZIP_PATH;
  }
  const releaseUrl = new URL(env.REBUILD_RELEASE_URL);
  return path.join(OUT_DIR, "release", path.basename(releaseUrl.pathname));
}

function readRequiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main(env = process.env) {
  const version = readRequiredEnv(env, "REBUILD_BUILD_NUMBER");
  const shortVersion = readRequiredEnv(env, "REBUILD_SHORT_VERSION");
  const upstreamBuild = readRequiredEnv(env, "REBUILD_UPSTREAM_BUILD");
  const url = readRequiredEnv(env, "REBUILD_RELEASE_URL");
  const zipPath = releaseZipPath(env);
  const signed = signUpdateArchive(zipPath, { env });
  const xml = generateAppcastXml({
    version,
    shortVersion,
    upstreamBuild,
    url,
    length: signed.length,
    signature: signed.signature,
    minimumSystemVersion: env.REBUILD_MINIMUM_SYSTEM_VERSION || DEFAULT_MINIMUM_SYSTEM_VERSION,
  });
  writeText(path.join(OUT_DIR, "release", APPCAST_NAME), xml);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  generateAppcastXml,
  parseSignUpdateOutput,
  publicEdKeyObject,
  verifySparkleSignature,
  sparklePrivateKeyArgs,
  signUpdateArchive,
  main,
};
