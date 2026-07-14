const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { APP_BUNDLE_NAME, APP_NAME, BUNDLE_ID, FEED_URL } = require("../scripts/lib/constants");
const {
  updateAsarIntegrity,
  mapHelperBundleId,
  mapHelperBundleIdForApp,
  rewriteAppIdentity,
  rewriteHelperBundleIds,
  verifyUpstreamMetadata,
} = require("../scripts/build-mac-arm64");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writePlist(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.entries(values)
    .map(([key, value]) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`)
    .join("\n");
  fs.writeFileSync(
    file,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      entries,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
}

function plistRaw(plist, key) {
  const result = spawnSync("plutil", ["-extract", key, "raw", plist], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function helperInfoPath(appPath, helperName) {
  return path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Codex Framework.framework",
    "Versions",
    "149.0.7827.197",
    "Helpers",
    `${helperName}.app`,
    "Contents",
    "Info.plist",
  );
}

function createAppFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-helper-ids-"));
  const appPath = path.join(root, APP_BUNDLE_NAME);
  writePlist(path.join(appPath, "Contents", "Info.plist"), {
    CFBundleIdentifier: "com.openai.codex",
    CFBundleName: "Codex",
    CFBundleDisplayName: "Codex",
    CFBundleExecutable: "ChatGPT",
    CFBundleShortVersionString: "26.623.101652",
    CFBundleVersion: "4674",
    SUPublicEDKey: "official-key",
  });
  writePlist(helperInfoPath(appPath, "Codex (GPU)"), {
    CFBundleIdentifier: "com.openai.codex.helper",
  });
  writePlist(helperInfoPath(appPath, "Codex (Service)"), {
    CFBundleIdentifier: "com.openai.codex.helper",
  });
  writePlist(helperInfoPath(appPath, "Codex (Renderer)"), {
    CFBundleIdentifier: "com.openai.codex.helper.renderer",
  });
  writePlist(helperInfoPath(appPath, "Codex (Alerts)"), {
    CFBundleIdentifier: "com.openai.codex.framework.AlertNotificationService",
  });
  const executable = path.join(appPath, "Contents", "MacOS", "ChatGPT");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "fixture");
  fs.chmodSync(executable, 0o755);
  return appPath;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createUpstreamMetadataFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-metadata-"));
  const appPath = path.join(root, "Codex.app");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const executablePath = path.join(appPath, "Contents", "MacOS", "ChatGPT");
  const asarBytes = Buffer.from("synthetic asar");
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, asarBytes);
  writePlist(path.join(appPath, "Contents", "Info.plist"), {
    CFBundleExecutable: "ChatGPT",
  });
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, "fixture");
  fs.chmodSync(executablePath, 0o755);
  return {
    platform: "mac-arm64",
    upstreamVersion: "26.623.101652",
    upstreamExecutable: "ChatGPT",
    archivePath: path.join(root, "missing-upstream.zip"),
    archiveSha256: "not-used-when-archive-is-absent",
    appPath,
    appAsarSha256: sha256(asarBytes),
  };
}

test("helper bundle ids are deterministic and unique", () => {
  const mapped = [
    mapHelperBundleId("com.openai.codex.helper"),
    mapHelperBundleId("com.openai.codex.helper.GPU"),
    mapHelperBundleId("com.openai.codex.helper.Plugin"),
    mapHelperBundleId("com.openai.codex.helper.Renderer"),
  ];
  assert.deepEqual(mapped, [
    "io.github.itstarts.codex-rebuild.helper",
    "io.github.itstarts.codex-rebuild.helper.GPU",
    "io.github.itstarts.codex-rebuild.helper.Plugin",
    "io.github.itstarts.codex-rebuild.helper.Renderer",
  ]);
  assert.equal(new Set(mapped).size, mapped.length);
});

test("project identity uses the ChatGPT-Rebuild app name while preserving repository and bundle id", () => {
  assert.equal(APP_NAME, "ChatGPT-Rebuild");
  assert.equal(APP_BUNDLE_NAME, "ChatGPT-Rebuild.app");
  assert.equal(BUNDLE_ID, "io.github.itstarts.codex-rebuild");
  assert.equal(
    FEED_URL,
    "https://github.com/itstarts/codex-app-rebuild/releases/latest/download/appcast-darwin-arm64.xml",
  );
});

test("path-aware helper mapping preserves unknown prefixed helper suffixes", () => {
  assert.equal(
    mapHelperBundleIdForApp(
      "com.openai.codex.helper.Plugin",
      "/tmp/Helpers/Codex (Foo).app",
    ),
    `${BUNDLE_ID}.helper.Plugin`,
  );
});

test("rewriteHelperBundleIds uses helper app names when upstream ids collide", () => {
  const appPath = createAppFixture();
  rewriteHelperBundleIds(appPath);

  const ids = {
    gpu: plistRaw(helperInfoPath(appPath, "Codex (GPU)"), "CFBundleIdentifier"),
    service: plistRaw(helperInfoPath(appPath, "Codex (Service)"), "CFBundleIdentifier"),
    renderer: plistRaw(helperInfoPath(appPath, "Codex (Renderer)"), "CFBundleIdentifier"),
    alerts: plistRaw(helperInfoPath(appPath, "Codex (Alerts)"), "CFBundleIdentifier"),
  };
  assert.deepEqual(ids, {
    gpu: `${BUNDLE_ID}.helper.GPU`,
    service: `${BUNDLE_ID}.helper`,
    renderer: `${BUNDLE_ID}.helper.Renderer`,
    alerts: `${BUNDLE_ID}.helper.AlertNotificationService`,
  });
  assert.equal(new Set(Object.values(ids)).size, Object.keys(ids).length);
});

test("rewriteAppIdentity writes main app metadata and rewrites helper ids", () => {
  const appPath = createAppFixture();
  rewriteAppIdentity(
    appPath,
    { upstreamVersion: "26.999.100001" },
    "2026070601020304",
    "real-public-key",
  );

  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  assert.equal(plistRaw(infoPlist, "CFBundleIdentifier"), BUNDLE_ID);
  assert.equal(plistRaw(infoPlist, "CFBundleName"), APP_NAME);
  assert.equal(plistRaw(infoPlist, "CFBundleDisplayName"), APP_NAME);
  assert.equal(plistRaw(infoPlist, "CFBundleExecutable"), "ChatGPT");
  assert.equal(plistRaw(infoPlist, "CFBundleShortVersionString"), "26.999.100001");
  assert.equal(plistRaw(infoPlist, "CFBundleVersion"), "2026070601020304");
  assert.equal(plistRaw(infoPlist, "SUFeedURL"), FEED_URL);
  assert.equal(plistRaw(infoPlist, "SUPublicEDKey"), "real-public-key");
  assert.equal(
    plistRaw(helperInfoPath(appPath, "Codex (GPU)"), "CFBundleIdentifier"),
    `${BUNDLE_ID}.helper.GPU`,
  );
});

test("updateAsarIntegrity writes real ElectronAsarIntegrity plist structure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-integrity-"));
  const plist = path.join(root, "Info.plist");
  writePlist(plist, {});
  const insert = spawnSync(
    "plutil",
    [
      "-insert",
      "ElectronAsarIntegrity",
      "-xml",
      "<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>old</string></dict></dict>",
      plist,
    ],
    { encoding: "utf8" },
  );
  assert.equal(insert.status, 0, insert.stderr || insert.stdout);

  updateAsarIntegrity(plist, "new-hash");

  assert.equal(
    plistRaw(plist, "ElectronAsarIntegrity.Resources/app\\.asar.hash"),
    "new-hash",
  );
  assert.equal(
    plistRaw(plist, "ElectronAsarIntegrity.Resources/app\\.asar.algorithm"),
    "SHA256",
  );
});

test("verifyUpstreamMetadata allows absent archive when app.asar hash matches", () => {
  const metadata = createUpstreamMetadataFixture();

  assert.doesNotThrow(() => verifyUpstreamMetadata(metadata));
});

test("verifyUpstreamMetadata rejects missing upstreamExecutable", () => {
  const metadata = createUpstreamMetadataFixture();
  delete metadata.upstreamExecutable;

  assert.throws(
    () => verifyUpstreamMetadata(metadata),
    /expected bundle executable name is required/,
  );
});

test("verifyUpstreamMetadata rejects executable metadata mismatch", () => {
  const metadata = createUpstreamMetadataFixture();
  metadata.upstreamExecutable = "Codex";

  assert.throws(
    () => verifyUpstreamMetadata(metadata),
    /bundle executable mismatch: expected Codex, got ChatGPT/,
  );
});
