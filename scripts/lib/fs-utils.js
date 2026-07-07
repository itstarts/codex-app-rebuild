const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value, "utf8");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(sp, dp);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(sp), dp);
      } catch {}
      continue;
    }
    fs.copyFileSync(sp, dp);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });

  if (result.status !== 0) {
    if (options.sensitive) {
      throw new Error(
        `${command} ${args.join(" ")} failed; stderr/stdout hidden because command handled sensitive input`,
      );
    }
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout || "";
}

module.exports = {
  ensureDir,
  readText,
  writeText,
  sha256File,
  copyRecursive,
  run,
};
