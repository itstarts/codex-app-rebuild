const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveOfficialUpdateStatus,
  writeGithubOutput,
} = require("../scripts/check-official-update");

const officialAppcastXml = `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <sparkle:shortVersionString>26.700.100001</sparkle:shortVersionString>
      <sparkle:version>1300</sparkle:version>
      <enclosure url="https://example.invalid/Codex.zip" />
    </item>
  </channel>
</rss>`;

function rebuildAppcastXml(shortVersion) {
  return `<?xml version="1.0"?>
  <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:codexRebuild="https://github.com/itstarts/codex-app-rebuild/appcast">
    <channel>
      <item>
        <codexRebuild:upstreamBuild>1300</codexRebuild:upstreamBuild>
        <enclosure sparkle:shortVersionString="${shortVersion}" sparkle:version="2026070601020300" />
      </item>
    </channel>
  </rss>`;
}

function rebuildAppcastXmlWithOfficialBuild(shortVersion, upstreamBuild) {
  return rebuildAppcastXml(shortVersion).replace(
    "<codexRebuild:upstreamBuild>1300</codexRebuild:upstreamBuild>",
    `<codexRebuild:upstreamBuild>${upstreamBuild}</codexRebuild:upstreamBuild>`,
  );
}

test("resolveOfficialUpdateStatus skips build when official version already has rebuild appcast", async () => {
  const status = await resolveOfficialUpdateStatus({
    officialAppcastXml,
    projectFeedXml: rebuildAppcastXml("26.700.100001"),
    releaseAssetXmls: [],
  });

  assert.equal(status.shouldBuild, false);
  assert.equal(status.shouldPromote, false);
  assert.equal(status.reason, "official_update_already_latest");
  assert.equal(status.officialVersion, "26.700.100001");
  assert.equal(status.officialBuild, "1300");
  assert.equal(status.officialUpdateKey, "26.700.100001+1300");
  assert.deepEqual(status.knownVersions, ["26.700.100001"]);
  assert.deepEqual(status.knownUpdateKeys, ["26.700.100001+1300"]);
});

test("resolveOfficialUpdateStatus builds when official version is missing from known rebuild appcasts", async () => {
  const status = await resolveOfficialUpdateStatus({
    officialAppcastXml,
    projectFeedXml: rebuildAppcastXml("26.699.100000"),
    releaseAssetXmls: [rebuildAppcastXml("26.698.999999")],
  });

  assert.equal(status.shouldBuild, true);
  assert.equal(status.shouldPromote, false);
  assert.equal(status.reason, "official_update_missing_rebuild");
  assert.deepEqual(status.knownVersions, ["26.698.999999", "26.699.100000"]);
});

test("resolveOfficialUpdateStatus promotes an existing non-latest release appcast instead of rebuilding", async () => {
  const status = await resolveOfficialUpdateStatus({
    officialAppcastXml,
    projectFeedXml: rebuildAppcastXml("26.699.100000"),
    releaseAssetXmls: [
      {
        tagName: "v26.700.100001-rebuild.2026070601020300",
        draft: true,
        xml: rebuildAppcastXml("26.700.100001"),
      },
    ],
  });

  assert.equal(status.shouldBuild, false);
  assert.equal(status.shouldPromote, true);
  assert.equal(status.reason, "official_update_has_rebuild_not_latest");
  assert.equal(status.promoteTag, "v26.700.100001-rebuild.2026070601020300");
});

test("resolveOfficialUpdateStatus builds when official short version exists with a different upstream build", async () => {
  const status = await resolveOfficialUpdateStatus({
    officialAppcastXml,
    projectFeedXml: rebuildAppcastXmlWithOfficialBuild("26.700.100001", "1299"),
    releaseAssetXmls: [],
  });

  assert.equal(status.shouldBuild, true);
  assert.equal(status.shouldPromote, false);
  assert.equal(status.reason, "official_update_missing_rebuild");
  assert.deepEqual(status.knownVersions, ["26.700.100001"]);
  assert.deepEqual(status.knownUpdateKeys, ["26.700.100001+1299"]);
});

test("resolveOfficialUpdateStatus supports manual force build", async () => {
  const status = await resolveOfficialUpdateStatus({
    officialAppcastXml,
    projectFeedXml: rebuildAppcastXml("26.700.100001"),
    releaseAssetXmls: [],
    forceBuild: true,
  });

  assert.equal(status.shouldBuild, true);
  assert.equal(status.shouldPromote, false);
  assert.equal(status.reason, "force_build");
});

test("writeGithubOutput writes GitHub Actions output keys", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rebuild-output-"));
  const outputFile = path.join(tmp, "github-output.txt");

  writeGithubOutput(
    {
      shouldBuild: true,
      reason: "official_update_missing_rebuild",
      officialVersion: "26.700.100001",
      officialBuild: "1300",
      officialUpdateKey: "26.700.100001+1300",
      knownVersions: ["26.699.100000"],
      knownUpdateKeys: [],
      shouldPromote: false,
      promoteTag: "",
    },
    outputFile,
  );

  assert.equal(
    fs.readFileSync(outputFile, "utf8"),
    [
      "should_build=true",
      "should_promote=false",
      "reason=official_update_missing_rebuild",
      "official_version=26.700.100001",
      "official_build=1300",
      "official_update_key=26.700.100001+1300",
      "promote_tag=",
      "known_version_count=1",
      "known_update_count=0",
      "",
    ].join("\n"),
  );
});
