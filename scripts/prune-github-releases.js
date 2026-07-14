#!/usr/bin/env node

const API_VERSION = "2022-11-28";
const DEFAULT_KEEP_COUNT = 2;

function validateKeepCount(keep) {
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new Error("release retention count must be a positive integer");
  }
}

function validateRepository(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "")) {
    throw new Error("GITHUB_REPOSITORY must use owner/repo format");
  }
}

function publishedTimestamp(release) {
  const value = release.published_at || release.created_at;
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    throw new Error(`release ${release.tag_name || release.id || "<unknown>"} has no valid timestamp`);
  }
  return timestamp;
}

function selectPublishedReleasesToDelete(releases, keep = DEFAULT_KEEP_COUNT) {
  if (!Array.isArray(releases)) {
    throw new Error("GitHub releases response must be an array");
  }
  validateKeepCount(keep);

  return releases
    .filter((release) => !release.draft)
    .sort(
      (left, right) =>
        publishedTimestamp(right) - publishedTimestamp(left) || Number(right.id) - Number(left.id),
    )
    .slice(keep);
}

async function githubRequest(
  url,
  { token, method = "GET", fetchImpl = globalThis.fetch } = {},
) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to prune releases");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub API ${method} ${url} failed: HTTP ${response.status} ${detail}`.trim());
  }
  return response.status === 204 ? null : response.json();
}

async function fetchAllReleases({
  repo,
  token,
  fetchImpl = globalThis.fetch,
  perPage = 100,
}) {
  validateRepository(repo);
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Error("perPage must be an integer from 1 to 100");
  }

  const releases = [];
  for (let page = 1; ; page += 1) {
    const pageReleases = await githubRequest(
      `https://api.github.com/repos/${repo}/releases?per_page=${perPage}&page=${page}`,
      { token, fetchImpl },
    );
    if (!Array.isArray(pageReleases)) {
      throw new Error("GitHub releases response must be an array");
    }
    releases.push(...pageReleases);
    if (pageReleases.length < perPage) {
      return releases;
    }
  }
}

async function pruneOldPublishedReleases({
  repo,
  token,
  keep = DEFAULT_KEEP_COUNT,
  fetchImpl = globalThis.fetch,
  perPage = 100,
  logger = console.log,
}) {
  validateKeepCount(keep);
  const releases = await fetchAllReleases({ repo, token, fetchImpl, perPage });
  const deleted = selectPublishedReleasesToDelete(releases, keep);

  for (const release of deleted) {
    if (!Number.isSafeInteger(Number(release.id))) {
      throw new Error(`release ${release.tag_name || "<unknown>"} has no valid id`);
    }
    await githubRequest(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
      token,
      method: "DELETE",
      fetchImpl,
    });
    logger(`Deleted old release ${release.tag_name || release.id}; Git tag preserved.`);
  }

  if (deleted.length === 0) {
    logger(`No published releases need pruning; keeping the newest ${keep}.`);
  }
  return { releases, deleted };
}

async function main(env = process.env) {
  const keep = Number(env.RELEASE_RETENTION_COUNT || DEFAULT_KEEP_COUNT);
  await pruneOldPublishedReleases({
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    keep,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  fetchAllReleases,
  githubRequest,
  main,
  pruneOldPublishedReleases,
  selectPublishedReleasesToDelete,
};
