const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { packAsar } = require("../scripts/lib/asar-utils");
const {
  verifyAsarIntegrity,
  verifyBuildNumberCases,
  verifyRequestEvidence,
  verifyUpdaterNotDisabled,
} = require("../scripts/verify-build");

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function createEvidenceDir({ fast = { service_tier: "fast" }, standard = { service_tier: "standard" } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-evidence-"));
  if (fast !== undefined) {
    writeJson(path.join(dir, "fast-request.json"), fast);
  }
  if (standard !== undefined) {
    writeJson(path.join(dir, "standard-request.json"), standard);
  }
  return dir;
}

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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createAsarIntegrityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-asar-integrity-"));
  const app = path.join(root, "Codex-rebuild.app");
  const plist = path.join(app, "Contents", "Info.plist");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const header = Buffer.from("header-json", "utf8");
  const bytes = Buffer.alloc(16 + header.length);
  bytes.writeUInt32LE(header.length, 12);
  header.copy(bytes, 16);
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, bytes);
  writePlist(plist, {});
  const insert = spawnSync(
    "plutil",
    [
      "-insert",
      "ElectronAsarIntegrity",
      "-xml",
      `<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${sha256(header)}</string></dict></dict>`,
      plist,
    ],
    { encoding: "utf8" },
  );
  assert.equal(insert.status, 0, insert.stderr || insert.stdout);
  return { app, plist };
}

test("verifyRequestEvidence requires fast and standard captured tiers", () => {
  const dir = createEvidenceDir();

  assert.doesNotThrow(() => verifyRequestEvidence(dir));
});

test("verifyRequestEvidence fails when captured request files are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-evidence-missing-"));

  assert.throws(() => verifyRequestEvidence(dir), /fast-request\.json/);
});

test("verifyRequestEvidence accepts upstream standard equivalent tiers", () => {
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ standard: { service_tier: undefined } })),
  );
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ standard: { service_tier: null } })),
  );
});

test("verifyRequestEvidence accepts upstream fast equivalent tiers", () => {
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ fast: { service_tier: "priority" } })),
  );
});

test("verifyRequestEvidence fails when fast tier is not a fast equivalent", () => {
  const dir = createEvidenceDir({ fast: { service_tier: "standard" } });

  assert.throws(() => verifyRequestEvidence(dir), /fast-request\.json.*fast tier/);
});

test("verifyRequestEvidence fails when standard tier uses a fast equivalent", () => {
  const dir = createEvidenceDir({ standard: { service_tier: "priority" } });

  assert.throws(() => verifyRequestEvidence(dir), /standard-request\.json.*standard tier/);
});

test("verifyBuildNumberCases covers rebuild build number boundaries", () => {
  assert.doesNotThrow(() => verifyBuildNumberCases());
});

test("verifyAsarIntegrity reads Electron plist literal Resources/app.asar key", () => {
  const { app, plist } = createAsarIntegrityFixture();

  assert.doesNotThrow(() => verifyAsarIntegrity(app, plist));
});

test("verifyUpdaterNotDisabled accepts current updater predicate shape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-updater-"));
  const app = path.join(root, "Codex-rebuild.app");
  const asarSource = path.join(root, "asar");
  const asarPath = path.join(root, "app.asar");
  fs.mkdirSync(path.join(app, "Contents", "Frameworks", "Sparkle.framework"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(asarSource, ".vite", "build"), { recursive: true });
  fs.writeFileSync(
    path.join(asarSource, ".vite", "build", "file-based-logger.js"),
    [
      "let t=require('./src-CoIhwwHr.js');",
      "let l=[t.As.Nightly,t.As.InternalAlpha,t.As.PublicBeta,t.As.Prod];",
      "let d=e=>e.CODEX_SPARKLE_ENABLED==='false';",
      "let f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
      "let h={...t.As,shouldIncludeSparkle(e,t,n=process.env){return f(e,t,'darwin',n)},shouldIncludeWindowsUpdater(){return false},shouldIncludeUpdater(e,t,n=process.env){return h.shouldIncludeSparkle(e,t,n)||h.shouldIncludeWindowsUpdater(e,t,n)}};",
    ].join("\n"),
    "utf8",
  );
  await packAsar(asarSource, asarPath);

  assert.doesNotThrow(() => verifyUpdaterNotDisabled(app, asarPath));
});
