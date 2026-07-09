const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseAppcast, findAppBundle } = require("../scripts/sync-upstream-mac");

function createAsarApp(root, relativePath) {
  const app = path.join(root, relativePath);
  const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "fixture");
  return app;
}

test("parseAppcast extracts latest macOS arm64 metadata", () => {
  const xml = fs.readFileSync(path.join(__dirname, "fixtures", "appcast-arm64.xml"), "utf8");
  assert.deepEqual(parseAppcast(xml), {
    version: "26.623.101652",
    build: "1272",
    minimumSystemVersion: "14.0",
    downloadUrl: "https://persistent.oaistatic.com/codex-app-prod/Codex.zip",
  });
});

test("findAppBundle returns nested Codex.app path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = createAsarApp(root, path.join("outer", "inner", "Codex.app"));
  assert.equal(findAppBundle(root), nested);
});

test("findAppBundle returns renamed ChatGPT.app path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = createAsarApp(root, "ChatGPT.app");
  assert.equal(findAppBundle(root), nested);
});
