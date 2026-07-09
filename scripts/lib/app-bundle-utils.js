const fs = require("node:fs");
const path = require("node:path");
const { plutilGet } = require("./plist-utils");

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertDirectoryInside(root, target, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isInside(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} is outside app bundle: ${absoluteTarget}`);
  }

  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must not be a symbolic link: ${absoluteRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${label} root is not a directory: ${absoluteRoot}`);
  }

  const segments = path.relative(absoluteRoot, absoluteTarget).split(path.sep).filter(Boolean);
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path contains a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} path component is not a directory: ${current}`);
    }
  }

  const realRoot = fs.realpathSync(absoluteRoot);
  const realTarget = fs.realpathSync(absoluteTarget);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`${label} resolves outside app bundle: ${realTarget}`);
  }
  return absoluteTarget;
}

function regularFileInside(root, target, label, { softFinal = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isInside(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} is outside app bundle: ${absoluteTarget}`);
  }

  const relative = path.relative(absoluteRoot, absoluteTarget);
  const segments = relative.split(path.sep).filter(Boolean);
  assertDirectoryInside(absoluteRoot, absoluteRoot, "app bundle root");
  let current = absoluteRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (softFinal && error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path contains a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} path component is not a directory: ${current}`);
    }
  }

  let stat;
  try {
    stat = fs.lstatSync(absoluteTarget);
  } catch (error) {
    if (softFinal && error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    if (softFinal) return null;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${absoluteTarget}`);
    }
    throw new Error(`${label} must be a regular file: ${absoluteTarget}`);
  }

  const realRoot = fs.realpathSync(absoluteRoot);
  const realTarget = fs.realpathSync(absoluteTarget);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`${label} resolves outside app bundle: ${realTarget}`);
  }
  return absoluteTarget;
}

function hasAppAsar(appPath) {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  return regularFileInside(appPath, asarPath, "app.asar", { softFinal: true }) !== null;
}

function findAppBundle(root) {
  const candidates = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.name.endsWith(".app")) {
        assertDirectoryInside(root, fullPath, "app bundle");
        if (hasAppAsar(fullPath)) {
          candidates.push(fullPath);
        }
        continue;
      }

      visit(fullPath);
    }
  }

  visit(root);
  candidates.sort();
  if (candidates.length > 1) {
    throw new Error(
      `Multiple upstream app bundles containing app.asar: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] || "";
}

function readBundleExecutable(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  regularFileInside(appPath, plist, "Info.plist");
  const name = plutilGet(plist, "CFBundleExecutable");
  if (!name || name !== path.basename(name)) {
    throw new Error(`Invalid CFBundleExecutable in app bundle: ${name}`);
  }

  const executablePath = path.join(appPath, "Contents", "MacOS", name);
  try {
    regularFileInside(appPath, executablePath, "app bundle executable");
  } catch (error) {
    if (/symbolic link|outside app bundle/.test(error.message)) throw error;
    throw new Error(`app bundle executable not found: ${executablePath}`);
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  return { name, path: executablePath };
}

function assertBundleExecutable(appPath, expectedName) {
  if (!expectedName) {
    throw new Error("expected bundle executable name is required");
  }

  const executable = readBundleExecutable(appPath);
  if (executable.name !== expectedName) {
    throw new Error(
      `bundle executable mismatch: expected ${expectedName}, got ${executable.name}`,
    );
  }
  return executable;
}

module.exports = {
  assertBundleExecutable,
  findAppBundle,
  readBundleExecutable,
};
