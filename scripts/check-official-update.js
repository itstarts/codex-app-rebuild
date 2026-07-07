#!/usr/bin/env node

const { FEED_URL } = require("./lib/constants");
const {
  extractOfficialUpdateKeysFromAppcast,
  extractShortVersionsFromAppcast,
  fetchGithubReleaseAppcastXmls,
  httpGetText,
  officialUpdateKey,
} = require("./lib/github-release-utils");
const { APPCAST_URL, parseAppcast } = require("./sync-upstream-mac");

function addKnownAppcast(targetVersions, targetUpdateKeys, xml) {
  for (const version of extractShortVersionsFromAppcast(xml)) {
    targetVersions.add(version);
  }
  for (const key of extractOfficialUpdateKeysFromAppcast(xml)) {
    targetUpdateKeys.add(key);
  }
}

function normalizeReleaseAssetXmls(releaseAssetXmls) {
  return releaseAssetXmls.map((item) =>
    typeof item === "string" ? { tagName: "", draft: false, xml: item } : item,
  );
}

async function resolveOfficialUpdateStatus({
  officialAppcastXml,
  projectFeedXml,
  releaseAssetXmls,
  forceBuild = false,
  feedUrl = process.env.REBUILD_FEED_URL || FEED_URL,
} = {}) {
  const officialXml = officialAppcastXml ?? (await httpGetText(APPCAST_URL));
  const official = parseAppcast(officialXml);
  if (!official.version) {
    throw new Error("official appcast missing short version");
  }
  if (!official.build) {
    throw new Error("official appcast missing sparkle version");
  }
  const officialKey = officialUpdateKey(official.version, official.build);

  const knownVersions = new Set();
  const knownUpdateKeys = new Set();
  const latestUpdateKeys = new Set();
  if (projectFeedXml !== undefined) {
    addKnownAppcast(knownVersions, knownUpdateKeys, projectFeedXml);
    addKnownAppcast(new Set(), latestUpdateKeys, projectFeedXml);
  } else {
    try {
      const latestXml = await httpGetText(feedUrl);
      addKnownAppcast(knownVersions, knownUpdateKeys, latestXml);
      addKnownAppcast(new Set(), latestUpdateKeys, latestXml);
    } catch (error) {
      console.warn(`warning: could not read rebuild latest feed ${feedUrl}: ${error.message}`);
    }
  }

  const releaseXmls =
    releaseAssetXmls !== undefined
      ? normalizeReleaseAssetXmls(releaseAssetXmls)
      : await fetchGithubReleaseAppcastXmls({ includeDrafts: true });
  let promoteTag = "";
  for (const releaseAsset of releaseXmls) {
    addKnownAppcast(knownVersions, knownUpdateKeys, releaseAsset.xml);
    const releaseUpdateKeys = new Set();
    addKnownAppcast(new Set(), releaseUpdateKeys, releaseAsset.xml);
    if (!promoteTag && releaseUpdateKeys.has(officialKey)) {
      promoteTag = releaseAsset.tagName || "";
    }
  }

  const latestHasOfficialUpdate = latestUpdateKeys.has(officialKey);
  const anyReleaseHasOfficialUpdate = knownUpdateKeys.has(officialKey);
  const shouldPromote = Boolean(!forceBuild && !latestHasOfficialUpdate && anyReleaseHasOfficialUpdate);
  const shouldBuild = Boolean(forceBuild || (!latestHasOfficialUpdate && !anyReleaseHasOfficialUpdate));
  const reason = forceBuild
    ? "force_build"
    : latestHasOfficialUpdate
      ? "official_update_already_latest"
      : anyReleaseHasOfficialUpdate
        ? "official_update_has_rebuild_not_latest"
        : "official_update_missing_rebuild";

  return {
    shouldBuild,
    shouldPromote,
    reason,
    officialVersion: official.version,
    officialBuild: official.build,
    officialUpdateKey: officialKey,
    promoteTag,
    knownVersions: [...knownVersions].sort(),
    knownUpdateKeys: [...knownUpdateKeys].sort(),
  };
}

function writeGithubOutput(status, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) {
    return;
  }
  const fs = require("node:fs");
  fs.appendFileSync(
    outputFile,
    [
      `should_build=${status.shouldBuild ? "true" : "false"}`,
      `should_promote=${status.shouldPromote ? "true" : "false"}`,
      `reason=${status.reason}`,
      `official_version=${status.officialVersion}`,
      `official_build=${status.officialBuild || ""}`,
      `official_update_key=${status.officialUpdateKey || ""}`,
      `promote_tag=${status.promoteTag || ""}`,
      `known_version_count=${status.knownVersions.length}`,
      `known_update_count=${status.knownUpdateKeys.length}`,
    ].join("\n") + "\n",
  );
}

async function main(env = process.env) {
  const status = await resolveOfficialUpdateStatus({
    forceBuild: env.REBUILD_FORCE_BUILD === "1" || env.REBUILD_FORCE_BUILD === "true",
  });
  writeGithubOutput(status, env.GITHUB_OUTPUT);
  console.log(JSON.stringify(status, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  resolveOfficialUpdateStatus,
  writeGithubOutput,
};
