const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");
const PLATFORM = "mac-arm64";
const APP_NAME = "ChatGPT-Rebuild";
const APP_BUNDLE_NAME = "ChatGPT-Rebuild.app";
const BUNDLE_ID = "io.github.itstarts.codex-rebuild";
const FEED_URL =
  "https://github.com/itstarts/codex-app-rebuild/releases/latest/download/appcast-darwin-arm64.xml";
const PUBLIC_KEY_PATH = path.join(
  PROJECT_ROOT,
  "config",
  "sparkle",
  "public-ed-key.txt",
);

module.exports = {
  PROJECT_ROOT,
  SRC_DIR,
  OUT_DIR,
  PLATFORM,
  APP_NAME,
  APP_BUNDLE_NAME,
  BUNDLE_ID,
  FEED_URL,
  PUBLIC_KEY_PATH,
};
