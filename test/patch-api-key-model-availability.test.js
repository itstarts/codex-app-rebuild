const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  collectApiKeyModelAvailabilityPatches,
  hasPatchedApiKeyModelAvailability,
  run,
} = require("../scripts/patch-api-key-model-availability");
const { applyTextPatches } = require("../scripts/patch-util");

const fixture = fs.readFileSync(
  path.join(__dirname, "fixtures", "api-key-model-availability.js"),
  "utf8",
);

function loadNormalizer(source) {
  return new Function(`${source}\nreturn normalizeModels;`)();
}

function invoke(normalizeModels, authMethod) {
  const models = [
    ["gpt-5.6-sol", "GPT-5.6-Sol", false],
    ["gpt-5.6-terra", "GPT-5.6-Terra", false],
    ["gpt-5.6-luna", "GPT-5.6-Luna", false],
    ["gpt-5.6-internal", "GPT-5.6-Internal", true],
  ].map(([model, displayName, hidden]) => ({
    model,
    displayName,
    description: `${displayName} description`,
    hidden,
    supportedReasoningEfforts: ["low", "medium", "high"].map(
      (reasoningEffort) => ({
        reasoningEffort,
        description: `${reasoningEffort} effort`,
      }),
    ),
    defaultReasoningEffort: "medium",
  }));
  return normalizeModels({
    authMethod,
    availableModels: new Set(),
    defaultModel: null,
    enabledReasoningEfforts: null,
    includeUltraReasoningEffort: false,
    models,
    useHiddenModels: true,
  });
}

function tempFile(source) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "patch-api-key-model-availability-"),
  );
  const file = path.join(directory, "asset.js");
  fs.writeFileSync(file, source);
  return file;
}

test("apikey bypasses the ChatGPT model allowlist after patch", () => {
  assert.deepEqual(invoke(loadNormalizer(fixture), "apikey"), []);
  const patches = collectApiKeyModelAvailabilityPatches(fixture);
  assert.equal(patches.length, 1);
  const output = applyTextPatches(fixture, patches);
  assert.deepEqual(
    invoke(loadNormalizer(output), "apikey").map((model) => model.model),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.deepEqual(
    invoke(loadNormalizer(output), "apikey").map((model) => ({
      displayName: model.displayName,
      description: model.description,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    })),
    ["Sol", "Terra", "Luna"].map((name) => ({
      displayName: `GPT-5.6-${name}`,
      description: `GPT-5.6-${name} description`,
      supportedReasoningEfforts: ["low", "medium", "high"].map(
        (reasoningEffort) => ({
          reasoningEffort,
          description: `${reasoningEffort} effort`,
        }),
      ),
      defaultReasoningEffort: "medium",
    })),
  );
});

test("chatgpt remains allowlisted and amazonBedrock keeps its exception", () => {
  const output = applyTextPatches(
    fixture,
    collectApiKeyModelAvailabilityPatches(fixture),
  );
  const normalizeModels = loadNormalizer(output);
  assert.deepEqual(invoke(normalizeModels, "chatgpt"), []);
  assert.deepEqual(invoke(normalizeModels, "copilot"), []);
  assert.equal(invoke(normalizeModels, "amazonBedrock").length, 3);
});

test("patch is idempotent", () => {
  const output = applyTextPatches(
    fixture,
    collectApiKeyModelAvailabilityPatches(fixture),
  );
  assert.equal(collectApiKeyModelAvailabilityPatches(output).length, 0);
  assert.equal(hasPatchedApiKeyModelAvailability(output), true);
  assert.doesNotThrow(() => run({ check: true, files: [tempFile(output)] }));
});

test("run writes the patch outside check mode", () => {
  const file = tempFile(fixture);
  const summary = run({ files: [file] });
  const output = fs.readFileSync(file, "utf8");
  assert.equal(summary.patchCount, 1);
  assert.equal(hasPatchedApiKeyModelAvailability(output), true);
  assert.doesNotThrow(() => run({ check: true, files: [file] }));
});

test("unrelated amazonBedrock comparisons are ignored", () => {
  const source =
    "function unrelated(authMethod){return authMethod!==`amazonBedrock`}";
  assert.deepEqual(collectApiKeyModelAvailabilityPatches(source), []);
});

test("model markers outside the models callback are ignored", () => {
  const source = fixture.replace("a.forEach(", "other.forEach(");
  assert.deepEqual(collectApiKeyModelAvailabilityPatches(source), []);
});

function assertSourceRejected(source) {
  assert.deepEqual(collectApiKeyModelAvailabilityPatches(source), []);
  assert.throws(
    () => run({ check: true, files: [tempFile(source)] }),
    /API key model availability patch failed/,
  );
}

test("a decoy auth gate that does not control model filtering is rejected", () => {
  const source = fixture.replace(
    "const useAllowlist = o && e !== `amazonBedrock`;",
    [
      "const decoy = o && e !== `amazonBedrock`;",
      "  const useAllowlist = true;",
    ].join("\n  "),
  );
  assertSourceRejected(source);
});

test("shadowed and nested model-filter evidence is rejected", () => {
  const shadowed = fixture.replace(
    "a.forEach((item) => {",
    "a.forEach((item, t) => {",
  );
  assertSourceRejected(shadowed);

  const blockShadowed = fixture.replace(
    "a.forEach((item) => {",
    "a.forEach((item) => {\n    const t = new Set();",
  );
  assertSourceRejected(blockShadowed);

  const nested = [
    "function normalizeModels({authMethod:e,availableModels:t,models:a,useHiddenModels:o}){",
    "const useAllowlist=o&&e!==`amazonBedrock`;",
    "a.forEach(item=>{function unused(){",
    "if(useAllowlist?t.has(item.model):!item.hidden){",
    "return item.supportedReasoningEfforts;",
    "}}void unused;});return [];}",
  ].join("");
  assertSourceRejected(nested);
});

test("dynamic model collection property names are rejected", () => {
  assertSourceRejected(fixture.replace("a.forEach(", "a[forEach]("));
  assertSourceRejected(fixture.replace("t.has(", "t[has]("));
});

test("nested parameter and gate destructuring are rejected", () => {
  const nestedParameters = [
    "function normalizeModels({authMethod:{e},availableModels:{t},models:{a},useHiddenModels:{o}}){",
    "const useAllowlist=o&&e!==`amazonBedrock`;",
    "const output=[];a.forEach(item=>{",
    "if(useAllowlist?t.has(item.model):!item.hidden){",
    "output.push({...item,supportedReasoningEfforts:item.supportedReasoningEfforts});",
    "}});return output;}",
  ].join("");
  assertSourceRejected(nestedParameters);

  assertSourceRejected(
    fixture.replace(
      "const useAllowlist =",
      "const { useAllowlist } =",
    ),
  );
  assertSourceRejected(
    fixture.replace(
      "const useAllowlist =",
      "const [useAllowlist] =",
    ),
  );
});

test("run fails when the structural target is missing or not unique", () => {
  assert.throws(
    () => run({ check: true, files: [tempFile("const value = true;")] }),
    /expected exactly 1 model availability target, found 0/,
  );
  const duplicateFixture = fixture.replace(
    "function normalizeModels(",
    "function normalizeModelsCopy(",
  );
  assert.throws(
    () =>
      run({
        check: true,
        files: [tempFile(`${fixture}\n${duplicateFixture}`)],
      }),
    /expected exactly 1 model availability target, found 2/,
  );
});
