const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  generateAppcastXml,
  parseSignUpdateOutput,
  signUpdateArchive,
  verifySparkleSignature,
} = require("../scripts/generate-appcast");

function publicKeyBase64(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(-32).toString("base64");
}

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("generateAppcastXml includes Sparkle arm64 metadata", () => {
  const xml = generateAppcastXml({
    version: "2026070601020300",
    shortVersion: "26.623.101652",
    upstreamBuild: "1272",
    url: "https://github.com/itstarts/codex-app-rebuild/releases/download/v/Codex.zip",
    length: 123,
    signature: "sig",
    minimumSystemVersion: "14.0",
  });
  assert.match(xml, /sparkle:version="2026070601020300"/);
  assert.match(xml, /sparkle:shortVersionString="26\.623\.101652"/);
  assert.match(xml, /sparkle:edSignature="sig"/);
  assert.match(xml, /<codexRebuild:upstreamBuild>1272<\/codexRebuild:upstreamBuild>/);
  assert.match(xml, /length="123"/);
  assert.match(
    xml,
    /url="https:\/\/github\.com\/itstarts\/codex-app-rebuild\/releases\/download\/v\/Codex\.zip"/,
  );
  assert.match(xml, /<sparkle:minimumSystemVersion>14\.0<\/sparkle:minimumSystemVersion>/);
  assert.match(xml, /<sparkle:hardwareRequirements>arm64<\/sparkle:hardwareRequirements>/);
});

test("parseSignUpdateOutput extracts signature and length", () => {
  const parsed = parseSignUpdateOutput(
    '<enclosure sparkle:edSignature="abc" length="123" type="application/octet-stream" />',
  );
  assert.deepEqual(parsed, { signature: "abc", length: 123 });
});

test("verifySparkleSignature accepts a matching Ed25519 public key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-appcast-"));
  const archive = path.join(dir, "Codex.zip");
  fs.writeFileSync(archive, "archive payload");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(null, fs.readFileSync(archive), privateKey).toString("base64");

  assert.doesNotThrow(() =>
    verifySparkleSignature(archive, signature, publicKeyBase64(publicKey)),
  );
});

test("verifySparkleSignature rejects a mismatched Ed25519 public key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-appcast-"));
  const archive = path.join(dir, "Codex.zip");
  fs.writeFileSync(archive, "archive payload");
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const { publicKey: otherPublicKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(null, fs.readFileSync(archive), privateKey).toString("base64");

  assert.throws(
    () => verifySparkleSignature(archive, signature, publicKeyBase64(otherPublicKey)),
    /does not verify/,
  );
});

test("signUpdateArchive fails before signing when no Sparkle private key is configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-appcast-"));
  const archive = path.join(dir, "Codex.zip");
  fs.writeFileSync(archive, "archive payload");

  withEnv(
    {
      SPARKLE_PRIVATE_KEY: undefined,
      SPARKLE_PRIVATE_KEY_FILE: undefined,
    },
    () => {
      assert.throws(() => signUpdateArchive(archive), /SPARKLE_PRIVATE_KEY/);
    },
  );
});
