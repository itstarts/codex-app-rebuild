const fs = require("node:fs");
const path = require("node:path");
const { SRC_DIR, PLATFORM } = require("./lib/constants");

const PATCH_CHECK_ASAR_ROOT_ENV = "CODEX_REBUILD_PATCH_CHECK_ASAR_ROOT";

function resolveAsarRoot(platform = PLATFORM, env = process.env) {
  const override = env[PATCH_CHECK_ASAR_ROOT_ENV]?.trim();
  return override ? path.resolve(override) : path.join(SRC_DIR, platform, "_asar");
}

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
  const dir = path.join(resolveAsarRoot(platform), ".vite", "build");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^main(-[^.]+)?\.js$/.test(name))
    .map((name) => path.join(dir, name));
}

function locateAsarAssetBundles(platform = PLATFORM) {
  const dir = path.join(resolveAsarRoot(platform), "webview", "assets");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

module.exports = {
  PATCH_CHECK_ASAR_ROOT_ENV,
  walkAst,
  applyTextPatches,
  resolveAsarRoot,
  locateAsarBuildBundles,
  locateAsarAssetBundles,
};
