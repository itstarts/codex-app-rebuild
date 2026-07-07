const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateBuildNumber,
  compareBuildNumbers,
  assertBuildNumberGreater,
} = require("../scripts/lib/version-utils");

test("generateBuildNumber returns fixed-width UTC timestamp plus sequence", () => {
  const value = generateBuildNumber(new Date("2026-07-06T01:02:03Z"), 4);
  assert.equal(value, "2026070601020304");
});

test("compareBuildNumbers compares fixed-width decimal strings safely", () => {
  assert.equal(compareBuildNumbers("2026070601020301", "2026070601020300"), 1);
  assert.equal(compareBuildNumbers("2026070601020301", "2026070601020301"), 0);
  assert.equal(compareBuildNumbers("2026070601020300", "2026070601020301"), -1);
  assert.equal(compareBuildNumbers("2026070601020400", "2026070601020301"), 1);
});

test("assertBuildNumberGreater rejects equal and smaller candidates", () => {
  assert.throws(
    () => assertBuildNumberGreater("2026070601020301", "2026070601020301"),
    /not greater/,
  );
  assert.throws(
    () => assertBuildNumberGreater("2026070601020300", "2026070601020301"),
    /not greater/,
  );
  assert.doesNotThrow(() =>
    assertBuildNumberGreater("2026070601020302", "2026070601020301"),
  );
  assert.doesNotThrow(() =>
    assertBuildNumberGreater("2026070601020400", "2026070601020301"),
  );
});
