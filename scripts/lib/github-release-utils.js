const https = require("node:https");
const { XMLParser } = require("fast-xml-parser");
const { FEED_URL } = require("./constants");
const { compareBuildNumbers, validateBuildNumber } = require("./version-utils");

function httpGetText(url, { json = false, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "codex-app-rebuild", ...extraHeaders };

    if (process.env.GITHUB_TOKEN && url.includes("api.github.com")) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGetText(res.headers.location, { json, headers: extraHeaders }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(json ? JSON.parse(text) : text);
        });
      })
      .on("error", reject);
  });
}

function flattenValues(value, out = []) {
  if (value == null) {
    return out;
  }
  if (typeof value === "string" || typeof value === "number") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenValues(item, out);
    }
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      flattenValues(item, out);
    }
  }
  return out;
}

function extractBuildNumbersFromAppcast(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
  });
  const parsed = parser.parse(xml);
  const values = flattenValues(parsed);
  const fromXmlValues = values.filter((value) => /^\d{16}$/.test(value));
  const fromRawAttrs = [...xml.matchAll(/sparkle:version=["'](\d{16})["']/g)].map(
    (match) => match[1],
  );
  return [...new Set([...fromXmlValues, ...fromRawAttrs])];
}

function extractShortVersionsFromAppcast(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
  });
  const parsed = parser.parse(xml);
  const values = flattenValues(parsed);
  const fromXmlValues = values.filter((value) => /^\d+\.\d+\.\d+/.test(value));
  const fromRawAttrs = [
    ...xml.matchAll(/sparkle:shortVersionString=["']([^"']+)["']/g),
  ].map((match) => match[1]);
  return [...new Set([...fromXmlValues, ...fromRawAttrs])];
}

function toArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function officialUpdateKey(shortVersion, upstreamBuild) {
  return `${String(shortVersion)}+${String(upstreamBuild)}`;
}

function extractOfficialUpdateKeysFromAppcast(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
  });
  const parsed = parser.parse(xml);
  const items = toArray(parsed.rss?.channel?.item);
  const keys = [];

  for (const item of items) {
    const enclosure = toArray(item?.enclosure)[0] || {};
    const shortVersion = item?.shortVersionString || enclosure["@_shortVersionString"] || "";
    const upstreamBuild = item?.upstreamBuild || "";
    if (shortVersion && upstreamBuild) {
      keys.push(officialUpdateKey(shortVersion, upstreamBuild));
    }
  }

  return [...new Set(keys)];
}

function maxBuildNumber(values) {
  const valid = values.filter(Boolean);
  if (valid.length === 0) {
    return "";
  }
  for (const value of valid) {
    validateBuildNumber(value, "published build number");
  }
  return valid.sort(compareBuildNumbers).at(-1);
}

async function fetchGithubReleaseAppcastXmls({
  owner = "itstarts",
  repo = "codex-app-rebuild",
  includeDrafts = false,
} = {}) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`;
  const releases = await httpGetText(url, { json: true });
  const xmls = [];
  for (const release of releases.filter((item) => includeDrafts || !item.draft)) {
    for (const asset of release.assets || []) {
      if (asset.name === "appcast-darwin-arm64.xml" && (asset.url || asset.browser_download_url)) {
        const url = asset.url || asset.browser_download_url;
        const options = asset.url ? { headers: { Accept: "application/octet-stream" } } : {};
        xmls.push({
          tagName: release.tag_name || release.name || "",
          draft: Boolean(release.draft),
          prerelease: Boolean(release.prerelease),
          xml: await httpGetText(url, options),
        });
      }
    }
  }
  return xmls;
}

async function resolvePreviousMaxBuildNumber({
  feedUrl = process.env.REBUILD_FEED_URL || FEED_URL,
  manual = process.env.REBUILD_PREVIOUS_MAX_BUILD_NUMBER || "",
  feedXml,
  releaseAssetXmls,
  allowNoPreviousRelease = false,
} = {}) {
  const values = [];

  if (manual) {
    validateBuildNumber(manual, "REBUILD_PREVIOUS_MAX_BUILD_NUMBER");
    values.push(manual);
  }

  if (feedXml !== undefined) {
    values.push(...extractBuildNumbersFromAppcast(feedXml));
  } else {
    try {
      values.push(...extractBuildNumbersFromAppcast(await httpGetText(feedUrl)));
    } catch (error) {
      if (!manual && !allowNoPreviousRelease) {
        throw error;
      }
    }
  }

  if (releaseAssetXmls !== undefined) {
    for (const xml of releaseAssetXmls) {
      values.push(...extractBuildNumbersFromAppcast(xml));
    }
  } else {
    try {
      for (const releaseAsset of await fetchGithubReleaseAppcastXmls()) {
        values.push(...extractBuildNumbersFromAppcast(releaseAsset.xml));
      }
    } catch (error) {
      if (!manual && !allowNoPreviousRelease) {
        throw error;
      }
    }
  }

  const previousMax = maxBuildNumber(values);
  if (!previousMax && !allowNoPreviousRelease) {
    throw new Error(
      "No previous published build number found; set REBUILD_PREVIOUS_MAX_BUILD_NUMBER or pass --allow-no-previous-release for local development",
    );
  }
  return previousMax;
}

module.exports = {
  httpGetText,
  extractBuildNumbersFromAppcast,
  extractOfficialUpdateKeysFromAppcast,
  extractShortVersionsFromAppcast,
  officialUpdateKey,
  maxBuildNumber,
  fetchGithubReleaseAppcastXmls,
  resolvePreviousMaxBuildNumber,
};
