const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractBuildNumbersFromAppcast,
  extractOfficialUpdateKeysFromAppcast,
  extractShortVersionsFromAppcast,
  maxBuildNumber,
  officialUpdateKey,
  resolvePreviousMaxBuildNumber,
} = require("../scripts/lib/github-release-utils");

test("extractBuildNumbersFromAppcast reads every sparkle version", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
    <item><enclosure sparkle:version="2026070601020301" /></item>
    <item><enclosure sparkle:version="2026070601020400" /></item>
  </channel></rss>`;
  assert.deepEqual(extractBuildNumbersFromAppcast(xml), [
    "2026070601020301",
    "2026070601020400",
  ]);
});

test("extractShortVersionsFromAppcast reads every Sparkle short version", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
    <item><enclosure sparkle:shortVersionString="26.623.101652" /></item>
    <item><sparkle:shortVersionString>26.624.101653</sparkle:shortVersionString></item>
  </channel></rss>`;
  assert.deepEqual(extractShortVersionsFromAppcast(xml).sort(), [
    "26.623.101652",
    "26.624.101653",
  ]);
});

test("extractOfficialUpdateKeysFromAppcast pairs rebuild short version with official upstream build", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:codexRebuild="https://github.com/itstarts/codex-app-rebuild/appcast"><channel>
    <item>
      <codexRebuild:upstreamBuild>1300</codexRebuild:upstreamBuild>
      <enclosure sparkle:shortVersionString="26.700.100001" sparkle:version="2026070601020300" />
    </item>
  </channel></rss>`;
  assert.deepEqual(extractOfficialUpdateKeysFromAppcast(xml), [
    officialUpdateKey("26.700.100001", "1300"),
  ]);
});

test("maxBuildNumber ignores empty values and returns numeric max", () => {
  assert.equal(
    maxBuildNumber(["", "2026070601020301", "2026070601020400"]),
    "2026070601020400",
  );
});

test("resolvePreviousMaxBuildNumber includes manual value and takes max", async () => {
  const previous = await resolvePreviousMaxBuildNumber({
    manual: "2026070601020301",
    feedXml:
      '<rss><channel><item><enclosure sparkle:version="2026070601020400" /></item></channel></rss>',
    releaseAssetXmls: [
      '<rss><channel><item><enclosure sparkle:version="2026070601020302" /></item></channel></rss>',
    ],
  });
  assert.equal(previous, "2026070601020400");
});
