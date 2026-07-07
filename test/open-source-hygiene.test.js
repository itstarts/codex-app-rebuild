const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

test("public repository metadata is present", () => {
  const files = new Set(trackedFiles());

  for (const file of [
    "README.md",
    "LICENSE",
    "NOTICE.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "doc/release-runbook.md",
  ]) {
    assert.equal(files.has(file), true, `${file} must be tracked`);
  }
});

test("tracked files do not contain local machine or internal process markers", () => {
  const forbidden = [
    /\/Users\//,
    /\bzyy\b/i,
    new RegExp("agentic " + "workers", "i"),
  ];

  for (const file of trackedFiles()) {
    const absolute = path.join(root, file);
    if (!fs.statSync(absolute).isFile()) continue;
    const content = fs.readFileSync(absolute, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${file} contains ${pattern}`);
    }
  }
});

test("internal planning artifacts are not tracked", () => {
  const files = trackedFiles();

  assert.equal(files.includes("doc/plan.md"), false);
  assert.equal(files.some((file) => file.startsWith("doc/reviews/")), false);
  assert.equal(files.some((file) => file.startsWith(".superpowers/")), false);
});
