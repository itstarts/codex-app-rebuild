const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FEED_URL } = require("../scripts/lib/constants");
const { patchPackageJson, readPublicKey, run } = require("../scripts/patch-update-channel");

function fixturePath(name) {
  return path.join(__dirname, "fixtures", name);
}

function withTempPublicKey(value) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-update-channel-"));
  const file = path.join(tmp, "config", "sparkle", "public-ed-key.txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, "utf8");
  return file;
}

function withTempPackage() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-update-channel-"));
  const file = path.join(tmp, "src", "mac-arm64", "_asar", "package.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(fixturePath("package-updater.json"), file);
  return file;
}

test("patchPackageJson rewrites runtime Sparkle feed and public key", () => {
  const pkg = JSON.parse(fs.readFileSync(fixturePath("package-updater.json"), "utf8"));
  const patched = patchPackageJson(pkg, "public-key");
  assert.equal(patched.codexSparkleFeedUrl, FEED_URL);
  assert.equal(patched.codexSparklePublicKey, "public-key");
});

test("patchPackageJson does not mutate input package", () => {
  const pkg = JSON.parse(fs.readFileSync(fixturePath("package-updater.json"), "utf8"));
  const original = structuredClone(pkg);
  patchPackageJson(pkg, "public-key");
  assert.deepEqual(pkg, original);
});

test("patchPackageJson rejects packages missing update channel fields", () => {
  assert.throws(
    () => patchPackageJson({ codexSparklePublicKey: "official-key" }, "public-key"),
    /codexSparkleFeedUrl field not found/,
  );
  assert.throws(
    () => patchPackageJson({ codexSparkleFeedUrl: "https://example.test/appcast.xml" }, "public-key"),
    /codexSparklePublicKey field not found/,
  );
});

test("readPublicKey trims a real public key", () => {
  const publicKeyPath = withTempPublicKey(" public-key \n");
  assert.equal(readPublicKey(publicKeyPath), "public-key");
});

test("readPublicKey rejects empty and sentinel public keys", () => {
  assert.throws(
    () => readPublicKey(withTempPublicKey("\n")),
    /must contain the real Sparkle public EdDSA key/,
  );
  assert.throws(
    () => readPublicKey(withTempPublicKey("ed25519-test-public-key-change-before-release\n")),
    /must contain the real Sparkle public EdDSA key/,
  );
});

test("run check mode reports update channel patch without writing package", () => {
  const packagePath = withTempPackage();
  const publicKeyPath = withTempPublicKey("public-key\n");
  const before = fs.readFileSync(packagePath, "utf8");
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(value);
  try {
    run({ check: true, packagePath, publicKeyPath });
  } finally {
    console.log = originalLog;
  }
  assert.equal(fs.readFileSync(packagePath, "utf8"), before);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /codexSparkleFeedUrl,codexSparklePublicKey/);
});

test("run patches package when check mode is disabled", () => {
  const packagePath = withTempPackage();
  const publicKeyPath = withTempPublicKey("public-key\n");
  const originalLog = console.log;
  console.log = () => {};
  try {
    run({ packagePath, publicKeyPath });
  } finally {
    console.log = originalLog;
  }
  const patched = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(patched.codexSparkleFeedUrl, FEED_URL);
  assert.equal(patched.codexSparklePublicKey, "public-key");
});
