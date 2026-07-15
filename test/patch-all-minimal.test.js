const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packAsar } = require("../scripts/lib/asar-utils");
const {
  PATCHES,
  verifyOriginalAsar,
  run,
} = require("../scripts/patch-all-minimal");
const { PATCH_CHECK_ASAR_ROOT_ENV } = require("../scripts/patch-util");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function createProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-all-minimal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "asar-source");
  const appPath = path.join(root, "src", "mac-arm64", "upstream", "Codex.app");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"fixture"}\n');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  await packAsar(source, asarPath);
  const metadata = {
    appPath: path.relative(root, appPath),
    appAsarSha256: sha256(asarPath),
  };
  fs.writeFileSync(
    path.join(root, "src", "mac-arm64", "upstream-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return { root, asarPath };
}

test("patch check retains the original ASAR hash gate", async (t) => {
  const fixture = await createProject(t);
  assert.equal(verifyOriginalAsar({ projectRoot: fixture.root }), fixture.asarPath);

  fs.appendFileSync(fixture.asarPath, "changed");

  assert.throws(
    () => verifyOriginalAsar({ projectRoot: fixture.root }),
    /original app\.asar hash does not match upstream metadata/,
  );
});

test("patch check runs every patch against a disposable original ASAR snapshot", async (t) => {
  const fixture = await createProject(t);
  const calls = [];

  const status = await run({
    argv: ["--check"],
    projectRoot: fixture.root,
    spawnSyncImpl(command, args, options) {
      const asarRoot = options.env[PATCH_CHECK_ASAR_ROOT_ENV];
      assert.equal(fs.existsSync(path.join(asarRoot, "package.json")), true);
      calls.push({ command, args, asarRoot });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, PATCHES.length);
  assert.deepEqual(
    calls.map((call) => path.basename(call.args[0])),
    PATCHES,
  );
  assert.equal(new Set(calls.map((call) => call.asarRoot)).size, 1);
  assert.equal(fs.existsSync(path.dirname(calls[0].asarRoot)), false);
});

test("patch mode ignores a stale snapshot override", async () => {
  const previous = process.env[PATCH_CHECK_ASAR_ROOT_ENV];
  process.env[PATCH_CHECK_ASAR_ROOT_ENV] = path.join(
    os.tmpdir(),
    "stale-patch-check-root",
  );
  const calls = [];
  try {
    const status = await run({
      argv: [],
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
  } finally {
    if (previous === undefined) delete process.env[PATCH_CHECK_ASAR_ROOT_ENV];
    else process.env[PATCH_CHECK_ASAR_ROOT_ENV] = previous;
  }

  assert.equal(calls.length, PATCHES.length);
  for (const call of calls) {
    assert.equal(call.env[PATCH_CHECK_ASAR_ROOT_ENV], undefined);
  }
});
