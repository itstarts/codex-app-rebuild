const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pruneOldPublishedReleases,
  selectPublishedReleasesToDelete,
} = require("../scripts/prune-github-releases");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return body == null ? "" : JSON.stringify(body);
    },
  };
}

test("selectPublishedReleasesToDelete keeps the newest two published releases and every draft", () => {
  const releases = [
    { id: 4, tag_name: "v4", draft: false, published_at: "2026-07-14T12:00:00Z" },
    { id: 3, tag_name: "v3", draft: true, created_at: "2026-07-14T11:00:00Z" },
    { id: 2, tag_name: "v2", draft: false, published_at: "2026-07-14T10:00:00Z" },
    { id: 1, tag_name: "v1", draft: false, published_at: "2026-07-14T09:00:00Z" },
  ];

  assert.deepEqual(
    selectPublishedReleasesToDelete(releases, 2).map((release) => release.id),
    [1],
  );
});

test("pruneOldPublishedReleases paginates and deletes only older release objects", async () => {
  const calls = [];
  const pages = new Map([
    ["1", [
      { id: 4, tag_name: "v4", draft: false, published_at: "2026-07-14T12:00:00Z" },
      { id: 3, tag_name: "v3", draft: false, published_at: "2026-07-14T11:00:00Z" },
    ]],
    ["2", [
      { id: 2, tag_name: "v2", draft: true, created_at: "2026-07-14T10:00:00Z" },
      { id: 1, tag_name: "v1", draft: false, published_at: "2026-07-14T09:00:00Z" },
    ]],
    ["3", []],
  ]);
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if ((options.method || "GET") === "DELETE") {
      return response(204, null);
    }
    const page = new URL(url).searchParams.get("page");
    return response(200, pages.get(page));
  };

  const result = await pruneOldPublishedReleases({
    repo: "itstarts/codex-app-rebuild",
    token: "test-token",
    keep: 2,
    perPage: 2,
    fetchImpl,
    logger() {},
  });

  assert.deepEqual(result.deleted.map((release) => release.tag_name), ["v1"]);
  assert.deepEqual(
    calls.filter((call) => call.method === "DELETE").map((call) => call.url),
    ["https://api.github.com/repos/itstarts/codex-app-rebuild/releases/1"],
  );
});
