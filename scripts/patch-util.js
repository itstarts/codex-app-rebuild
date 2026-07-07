const fs = require("node:fs");
const path = require("node:path");
const { SRC_DIR, PLATFORM } = require("./lib/constants");

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => walkAst(item, visitor));
      continue;
    }
    if (value && typeof value === "object") {
      walkAst(value, visitor);
    }
  }
}

function applyTextPatches(source, patches) {
  let output = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    output =
      output.slice(0, patch.start) +
      patch.replacement +
      output.slice(patch.end);
  }
  return output;
}

function locateAsarBuildBundles(platform = PLATFORM) {
  const dir = path.join(SRC_DIR, platform, "_asar", ".vite", "build");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^main(-[^.]+)?\.js$/.test(name))
    .map((name) => path.join(dir, name));
}

function locateAsarAssetBundles(platform = PLATFORM) {
  const dir = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

module.exports = {
  walkAst,
  applyTextPatches,
  locateAsarBuildBundles,
  locateAsarAssetBundles,
};
