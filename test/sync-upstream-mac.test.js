const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseAppcast, findAppBundle } = require("../scripts/sync-upstream-mac");

test("parseAppcast extracts latest macOS arm64 metadata", () => {
  const xml = fs.readFileSync(path.join(__dirname, "fixtures", "appcast-arm64.xml"), "utf8");
  assert.deepEqual(parseAppcast(xml), {
    version: "26.623.101652",
    build: "1272",
    minimumSystemVersion: "14.0",
    downloadUrl: "https://persistent.oaistatic.com/codex-app-prod/Codex.zip",
  });
});

test("findAppBundle returns nested Codex.app path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-"));
  const nested = path.join(root, "outer", "inner", "Codex.app");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findAppBundle(root), nested);
});
