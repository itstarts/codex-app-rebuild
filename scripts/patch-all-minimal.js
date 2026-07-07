#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PATCHES = [
  "patch-copyright.js",
  "patch-fast-mode.js",
  "patch-plugin-capabilities.js",
  "patch-update-channel.js",
];

for (const script of PATCHES) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, script), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
