const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  collectCopyrightPatches,
  run,
} = require("../scripts/patch-copyright");
const { applyTextPatches } = require("../scripts/patch-util");

test("copyright patch replaces only About copyright value", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures", "main-copyright.js"),
    "utf8",
  );
  const patches = collectCopyrightPatches(source);
  assert.equal(patches.length, 1);
  const output = applyTextPatches(source, patches);
  assert.match(output, /© OpenAI · itstarts Rebuild/);
});

test("copyright patch ignores non-About copyright values", () => {
  const source = 'const dialog={title:"About",copyright:"© OpenAI"};';
  const patches = collectCopyrightPatches(source);
  assert.equal(patches.length, 0);
});

test("copyright patch updates static template literal in About panel", () => {
  const source =
    'function setup(app){app.setAboutPanelOptions({copyright:`© OpenAI`})}';
  const patches = collectCopyrightPatches(source);
  assert.equal(patches.length, 1);
  const output = applyTextPatches(source, patches);
  assert.match(output, /`© OpenAI · itstarts Rebuild`/);
});

test("copyright patch updates custom About HTML template", () => {
  const source = `function renderAboutHtml(appName, buildInfo) {
  return \`<main class="dialog">
    <section class="content" aria-labelledby="app-name">
      <div class="app-name" id="app-name">\${appName}</div>
      <pre class="build-info" aria-label="Build info">\${buildInfo}</pre>
      <div class="copyright">© OpenAI</div>
    </section>
  </main>\`;
}`;
  const patches = collectCopyrightPatches(source);
  assert.equal(patches.length, 1);
  const output = applyTextPatches(source, patches);
  assert.match(
    output,
    /<div class="copyright">© OpenAI · itstarts Rebuild<\/div>/,
  );
});

test("run fails when About copyright target is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-copyright-missing-"));
  const file = path.join(tmp, "main.js");
  fs.writeFileSync(file, 'const dialog={copyright:"© OpenAI"};');
  assert.throws(
    () => run({ check: true, files: [file] }),
    /No copyright patch target found/,
  );
});

test("run fails when rebuilt copyright exists outside About panel", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-copyright-other-"));
  const file = path.join(tmp, "main.js");
  fs.writeFileSync(
    file,
    'const banner="© OpenAI · itstarts Rebuild";const dialog={copyright:"© OpenAI"};',
  );
  assert.throws(
    () => run({ check: true, files: [file] }),
    /No copyright patch target found/,
  );
});
