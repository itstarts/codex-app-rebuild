#!/usr/bin/env node

const fs = require("node:fs");
const acorn = require("acorn");
const {
  walkAst,
  applyTextPatches,
  locateAsarAssetBundles,
  locateAsarBuildBundles,
} = require("./patch-util");

const PATCH_IDS = [
  "plugin_auth_gate",
  "browser_computer_availability",
  "statsig_capability_gate",
  "goal_gate",
  "feature_defaults",
  "bundled_plugin_filter",
  "browser_peer_authorization",
];

const FEATURE_DEFAULTS = [
  "browserPane",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "computerUse",
  "computerUseNodeRepl",
  "control",
  "multiWindow",
  "features.js_repl",
  "js_repl",
];

const EVIDENCE_COMPATIBLE_RULES = new Set([
  "plugin_auth_gate",
  "goal_gate",
  "browser_peer_authorization",
]);

const GOAL_COMMAND_NEEDLES = [
  "/goal",
];

const PLUGIN_AUTH_CONTEXT_NEEDLES = [
  "plugin",
  "marketplace",
  "install",
  "requiredapp",
  "required app",
  "required_app",
];

const PEER_CONTEXT_NEEDLES = [
  "browser-use",
  "browser use",
  "computer-use",
  "computer use",
  "native pipe",
  "nativepipe",
  "bundleidentifier",
];

const TARGET_PLUGIN_FEATURE_NEEDLES = [
  "inAppBrowserUseAllowed",
  "inAppBrowserUse",
  "externalBrowserUseAllowed",
  "externalBrowserUse",
  "computerUse",
  "control",
  "js_repl",
];

const FEATURE_DEFAULT_HINTS = FEATURE_DEFAULTS.map((feature) =>
  feature === "features.js_repl" ? '"features.js_repl"' : feature,
);

const PLUGIN_AUTH_DENY_LITERALS = new Set([
  "chatgpt",
  "apikey",
  "amazonBedrock",
]);

function parse(source) {
  return acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function createSourceContext(source, file = "") {
  return {
    source,
    file,
    ast: null,
  };
}

function getAst(context) {
  if (!context.ast) {
    context.ast = parse(context.source);
  }
  return context.ast;
}

function propName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? "";
  }
  return "";
}

function literalValue(node) {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked;
  }
  return undefined;
}

function isFalseNode(node, source) {
  if (!node) return false;
  if (node.type === "Literal" && node.value === false) return true;
  return source.slice(node.start, node.end) === "!1";
}

function hasAny(text, values) {
  return values.some((value) => text.includes(value));
}

function hasAnyLower(text, values) {
  const lower = text.toLowerCase();
  return values.some((value) => lower.includes(value.toLowerCase()));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceAround(source, start, end, margin = 800) {
  return source.slice(
    Math.max(0, start - margin),
    Math.min(source.length, end + margin),
  );
}

function addBooleanPatch(patches, id, node, extra = {}) {
  patches.push({
    id,
    start: node.start,
    end: node.end,
    replacement: "!0",
    ...extra,
  });
}

function addFalsePatch(patches, id, node, extra = {}) {
  patches.push({
    id,
    start: node.start,
    end: node.end,
    replacement: "!1",
    ...extra,
  });
}

function addReplacementPatch(patches, id, start, end, replacement, extra = {}) {
  patches.push({
    id,
    start,
    end,
    replacement,
    ...extra,
  });
}

function goalGateCallMatches(callNode, source) {
  if (!callNode.callee) return false;
  const calleeSource = source.slice(callNode.callee.start, callNode.callee.end).toLowerCase();
  if (
    calleeSource.includes("statsig") ||
    calleeSource.includes("gate") ||
    calleeSource.includes("config")
  ) {
    return true;
  }
  return calleeSource === "get" || calleeSource.endsWith(".get");
}

function hasGoalGateCandidate(source) {
  if (!source.includes("/goal") && !source.includes("goal_enabled")) {
    return false;
  }
  return (
    /goal_enabled/.test(source) ||
    /\bstatsig\b[\s\S]{0,120}goal|goal[\s\S]{0,120}\bstatsig\b/i.test(source) ||
    /(?:^|[^\w])get\([^)]*goal/i.test(source) ||
    /\.get\([^)]*goal/i.test(source)
  );
}

function hasPluginAuthGateCandidate(source) {
  if (!hasAnyLower(source, PLUGIN_AUTH_CONTEXT_NEEDLES)) return false;
  return (
    /(plugin|marketplace|install|requiredapp|required app|required_app)[\s\S]{0,80}authMethod[\s\S]{0,80}(!==|!=|===|==)[\s\S]{0,80}chatgpt/i.test(
      source,
    ) ||
    /authMethod[\s\S]{0,80}(!==|!=|===|==)[\s\S]{0,80}chatgpt[\s\S]{0,80}(plugin|marketplace|install|requiredapp|required app|required_app)/i.test(
      source,
    ) ||
    hasPluginAuthDenyPredicateCandidate(source)
  );
}

function hasPeerAuthorizationCandidate(source) {
  if (!hasAnyLower(source, PEER_CONTEXT_NEEDLES)) return false;
  return (
    /(teamId|TeamIdentifier)[\s\S]{0,120}(===|==)[\s\S]{0,120}(TC3A3QVN3A|OpenAI Team ID)/.test(source) ||
    /(TC3A3QVN3A|OpenAI Team ID)[\s\S]{0,120}(===|==)[\s\S]{0,120}(teamId|TeamIdentifier)/.test(source)
  );
}

function initRuleResult() {
  return Object.fromEntries(
    PATCH_IDS.map((id) => [id, { patches: [], evidence: [] }]),
  );
}

function addEvidence(results, id, kind, detail) {
  results[id].evidence.push({ kind, detail });
}

function collectPluginAuthPatches(context, results) {
  const { source } = context;
  if (!source.includes("chatgpt") || !source.includes("authMethod")) return;
  if (!hasAnyLower(source, PLUGIN_AUTH_CONTEXT_NEEDLES)) return;
  const ast = getAst(context);
  walkAst(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;
    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes("chatgpt") || !fnSource.includes("authMethod")) return;
    if (!hasAnyLower(fnSource, PLUGIN_AUTH_CONTEXT_NEEDLES)) return;
    walkAst(node, (child) => {
      if (child.type !== "BinaryExpression" || !["!==", "!="].includes(child.operator)) return;
      const left = literalValue(child.left);
      const right = literalValue(child.right);
      if (left === "chatgpt" || right === "chatgpt") {
        addFalsePatch(results.plugin_auth_gate.patches, "plugin_auth_gate", child);
      }
    });
  });
  walkAst(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || !node.id?.name) return;
    const expression = pluginAuthDenyReturnExpression(node);
    if (!expression) return;
    if (!hasPluginAuthCallsite(source, node.id.name)) return;
    addReplacementPatch(
      results.plugin_auth_gate.patches,
      "plugin_auth_gate",
      expression.start,
      expression.end,
      "!1",
    );
  });
}

function collectAvailabilityPatches(context, results) {
  const { source } = context;
  if (
    hasAnyLower(source, ["browser_use", "browser_use_external", "computer_use", "control", "js_repl"])
  ) {
    const ast = getAst(context);
    walkAst(ast, (node) => {
      if (node.type !== "ObjectExpression") return;
      const objectSource = source.slice(node.start, node.end);
      if (
        !hasAnyLower(objectSource, [
          "browser_use",
          "browser_use_external",
          "computer_use",
          "control",
          "js_repl",
        ])
      ) {
        return;
      }
      for (const prop of node.properties || []) {
        if (prop.type !== "Property") continue;
        const key = propName(prop.key);
        if (!["allowed", "available"].includes(key)) continue;
        if (isFalseNode(prop.value, source)) {
          addBooleanPatch(
            results.browser_computer_availability.patches,
            "browser_computer_availability",
            prop.value,
          );
        }
      }
    });
  }

  if (
    !source.includes("availablePlugins") ||
    !source.includes("featureName:`in_app_browser`")
  ) {
    return;
  }

  const pattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\.available\|\|[A-Za-z_$][\w$]*\.available)(?=[,;])/g;
  for (const match of source.matchAll(pattern)) {
    const expr = match[2];
    const start = match.index + match[0].indexOf(expr);
    const end = start + expr.length;
    const nearby = sliceAround(source, start, end, 1500);
    if (
      nearby.includes("featureName:`in_app_browser`") &&
      nearby.includes("availablePlugins")
    ) {
      addReplacementPatch(
        results.browser_computer_availability.patches,
        "browser_computer_availability",
        start,
        end,
        "!0",
      );
    }
  }
}

function collectStatsigPatches(context, results) {
  const { source } = context;
  if (hasAnyLower(source, ["browser_use", "browser_use_external", "computer_use"])) {
    const ast = getAst(context);
    walkAst(ast, (node) => {
      if (node.type !== "ObjectExpression") return;
      const objectSource = source.slice(node.start, node.end);
      if (!hasAnyLower(objectSource, ["browser_use", "browser_use_external", "computer_use"])) {
        return;
      }
      for (const prop of node.properties || []) {
        if (prop.type !== "Property") continue;
        if (!["enabled", "isEnabled"].includes(propName(prop.key))) continue;
        if (prop.value.type === "CallExpression") {
          addBooleanPatch(results.statsig_capability_gate.patches, "statsig_capability_gate", prop.value);
        }
      }
    });
  }

  if (
    source.includes("statsig-disabled") &&
    source.includes("config-requirement-disabled") &&
    source.includes("featureName:`in_app_browser`")
  ) {
    const match = /function\s+[A-Za-z_$][\w$]*\(\w+\)\{return([^{}]*statsig-disabled[^{}]*config-requirement-disabled[^{}]*)\}/.exec(
      source,
    );
    if (match && match.index != null) {
      const expr = match[1];
      const start = match.index + match[0].indexOf(expr);
      const end = start + expr.length;
      addReplacementPatch(
        results.statsig_capability_gate.patches,
        "statsig_capability_gate",
        start,
        end,
        "!1",
      );
    }
  }
}

function collectGoalPatches(context, results) {
  const { source } = context;
  if (!source.includes("/goal")) return;
  const ast = getAst(context);
  walkAst(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;
    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes("/goal")) return;
    walkAst(node, (child) => {
      if (child.type !== "CallExpression") return;
      const callSource = source.slice(child.start, child.end).toLowerCase();
      if (goalGateCallMatches(child, source) && /goal/.test(callSource)) {
        addBooleanPatch(results.goal_gate.patches, "goal_gate", child);
      }
    });
  });
}

function collectFeatureDefaultPatches(context, results) {
  const { source } = context;
  if (!hasAny(source, FEATURE_DEFAULT_HINTS)) return;
  const ast = getAst(context);
  walkAst(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const { prop, feature } of featureDefaultProperties(node, source)) {
      addBooleanPatch(results.feature_defaults.patches, "feature_defaults", prop.value, { feature });
    }
  });
}

function collectBundledPluginFilterPatches(context, results) {
  const { source } = context;
  if (!hasAny(source, ["isAvailable", "inAppBrowserUse", "externalBrowserUse", "computerUse"])) {
    return;
  }
  const ast = getAst(context);
  walkAst(ast, (node) => {
    if (node.type !== "Property" || propName(node.key) !== "isAvailable") return;
    const valueSource = source.slice(node.value.start, node.value.end);
    if (!hasAny(valueSource, TARGET_PLUGIN_FEATURE_NEEDLES)) return;
    if (expressionMentionsLiteral(node.value, "win32")) return;
    const contextSource = sliceAround(source, node.start, node.end, 300);
    if (
      !hasAny(contextSource, [
        "installWhenMissing",
        "syncInstallStateWithChromeExtension",
        "name:",
        "autoInstallOptOutKey",
      ])
    ) {
      return;
    }
    addReplacementPatch(
      results.bundled_plugin_filter.patches,
      "bundled_plugin_filter",
      node.value.start,
      node.value.end,
      "()=>!0",
    );
  });
}

function collectPeerAuthorizationPatches(context, results) {
  const { source } = context;
  if (
    !hasAnyLower(source, PEER_CONTEXT_NEEDLES) ||
    !hasAny(source, ["OpenAI Team ID", "TC3A3QVN3A", "teamId", "TeamIdentifier"])
  ) {
    return;
  }
  const ast = getAst(context);
  walkAst(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;
    const fnSource = source.slice(node.start, node.end);

    if (
      !hasAnyLower(fnSource, PEER_CONTEXT_NEEDLES) ||
      !hasAny(fnSource, ["OpenAI Team ID", "TC3A3QVN3A", "teamId", "TeamIdentifier"])
    ) {
      return;
    }
    walkAst(node, (child) => {
      if (child.type !== "BinaryExpression" || !["===", "=="].includes(child.operator)) return;
      const expr = source.slice(child.start, child.end);
      if (/teamId|TC3A3QVN3A|TeamIdentifier/.test(expr)) {
        addBooleanPatch(
          results.browser_peer_authorization.patches,
          "browser_peer_authorization",
          child,
        );
      }
    });
  });
}

function analyzeCapabilityTargets(source, file = "") {
  const context = createSourceContext(source, file);
  const results = initRuleResult();
  collectPluginAuthPatches(context, results);
  collectAvailabilityPatches(context, results);
  collectStatsigPatches(context, results);
  collectGoalPatches(context, results);
  collectFeatureDefaultPatches(context, results);
  collectBundledPluginFilterPatches(context, results);
  collectPeerAuthorizationPatches(context, results);
  return results;
}

function dedupeAndValidatePatches(patches) {
  const deduped = [];
  const seen = new Set();
  for (const patch of patches) {
    const key = `${patch.id}:${patch.start}:${patch.end}:${patch.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(patch);
  }
  deduped.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < deduped.length; index += 1) {
    const previous = deduped[index - 1];
    const current = deduped[index];
    if (current.start < previous.end) {
      throw new Error(
        `Overlapping capability patches detected: ${previous.id}(${previous.start}:${previous.end}) and ${current.id}(${current.start}:${current.end})`,
      );
    }
  }
  return deduped;
}

function flattenPatches(results) {
  return dedupeAndValidatePatches(
    PATCH_IDS.flatMap((id) => results[id].patches),
  );
}

function collectAllCapabilityPatches(source) {
  return flattenPatches(analyzeCapabilityTargets(source));
}

function initTotals() {
  return Object.fromEntries(
    PATCH_IDS.map((id) => [id, { patches: 0, evidence: 0 }]),
  );
}

function initSignals() {
  return {
    goalCandidateFound: false,
    pluginAuthCandidateFound: false,
    peerCandidateFound: false,
  };
}

function updateSignals(signals, source) {
  if (hasGoalGateCandidate(source)) {
    signals.goalCandidateFound = true;
  }
  if (hasPluginAuthGateCandidate(source)) {
    signals.pluginAuthCandidateFound = true;
  }
  if (hasPeerAuthorizationCandidate(source)) {
    signals.peerCandidateFound = true;
  }
}

function deriveAggregateEvidence(signals) {
  const results = initRuleResult();
  if (!signals.pluginAuthCandidateFound) {
    addEvidence(
      results,
      "plugin_auth_gate",
      "upstream-native-or-absent",
      "scan 中未发现 plugin install / marketplace / required app 相关的 chatgpt auth gate 锚点",
    );
  }
  if (!signals.goalCandidateFound) {
    addEvidence(
      results,
      "goal_gate",
      "upstream-native-or-absent",
      "scan 中未发现需要改写的 /goal、thread-goal 或 set-thread-goal 门控锚点",
    );
  }
  if (!signals.peerCandidateFound) {
    addEvidence(
      results,
      "browser_peer_authorization",
      "upstream-native-or-absent",
      "scan 中未发现 browser/computer native peer authorization 的 team gate 锚点",
    );
  }
  return results;
}

function directReturnExpression(functionNode) {
  if (functionNode.body?.type !== "BlockStatement") return null;
  const returns = functionNode.body.body.filter(
    (statement) => statement.type === "ReturnStatement",
  );
  if (returns.length !== 1) return null;
  return returns[0].argument ?? null;
}

function flattenLogicalAnd(node) {
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    return [
      ...flattenLogicalAnd(node.left),
      ...flattenLogicalAnd(node.right),
    ];
  }
  return node ? [node] : [];
}

function comparedLiteralForParam(node, paramName) {
  if (
    node?.type !== "BinaryExpression" ||
    !["!==", "!="].includes(node.operator)
  ) {
    return null;
  }
  if (node.left.type === "Identifier" && node.left.name === paramName) {
    const value = literalValue(node.right);
    return typeof value === "string" ? value : null;
  }
  if (node.right.type === "Identifier" && node.right.name === paramName) {
    const value = literalValue(node.left);
    return typeof value === "string" ? value : null;
  }
  return null;
}

function binaryExpressionHasLiteral(node, value) {
  if (!node || node.type !== "BinaryExpression") return false;
  return literalValue(node.left) === value || literalValue(node.right) === value;
}

function expressionMentionsLiteral(node, value) {
  let found = false;
  walkAst(node, (child) => {
    if (found) return;
    if (binaryExpressionHasLiteral(child, value)) {
      found = true;
    }
  });
  return found;
}

function featureDefaultProperties(objectNode, source) {
  const patches = [];
  for (const prop of objectNode.properties || []) {
    if (prop.type !== "Property") return [];
    const feature = propName(prop.key);
    if (!FEATURE_DEFAULTS.includes(feature)) continue;
    if (isFalseNode(prop.value, source)) {
      patches.push({ prop, feature });
    }
  }
  if (patches.length >= 2 || patches.some(({ feature }) => feature === "features.js_repl")) {
    return patches;
  }
  return [];
}

function pluginAuthDenyReturnExpression(functionNode) {
  const paramName = functionNode.params?.[0]?.name;
  if (!paramName) return null;
  const expression = directReturnExpression(functionNode);
  const values = new Set();
  for (const part of flattenLogicalAnd(expression)) {
    const value = comparedLiteralForParam(part, paramName);
    if (!value || !PLUGIN_AUTH_DENY_LITERALS.has(value)) return null;
    values.add(value);
  }
  if (!values.has("chatgpt") || !values.has("apikey")) return null;
  return expression;
}

function hasPluginAuthCallsite(source, functionName) {
  const pattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const prefix = source.slice(Math.max(0, match.index - 12), match.index);
    if (/function\s*$/.test(prefix)) continue;
    const nearby = sliceAround(
      source,
      match.index,
      match.index + functionName.length,
      1200,
    );
    if (
      nearby.includes("authMethod") &&
      hasAnyLower(nearby, PLUGIN_AUTH_CONTEXT_NEEDLES)
    ) {
      return true;
    }
  }
  return false;
}

function hasPluginAuthDenyPredicateCandidate(source) {
  try {
    const ast = parse(source);
    let found = false;
    walkAst(ast, (node) => {
      if (found) return;
      if (node.type !== "FunctionDeclaration" || !node.id?.name) return;
      if (!pluginAuthDenyReturnExpression(node)) return;
      found = hasPluginAuthCallsite(source, node.id.name);
    });
    return found;
  } catch {
    return false;
  }
}

function inspectCapabilityTargets({
  files = [...locateAsarAssetBundles(), ...locateAsarBuildBundles()],
} = {}) {
  const totals = initTotals();
  const featureDefaultHits = new Set();
  const signals = initSignals();
  const filesWithPatches = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    updateSignals(signals, source);
    const results = analyzeCapabilityTargets(source, file);
    const patches = flattenPatches(results);

    for (const id of PATCH_IDS) {
      totals[id].patches += results[id].patches.length;
      totals[id].evidence += results[id].evidence.length;
      if (id === "feature_defaults") {
        for (const patch of results[id].patches) {
          if (patch.feature) {
            featureDefaultHits.add(patch.feature);
            if (patch.feature === "features.js_repl") {
              featureDefaultHits.add("js_repl");
            }
          }
        }
      }
    }

    filesWithPatches.push({ file, patches, results });
  }

  const aggregateEvidence = deriveAggregateEvidence(signals);
  for (const id of PATCH_IDS) {
    totals[id].evidence += aggregateEvidence[id].evidence.length;
  }

  const missingRules = PATCH_IDS.filter((id) => {
    const satisfiedByEvidence =
      EVIDENCE_COMPATIBLE_RULES.has(id) && totals[id].evidence > 0;
    return totals[id].patches === 0 && !satisfiedByEvidence;
  });

  const missingFeatureDefaults = FEATURE_DEFAULTS.filter(
    (feature) => !featureDefaultHits.has(feature),
  );

  return {
    files: filesWithPatches,
    totals,
    aggregateEvidence,
    missingRules,
    missingFeatureDefaults,
    signals,
  };
}

function formatCounts(results) {
  return PATCH_IDS.map((id) => {
    const patches = results[id].patches.length;
    const evidence = results[id].evidence.length;
    return `${id}:patches=${patches},evidence=${evidence}`;
  }).join(" ");
}

function run({
  check = false,
  files = [...locateAsarAssetBundles(), ...locateAsarBuildBundles()],
} = {}) {
  const summary = inspectCapabilityTargets({ files });

  for (const fileResult of summary.files) {
    if (fileResult.patches.length === 0) continue;
    console.log(`[plugin-capabilities] ${fileResult.file}: ${formatCounts(fileResult.results)}`);
    if (!check) {
      const source = fs.readFileSync(fileResult.file, "utf8");
      fs.writeFileSync(fileResult.file, applyTextPatches(source, fileResult.patches));
    }
  }

  for (const id of PATCH_IDS) {
    const counts = summary.totals[id];
    console.log(
      `[plugin-capabilities] ${id}: patches=${counts.patches} evidence=${counts.evidence}`,
    );
    for (const evidence of summary.aggregateEvidence[id].evidence) {
      console.log(`[plugin-capabilities] ${id} evidence: ${evidence.detail}`);
    }
  }

  const failures = [];
  if (summary.missingRules.length > 0) {
    failures.push(`missing patch/evidence rules: ${summary.missingRules.join(", ")}`);
  }
  if (summary.missingFeatureDefaults.length > 0) {
    failures.push(
      `missing feature default targets: ${summary.missingFeatureDefaults.join(", ")}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`Capability patch check failed: ${failures.join(" | ")}`);
  }

  return summary;
}

if (require.main === module) {
  run({ check: process.argv.includes("--check") });
}

module.exports = {
  PATCH_IDS,
  analyzeCapabilityTargets,
  collectPluginAuthPatches: (source) => analyzeCapabilityTargets(source).plugin_auth_gate.patches,
  collectAvailabilityPatches: (source) =>
    analyzeCapabilityTargets(source).browser_computer_availability.patches,
  collectStatsigPatches: (source) =>
    analyzeCapabilityTargets(source).statsig_capability_gate.patches,
  collectGoalPatches: (source) => analyzeCapabilityTargets(source).goal_gate.patches,
  collectFeatureDefaultPatches: (source) =>
    analyzeCapabilityTargets(source).feature_defaults.patches,
  collectBundledPluginFilterPatches: (source) =>
    analyzeCapabilityTargets(source).bundled_plugin_filter.patches,
  collectPeerAuthorizationPatches: (source) =>
    analyzeCapabilityTargets(source).browser_peer_authorization.patches,
  collectAllCapabilityPatches,
  inspectCapabilityTargets,
  run,
};
