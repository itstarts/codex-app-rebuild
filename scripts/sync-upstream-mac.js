#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { XMLParser } = require("fast-xml-parser");
const { PROJECT_ROOT, SRC_DIR, PLATFORM } = require("./lib/constants");
const { ensureDir, writeText, sha256File, run } = require("./lib/fs-utils");
const { extractAsar } = require("./lib/asar-utils");
const {
  findAppBundle,
  readBundleExecutable,
} = require("./lib/app-bundle-utils");

const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

function parseAppcast(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
  });
  const parsed = parser.parse(xml);
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  if (!latest) {
    throw new Error("No appcast items found");
  }
  const enclosure = Array.isArray(latest.enclosure) ? latest.enclosure[0] : latest.enclosure;

  return {
    version: latest.shortVersionString || latest.title || "",
    build: String(latest.version || ""),
    minimumSystemVersion: latest.minimumSystemVersion || "",
    downloadUrl: enclosure?.["@_url"] || "",
  };
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGetBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function main() {
  const srcPlatform = path.join(SRC_DIR, PLATFORM);
  const upstreamDir = path.join(srcPlatform, "upstream");
  const extractDir = path.join(PROJECT_ROOT, ".cache", "upstream-extract");

  fs.rmSync(extractDir, { recursive: true, force: true });
  ensureDir(upstreamDir);
  ensureDir(extractDir);

  const appcastXml = (await httpGetBuffer(APPCAST_URL)).toString("utf8");
  const info = parseAppcast(appcastXml);
  if (!info.downloadUrl) {
    throw new Error("No download URL in upstream appcast");
  }

  const archivePath = path.join(upstreamDir, "Codex-arm64.zip");
  fs.writeFileSync(archivePath, await httpGetBuffer(info.downloadUrl));
  run("ditto", ["-xk", archivePath, extractDir], { stdio: "inherit" });

  const appPath = findAppBundle(extractDir);
  if (!appPath) {
    throw new Error("Upstream app bundle containing Contents/Resources/app.asar not found");
  }
  const executable = readBundleExecutable(appPath);

  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) {
    throw new Error("app.asar not found in upstream app");
  }

  const asarDest = path.join(srcPlatform, "_asar");
  fs.rmSync(asarDest, { recursive: true, force: true });
  await extractAsar(asarPath, asarDest);

  const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
  const unpackedDest = path.join(srcPlatform, "app.asar.unpacked");
  fs.rmSync(unpackedDest, { recursive: true, force: true });
  if (fs.existsSync(unpackedSource)) {
    run("ditto", [unpackedSource, unpackedDest], { stdio: "inherit" });
  }

  const persistentAppPath = path.join(upstreamDir, "Codex.app");
  fs.rmSync(persistentAppPath, { recursive: true, force: true });
  run("ditto", [appPath, persistentAppPath], { stdio: "inherit" });

  const archiveSha256 = sha256File(archivePath);
  const appAsarSha256 = sha256File(asarPath);
  const checksums = {
    archiveSha256,
    appAsarSha256,
  };
  writeText(path.join(upstreamDir, "checksums.json"), JSON.stringify(checksums, null, 2) + "\n");

  const metadata = {
    platform: PLATFORM,
    upstreamVersion: info.version,
    upstreamBuild: info.build,
    upstreamExecutable: executable.name,
    minimumSystemVersion: info.minimumSystemVersion,
    downloadUrl: info.downloadUrl,
    archivePath: path.relative(PROJECT_ROOT, archivePath),
    appPath: path.relative(PROJECT_ROOT, persistentAppPath),
    archiveSha256,
    appAsarSha256,
  };
  writeText(path.join(srcPlatform, "upstream-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  APPCAST_URL,
  parseAppcast,
  findAppBundle,
};
