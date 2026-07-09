const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertBundleExecutable,
  findAppBundle,
  readBundleExecutable,
} = require("../scripts/lib/app-bundle-utils");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writePlist(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.entries(values)
    .map(([key, value]) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`)
    .join("\n");
  fs.writeFileSync(
    file,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      entries,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createAppBundle(root, relativePath, executable = "Codex") {
  const appPath = path.join(root, relativePath);
  const resources = path.join(appPath, "Contents", "Resources");
  const macos = path.join(appPath, "Contents", "MacOS");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "fixture");
  writePlist(path.join(appPath, "Contents", "Info.plist"), {
    CFBundleExecutable: executable,
  });
  const executablePath = path.join(macos, executable);
  fs.writeFileSync(executablePath, "fixture");
  fs.chmodSync(executablePath, 0o755);
  return appPath;
}

test("findAppBundle returns one legacy outer Codex.app candidate", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, path.join("outer", "inner", "Codex.app"));

  assert.equal(findAppBundle(root), app);
});

test("findAppBundle returns one renamed outer ChatGPT.app candidate", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.equal(findAppBundle(root), app);
});

test("findAppBundle does not enter nested app bundles", (t) => {
  const root = createRoot(t);
  createAppBundle(
    root,
    path.join("Wrapper.app", "Contents", "Helpers", "Nested.app"),
  );

  assert.equal(findAppBundle(root), "");
});

test("findAppBundle rejects multiple outer app candidates", (t) => {
  const root = createRoot(t);
  createAppBundle(root, "Codex.app");
  createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.throws(() => findAppBundle(root), /Multiple upstream app bundles/);
});

test("findAppBundle rejects an app.asar directory", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  fs.rmSync(asarPath);
  fs.mkdirSync(asarPath);

  assert.equal(findAppBundle(root), "");
});

test("findAppBundle rejects an app.asar symbolic link", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const target = path.join(root, "outside.asar");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  fs.writeFileSync(target, "fixture");
  fs.rmSync(asarPath);
  fs.symlinkSync(target, asarPath);

  assert.equal(findAppBundle(root), "");
});

test("findAppBundle rejects a symbolic link in the app.asar path", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const outside = path.join(root, "outside-resources");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "app.asar"), "fixture");
  fs.rmSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.symlinkSync(outside, path.join(app, "Contents", "Resources"));

  assert.throws(() => findAppBundle(root), /symbolic link|outside app bundle/i);
});

test("readBundleExecutable returns the upstream executable", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.deepEqual(readBundleExecutable(app), {
    name: "ChatGPT",
    path: path.join(app, "Contents", "MacOS", "ChatGPT"),
  });
});

test("readBundleExecutable rejects a missing executable", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  fs.rmSync(path.join(app, "Contents", "MacOS", "ChatGPT"));

  assert.throws(() => readBundleExecutable(app), /app bundle executable not found/);
});

test("readBundleExecutable rejects an executable directory", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const executable = path.join(app, "Contents", "MacOS", "ChatGPT");
  fs.rmSync(executable);
  fs.mkdirSync(executable);

  assert.throws(() => readBundleExecutable(app), /app bundle executable not found/);
});

test("readBundleExecutable rejects an executable symbolic link", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const target = path.join(root, "outside-executable");
  const executable = path.join(app, "Contents", "MacOS", "ChatGPT");
  fs.writeFileSync(target, "fixture");
  fs.chmodSync(target, 0o755);
  fs.rmSync(executable);
  fs.symlinkSync(target, executable);

  assert.throws(() => readBundleExecutable(app), /symbolic link/);
});

test("readBundleExecutable rejects a symbolic Contents directory", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const contents = path.join(app, "Contents");
  const outside = path.join(root, "outside-contents");
  fs.renameSync(contents, outside);
  fs.symlinkSync(outside, contents);

  assert.throws(() => readBundleExecutable(app), /symbolic link|outside app bundle/i);
});

test("readBundleExecutable rejects a symbolic Info.plist", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const plist = path.join(app, "Contents", "Info.plist");
  const outside = path.join(root, "outside-info.plist");
  fs.renameSync(plist, outside);
  fs.symlinkSync(outside, plist);

  assert.throws(() => readBundleExecutable(app), /symbolic link|outside app bundle/i);
});

test("readBundleExecutable rejects a symbolic MacOS directory", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  const macos = path.join(app, "Contents", "MacOS");
  const outside = path.join(root, "outside-macos");
  fs.renameSync(macos, outside);
  fs.symlinkSync(outside, macos);

  assert.throws(() => readBundleExecutable(app), /symbolic link|outside app bundle/i);
});

test("readBundleExecutable rejects a file without execute permission", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  fs.chmodSync(path.join(app, "Contents", "MacOS", "ChatGPT"), 0o644);

  assert.throws(() => readBundleExecutable(app), /EACCES/);
});

test("readBundleExecutable rejects a non-basename plist value", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");
  writePlist(path.join(app, "Contents", "Info.plist"), {
    CFBundleExecutable: "../ChatGPT",
  });

  assert.throws(() => readBundleExecutable(app), /Invalid CFBundleExecutable/);
});

test("assertBundleExecutable accepts the expected executable", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.equal(assertBundleExecutable(app, "ChatGPT").name, "ChatGPT");
});

test("assertBundleExecutable rejects a missing expected name", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.throws(() => assertBundleExecutable(app, ""), /expected bundle executable name/);
});

test("assertBundleExecutable rejects a mismatched expected name", (t) => {
  const root = createRoot(t);
  const app = createAppBundle(root, "ChatGPT.app", "ChatGPT");

  assert.throws(
    () => assertBundleExecutable(app, "Codex"),
    /bundle executable mismatch: expected Codex, got ChatGPT/,
  );
});
