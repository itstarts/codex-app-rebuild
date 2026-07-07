const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  collectAllCapabilityPatches,
  inspectCapabilityTargets,
  run,
} = require("../scripts/patch-plugin-capabilities");
const { applyTextPatches } = require("../scripts/patch-util");

function fixturePath(name) {
  return path.join(__dirname, "fixtures", name);
}

function withTempFile(contents) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-plugin-capabilities-"));
  const file = path.join(tmp, "main.js");
  fs.writeFileSync(file, contents);
  return file;
}

test("RED: current realistic anchors require bounded patches and evidence", () => {
  const file = fixturePath("plugin-capabilities-realistic.js");
  const source = fs.readFileSync(file, "utf8");
  const patches = collectAllCapabilityPatches(source);
  for (let index = 1; index < patches.length; index += 1) {
    assert.ok(
      patches[index - 1].end <= patches[index].start,
      `patch overlap: ${patches[index - 1].id} vs ${patches[index].id}`,
    );
  }

  const output = applyTextPatches(source, patches);
  assert.match(output, /browserPane:!0/);
  assert.match(output, /"features\.js_repl":!0/);
  assert.match(output, /\{\.\.\.e,computerUseNodeRepl:!1\}:e/);
  assert.match(output, /function ua\(e\)\{return!1\}/);
  assert.match(output, /let E=!0,D=w\|\|E,O;/);
  assert.match(output, /name:t\.ss,isAvailable:\(\)=>!0,migrate:oo/);
  assert.match(output, /name:ot,syncInstallStateWithChromeExtension:!0,isAvailable:\(\)=>!0/);
  assert.match(output, /name:t\.cs,syncInstallStateWithChromeExtension:!0,isAvailable:\(\)=>!0/);
  assert.match(output, /name:at,syncInstallStateWithChromeExtension:!0,isAvailable:\(\)=>!0/);
  assert.match(output, /name:t\.ls,isAvailable:\(\{features:e,platform:t\}\)=>t===`win32`&&e\.computerUse/);
  assert.match(output, /name:t\.ds,isAvailable:\(\{features:e,platform:t\}\)=>t===`darwin`&&e\.recordAndReplay/);
  assert.match(output, /name:t\.us,isAvailable:\(\)=>!0/);

  const summary = inspectCapabilityTargets({ files: [file] });
  assert.equal(summary.totals.browser_computer_availability.patches, 1);
  assert.equal(summary.totals.statsig_capability_gate.patches, 1);
  assert.equal(summary.totals.feature_defaults.patches, 11);
  assert.equal(summary.totals.bundled_plugin_filter.patches, 5);
  assert.equal(summary.totals.goal_gate.patches, 0);
  assert.equal(summary.totals.goal_gate.evidence, 1);
  assert.equal(summary.totals.plugin_auth_gate.patches, 0);
  assert.equal(summary.totals.plugin_auth_gate.evidence, 1);
  assert.equal(summary.totals.browser_peer_authorization.patches, 0);
  assert.equal(summary.totals.browser_peer_authorization.evidence, 1);
  assert.deepEqual(summary.missingRules, []);
});

test("generic goal/config helper, Vercel team helper, and authMethod UI do not get patched", () => {
  const source = [
    "function batchWriteConfigValue(goalKey){return config.get(goalKey)}",
    "function renderTeamBadge(teamId){const provider=`OpenAI`;return teamId===provider}",
    "function telemetryUser(authMethod){return authMethod!==`chatgpt`}",
  ].join("\n");
  const patches = collectAllCapabilityPatches(source);
  assert.deepEqual(patches, []);
});

test("exported plugin catalog auth predicate is patched when called with authMethod", () => {
  const source = [
    "function DBt(e){return e!==`chatgpt`&&e!==`apikey`&&e!==`amazonBedrock`}",
    "function DZ(host){let limited=DBt(OK(host)?.authMethod??null),catalog=`pluginsLimitedCatalog`,marketplace=`openai-curated`;return limited?catalog:marketplace}",
  ].join("\n");

  const patches = collectAllCapabilityPatches(source);
  assert.equal(
    patches.filter((patch) => patch.id === "plugin_auth_gate").length,
    1,
  );

  const output = applyTextPatches(source, patches);
  assert.match(output, /function DBt\(e\)\{return !1\}/);
});

test("run check fails when availability, statsig, and bundled filter anchors are missing", () => {
  const file = withTempFile(
    [
      "function pluginAuthGate(authMethod){const context=`plugin marketplace install requiredApp`;return authMethod!==`chatgpt`}",
      "function goalSlash(){const slash=`/goal`;return get(`goal_enabled`,false)}",
      "function peerAuth(p){const bundleIdentifier=`browser-use-native-pipe`;return p.teamId===`TC3A3QVN3A`}",
      "const defaults={browserPane:!1,inAppBrowserUse:!1,inAppBrowserUseAllowed:!1,externalBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,computerUseNodeRepl:!1,control:!1,multiWindow:!1,\"features.js_repl\":!1,js_repl:!1};",
    ].join("\n"),
  );

  assert.throws(() => run({ check: true, files: [file] }), (error) => {
    assert.match(error.message, /browser_computer_availability/);
    assert.match(error.message, /statsig_capability_gate/);
    assert.match(error.message, /bundled_plugin_filter/);
    return true;
  });
});

test("fixture check passes and reports every rule via patch or evidence", () => {
  const file = fixturePath("plugin-capabilities.js");
  const summary = run({ check: true, files: [file] });
  for (const [id, counts] of Object.entries(summary.totals)) {
    assert.ok(
      counts.patches > 0 || counts.evidence > 0,
      `expected ${id} to have patch or evidence`,
    );
  }
});
