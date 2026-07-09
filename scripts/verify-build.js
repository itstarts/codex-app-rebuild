#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const acorn = require("acorn");
const { XMLParser } = require("fast-xml-parser");
const {
  SRC_DIR,
  OUT_DIR,
  PLATFORM,
  APP_BUNDLE_NAME,
  BUNDLE_ID,
  APP_NAME,
  FEED_URL,
  PUBLIC_KEY_PATH,
} = require("./lib/constants");
const { readText, run } = require("./lib/fs-utils");
const { assertBundleExecutable } = require("./lib/app-bundle-utils");
const { plutilGet } = require("./lib/plist-utils");
const { assertBuildNumberGreater } = require("./lib/version-utils");
const { computeAsarHeaderHash } = require("./lib/asar-utils");
const { mapHelperBundleId } = require("./build-mac-arm64");
const { verifySparkleSignature } = require("./generate-appcast");

const ABOUT_COPYRIGHT = "© OpenAI · itstarts Rebuild";
const FAST_TIER_EQUIVALENTS = new Set(["fast", "priority"]);
const BUILD_FLAVORS = Object.freeze({
  Dev: "dev",
  Agent: "agent",
  Nightly: "nightly",
  InternalAlpha: "internal-alpha",
  PublicBeta: "public-beta",
  Prod: "prod",
});
const BUILD_FLAVOR_EXPORT_KEYS = Object.freeze(["As", "qs"]);
const REQUIRED_UPDATER_BUILD_FLAVORS = Object.freeze([
  "Nightly",
  "InternalAlpha",
  "PublicBeta",
  "Prod",
]);
// Reviewed upstream 26.707.30751 (build 5018) updater definition, flavor, and consumer chain.
const REVIEWED_UPDATER_CALL_CHAINS = Object.freeze([
  Object.freeze({
    definitionHash: "11a122b700594494debc0d1d4577996f47e7647ed29a4fcd9ba041e87faf1528",
    buildFlavorHash: "2dee399c386715764eb39288e47610b396cb308857df842dc0a9cfd81210343b",
    consumerHash: "49858ef6cebfe4fe72b56633a0e5508720d1b2b480e49f451984d1b3440112f8",
  }),
]);
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function verifyBundleExecutable(appPath, expectedName) {
  return assertBundleExecutable(appPath, expectedName);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.basename(file)} missing: ${file}`);
  }
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    throw new Error(`${path.basename(file)} invalid JSON: ${error.message}`);
  }
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function tierOf(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const key of ["service_tier", "serviceTier", "tier"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function verifyRequestEvidence(dir) {
  const fastFile = path.join(dir, "fast-request.json");
  const standardFile = path.join(dir, "standard-request.json");
  const fast = readJsonFile(fastFile);
  const standard = readJsonFile(standardFile);
  const fastTier = tierOf(fast);
  const standardTier = tierOf(standard);

  if (!FAST_TIER_EQUIVALENTS.has(fastTier)) {
    throw new Error(
      `fast-request.json must contain fast tier or upstream Fast equivalent, got ${String(fastTier)}`,
    );
  }
  if (!["standard", undefined, null].includes(standardTier)) {
    throw new Error(
      `standard-request.json must contain standard tier or upstream standard equivalent, got ${String(standardTier)}`,
    );
  }
}

function findInfoPlists(root) {
  const result = [];

  function visit(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.endsWith(".app")) {
        const plist = path.join(full, "Contents", "Info.plist");
        if (fs.existsSync(plist)) {
          result.push(plist);
        }
        continue;
      }
      visit(full);
    }
  }

  visit(root);
  return result.sort();
}

function helperRoleFromPath(plist) {
  const appName = path.basename(path.dirname(path.dirname(plist)), ".app");
  return appName.match(/\(([^)]+)\)\s*$/)?.[1] || "";
}

function verifyHelperBundleIds(app) {
  const helperPlists = findInfoPlists(path.join(app, "Contents", "Frameworks")).filter(
    (plist) => plist.split(path.sep).includes("Helpers"),
  );
  if (helperPlists.length === 0) {
    throw new Error("No helper app Info.plist files found");
  }

  const seen = new Set();
  for (const plist of helperPlists) {
    const id = plutilGet(plist, "CFBundleIdentifier");
    if (id !== `${BUNDLE_ID}.helper` && !id.startsWith(`${BUNDLE_ID}.helper.`)) {
      throw new Error(`helper id outside rebuild namespace: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate helper bundle id: ${id}`);
    }
    seen.add(id);

    const role = helperRoleFromPath(plist);
    if (role === "GPU" || role === "Plugin" || role === "Renderer") {
      assertEqual(
        id,
        mapHelperBundleId(`com.openai.codex.helper.${role}`),
        `helper id for ${role}`,
      );
    }
  }
}

function asarEntryPath(name) {
  return name.startsWith("/") ? name.slice(1) : name;
}

function listAsarFiles(asarPath) {
  return asar.listPackage(asarPath).map(asarEntryPath).filter(Boolean);
}

function extractAsarFileText(asarPath, name) {
  return asar.extractFile(asarPath, asarEntryPath(name)).toString("utf8");
}

function verifyAsarPackage(asarPath) {
  const pkg = JSON.parse(extractAsarFileText(asarPath, "package.json"));
  assertEqual(pkg.codexSparkleFeedUrl, FEED_URL, "ASAR package codexSparkleFeedUrl");
  assertEqual(
    pkg.codexSparklePublicKey,
    readText(PUBLIC_KEY_PATH).trim(),
    "ASAR package codexSparklePublicKey",
  );
}

function verifyAsarIntegrity(app, plist) {
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const expected = computeAsarHeaderHash(asarPath);
  const actual = plutilGet(plist, "ElectronAsarIntegrity.Resources/app\\.asar.hash");
  assertEqual(actual, expected, "ElectronAsarIntegrity app.asar hash");
}

function verifyAboutText(asarPath) {
  const found = listAsarFiles(asarPath)
    .filter((name) => /\.(?:html|js|json)$/.test(name))
    .some((name) => extractAsarFileText(asarPath, name).includes(ABOUT_COPYRIGHT));
  if (!found) {
    throw new Error(`About copyright text not found in app.asar: ${ABOUT_COPYRIGHT}`);
  }
}

function extractAsarJavaScriptSources(asarPath) {
  return listAsarFiles(asarPath)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: extractAsarFileText(asarPath, name) }));
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.type) {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => walkAst(item, visitor));
      continue;
    }
    if (value && typeof value === "object") {
      walkAst(value, visitor);
    }
  }
}

function parseJavaScript(source, file) {
  try {
    return acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (scriptError) {
    try {
      return acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      throw new Error(`${file} could not be parsed: ${scriptError.message}`);
    }
  }
}

function propertyName(node) {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  return null;
}

function isFunctionNode(node) {
  return FUNCTION_NODE_TYPES.has(node?.type);
}

function patternBindsName(pattern, name) {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "RestElement") return patternBindsName(pattern.argument, name);
  if (pattern.type === "AssignmentPattern") return patternBindsName(pattern.left, name);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.some((element) => patternBindsName(element, name));
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      property.type === "RestElement"
        ? patternBindsName(property.argument, name)
        : patternBindsName(property.value, name),
    );
  }
  return false;
}

function topLevelBindings(ast, name) {
  const bindings = [];
  for (const statement of ast.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (patternBindsName(declarator.id, name)) {
          bindings.push({ kind: "variable", node: declarator });
        }
      }
      continue;
    }
    if (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id?.name === name
    ) {
      bindings.push({ kind: "declaration", node: statement });
      continue;
    }
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.local?.name === name) {
          bindings.push({ kind: "import", node: specifier });
        }
      }
    }
  }
  return bindings;
}

function staticModuleSpecifier(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function walkModuleScope(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  if (isFunctionNode(node)) return;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => walkModuleScope(item, visitor));
    } else if (value && typeof value === "object") {
      walkModuleScope(value, visitor);
    }
  }
}

function memberRootIdentifier(node) {
  let current = unwrapChain(node);
  while (current?.type === "MemberExpression") {
    current = unwrapChain(current.object);
  }
  return current?.type === "Identifier" ? current.name : null;
}

function assignmentTargetMutatesBinding(node, name) {
  const target = unwrapChain(node);
  if (!target) return false;
  if (target.type === "Identifier") return target.name === name;
  if (target.type === "MemberExpression") return memberRootIdentifier(target) === name;
  if (target.type === "RestElement") {
    return assignmentTargetMutatesBinding(target.argument, name);
  }
  if (target.type === "AssignmentPattern") {
    return assignmentTargetMutatesBinding(target.left, name);
  }
  if (target.type === "ArrayPattern") {
    return target.elements.some((element) => assignmentTargetMutatesBinding(element, name));
  }
  if (target.type === "ObjectPattern") {
    return target.properties.some((property) =>
      property.type === "RestElement"
        ? assignmentTargetMutatesBinding(property.argument, name)
        : assignmentTargetMutatesBinding(property.value, name),
    );
  }
  return false;
}

function staticMemberName(member) {
  if (!member?.computed && member?.property?.type === "Identifier") {
    return member.property.name;
  }
  if (member?.property?.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

function analyzeBuildFlavorBinding(ast) {
  const bindings = topLevelBindings(ast, "t");
  if (bindings.length !== 1) {
    throw new Error("updater build flavor binding t must be unique at module scope");
  }
  const binding = bindings[0];
  const init = binding.kind === "variable" ? binding.node.init : null;
  const specifier =
    init?.type === "CallExpression" &&
    init.callee.type === "Identifier" &&
    init.callee.name === "require" &&
    init.arguments.length === 1
      ? staticModuleSpecifier(init.arguments[0])
      : null;
  if (!specifier || !/^(?:\.\/|\.\.\/)/.test(specifier)) {
    throw new Error("updater build flavor binding t must be a direct relative require");
  }

  const exportKeys = new Set();
  const flavors = new Set();
  let mutated = false;
  walkModuleScope(ast, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      assignmentTargetMutatesBinding(node.left, "t")
    ) {
      mutated = true;
    }
    if (
      node.type === "UpdateExpression" &&
      assignmentTargetMutatesBinding(node.argument, "t")
    ) {
      mutated = true;
    }
    if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      assignmentTargetMutatesBinding(node.argument, "t")
    ) {
      mutated = true;
    }

    if (node.type !== "MemberExpression") return;
    const namespace = unwrapChain(node.object);
    if (
      namespace?.type !== "MemberExpression" ||
      unwrapChain(namespace.object)?.type !== "Identifier" ||
      unwrapChain(namespace.object).name !== "t"
    ) {
      return;
    }
    const exportKey = staticMemberName(namespace);
    const flavor = staticMemberName(node);
    if (!exportKey || !flavor) {
      throw new Error("updater build flavor member access must be static");
    }
    exportKeys.add(exportKey);
    flavors.add(flavor);
  });

  if (mutated) {
    throw new Error("updater build flavor binding t is mutated at module scope");
  }
  if (exportKeys.size !== 1) {
    throw new Error("updater build flavor export key must be unique");
  }
  const [exportKey] = exportKeys;
  if (!BUILD_FLAVOR_EXPORT_KEYS.includes(exportKey)) {
    throw new Error(`updater build flavor export key ${exportKey} is not reviewed`);
  }
  for (const flavor of flavors) {
    if (!Object.prototype.hasOwnProperty.call(BUILD_FLAVORS, flavor)) {
      throw new Error(`unknown updater build flavor ${flavor}`);
    }
  }
  const missing = REQUIRED_UPDATER_BUILD_FLAVORS.filter((flavor) => !flavors.has(flavor));
  if (missing.length > 0) {
    throw new Error(`updater build flavor members missing ${missing.join(", ")}`);
  }
  return { exportKey, specifier, declarator: binding.node };
}

function collectStaticScope(ast) {
  const functions = new Map();
  const values = new Map();
  const objectMethods = new Map();

  for (const statement of ast.body) {
    if (statement.type === "FunctionDeclaration" && statement.id?.name) {
      functions.set(statement.id.name, statement);
      continue;
    }
    if (statement.type !== "VariableDeclaration") {
      continue;
    }
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== "Identifier" || !declarator.init) {
        continue;
      }
      const name = declarator.id.name;
      if (
        declarator.init.type === "FunctionExpression" ||
        declarator.init.type === "ArrowFunctionExpression"
      ) {
        functions.set(name, declarator.init);
        continue;
      }
      values.set(name, declarator.init);
      if (declarator.init.type === "ObjectExpression") {
        const methods = new Map();
        for (const property of declarator.init.properties) {
          if (property.type !== "Property") {
            continue;
          }
          const key = propertyName(property.key);
          if (!key) {
            continue;
          }
          if (
            property.value.type === "FunctionExpression" ||
            property.value.type === "ArrowFunctionExpression"
          ) {
            methods.set(key, property.value);
          }
        }
        objectMethods.set(name, methods);
      }
    }
  }

  return {
    functions,
    values,
    objectMethods,
    buildFlavorBinding: analyzeBuildFlavorBinding(ast),
    usedBindings: new Set(),
  };
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function createBaseContext(state) {
  const context = {
    process: {
      platform: "darwin",
      arch: "arm64",
      env: {
        NODE_ENV: "production",
      },
    },
  };
  if (state?.buildFlavorBinding) {
    context.t = Object.freeze({
      [state.buildFlavorBinding.exportKey]: BUILD_FLAVORS,
    });
  }
  return context;
}

function getBinding(context, name) {
  if (Object.prototype.hasOwnProperty.call(context, name)) {
    return context[name];
  }
  if (Object.getPrototypeOf(context)) {
    return getBinding(Object.getPrototypeOf(context), name);
  }
  return undefined;
}

function hasBinding(context, name) {
  if (Object.prototype.hasOwnProperty.call(context, name)) {
    return true;
  }
  if (Object.getPrototypeOf(context)) {
    return hasBinding(Object.getPrototypeOf(context), name);
  }
  return false;
}

function evalFunction(fnNode, args, state, parentContext, depth) {
  if (depth > 20) {
    throw new Error("static predicate evaluation exceeded call depth");
  }

  const context = Object.create(parentContext);
  for (let index = 0; index < fnNode.params.length; index += 1) {
    const param = fnNode.params[index];
    let value = args[index];
    if (param.type === "Identifier") {
      context[param.name] = value;
      continue;
    }
    if (param.type === "AssignmentPattern" && param.left.type === "Identifier") {
      if (value === undefined) {
        value = evalStatic(param.right, state, context, depth + 1);
      }
      context[param.left.name] = value;
      continue;
    }
    throw new Error(`unsupported predicate parameter ${param.type}`);
  }

  if (fnNode.type === "ArrowFunctionExpression" && fnNode.body.type !== "BlockStatement") {
    return evalStatic(fnNode.body, state, context, depth + 1);
  }

  if (
    fnNode.body.body.length !== 1 ||
    fnNode.body.body[0].type !== "ReturnStatement"
  ) {
    throw new Error("predicate helper must contain a single return-only statement");
  }
  return evalStatic(fnNode.body.body[0].argument, state, context, depth + 1);
}

function evalObjectExpression(node, state, context, depth) {
  const result = {};
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      Object.assign(result, evalStatic(property.argument, state, context, depth + 1));
      continue;
    }
    if (property.type !== "Property") {
      continue;
    }
    const key = property.computed
      ? evalStatic(property.key, state, context, depth + 1)
      : propertyName(property.key);
    if (!key) {
      continue;
    }
    if (
      property.value.type === "FunctionExpression" ||
      property.value.type === "ArrowFunctionExpression"
    ) {
      result[key] = property.value;
      continue;
    }
    result[key] = evalStatic(property.value, state, context, depth + 1);
  }
  return result;
}

function evalMember(node, state, context, depth) {
  const object = evalStatic(node.object, state, context, depth + 1);
  const key = node.computed
    ? evalStatic(node.property, state, context, depth + 1)
    : propertyName(node.property);
  if (object == null) {
    if (node.optional) {
      return undefined;
    }
    throw new Error(`cannot read ${String(key)} from ${String(object)}`);
  }
  return object[key];
}

function evalCall(node, state, context, depth) {
  const callee = unwrapChain(node.callee);
  const args = node.arguments.map((arg) => evalStatic(arg, state, context, depth + 1));

  if (callee.type === "Identifier" && state.functions.has(callee.name)) {
    state.usedBindings.add(callee.name);
    return evalFunction(state.functions.get(callee.name), args, state, context, depth + 1);
  }

  if (callee.type === "MemberExpression") {
    const method = propertyName(callee.property);
    if (method === "includes") {
      const receiver = evalStatic(callee.object, state, context, depth + 1);
      if (Array.isArray(receiver) || typeof receiver === "string") {
        return receiver.includes(args[0]);
      }
    }

    if (callee.object.type === "Identifier") {
      const methods = state.objectMethods.get(callee.object.name);
      const fnNode = methods?.get(method);
      if (fnNode) {
        state.usedBindings.add(callee.object.name);
        return evalFunction(fnNode, args, state, context, depth + 1);
      }
    }
  }

  throw new Error(`unsupported static call ${callee.type}`);
}

function evalStatic(node, state, context, depth = 0) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) {
    return undefined;
  }

  switch (unwrapped.type) {
    case "Literal":
      return unwrapped.value;
    case "TemplateLiteral":
      if (unwrapped.expressions.length === 0) {
        return unwrapped.quasis[0]?.value?.cooked || "";
      }
      break;
    case "Identifier":
      if (unwrapped.name === "undefined") {
        return undefined;
      }
      if (hasBinding(context, unwrapped.name)) {
        return getBinding(context, unwrapped.name);
      }
      if (state.values.has(unwrapped.name)) {
        state.usedBindings.add(unwrapped.name);
        return evalStatic(
          state.values.get(unwrapped.name),
          state,
          createBaseContext(state),
          depth + 1,
        );
      }
      break;
    case "ArrayExpression":
      return unwrapped.elements.map((item) => evalStatic(item, state, context, depth + 1));
    case "ObjectExpression":
      return evalObjectExpression(unwrapped, state, context, depth);
    case "MemberExpression":
      return evalMember(unwrapped, state, context, depth);
    case "CallExpression":
      return evalCall(unwrapped, state, context, depth);
    case "UnaryExpression":
      if (unwrapped.operator === "!") {
        return !evalStatic(unwrapped.argument, state, context, depth + 1);
      }
      break;
    case "LogicalExpression":
      if (unwrapped.operator === "&&") {
        return (
          evalStatic(unwrapped.left, state, context, depth + 1) &&
          evalStatic(unwrapped.right, state, context, depth + 1)
        );
      }
      if (unwrapped.operator === "||") {
        return (
          evalStatic(unwrapped.left, state, context, depth + 1) ||
          evalStatic(unwrapped.right, state, context, depth + 1)
        );
      }
      if (unwrapped.operator === "??") {
        const left = evalStatic(unwrapped.left, state, context, depth + 1);
        return left ?? evalStatic(unwrapped.right, state, context, depth + 1);
      }
      break;
    case "BinaryExpression": {
      const left = evalStatic(unwrapped.left, state, context, depth + 1);
      const right = evalStatic(unwrapped.right, state, context, depth + 1);
      if (unwrapped.operator === "===") {
        return left === right;
      }
      if (unwrapped.operator === "!==") {
        return left !== right;
      }
      if (unwrapped.operator === "==" || unwrapped.operator === "!=") {
        throw new Error(`loose equality operator ${unwrapped.operator} is not reviewed`);
      }
      break;
    }
    case "ConditionalExpression":
      return evalStatic(unwrapped.test, state, context, depth + 1)
        ? evalStatic(unwrapped.consequent, state, context, depth + 1)
        : evalStatic(unwrapped.alternate, state, context, depth + 1);
  }

  throw new Error(`unsupported static expression ${unwrapped.type}`);
}

function updaterContainerCandidates(ast) {
  const candidates = [];
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== "Identifier" || declarator.init?.type !== "ObjectExpression") {
        continue;
      }
      const methods = new Map();
      for (let index = 0; index < declarator.init.properties.length; index += 1) {
        const property = declarator.init.properties[index];
        if (property.type !== "Property" || !isFunctionNode(property.value)) continue;
        const name = propertyName(property.key);
        if (name === "shouldIncludeSparkle" || name === "shouldIncludeUpdater") {
          const entries = methods.get(name) || [];
          entries.push({ property, index });
          methods.set(name, entries);
        }
      }
      const sparkleEntries = methods.get("shouldIncludeSparkle") || [];
      const updaterEntries = methods.get("shouldIncludeUpdater") || [];
      const targetEntries = [...sparkleEntries, ...updaterEntries];
      const targetsAreOrdinary = targetEntries.every(
        ({ property }) =>
          !property.computed &&
          property.kind === "init" &&
          !property.value.async &&
          !property.value.generator,
      );
      const firstTargetIndex = Math.min(...targetEntries.map(({ index }) => index));
      const hasTrailingDynamicOverride = declarator.init.properties
        .slice(firstTargetIndex + 1)
        .some(
          (property) =>
            property.type === "SpreadElement" ||
            (property.type === "Property" && property.computed),
        );
      if (
        sparkleEntries.length === 1 &&
        updaterEntries.length === 1 &&
        targetsAreOrdinary &&
        !hasTrailingDynamicOverride
      ) {
        candidates.push({
          containerName: declarator.id.name,
          declarator,
          predicates: new Map([
            ["shouldIncludeSparkle", sparkleEntries[0].property.value],
            ["shouldIncludeUpdater", updaterEntries[0].property.value],
          ]),
        });
      }
    }
  }
  return candidates;
}

function moduleScopeBindingMutated(ast, name) {
  let mutated = false;
  walkModuleScope(ast, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      assignmentTargetMutatesBinding(node.left, name)
    ) {
      mutated = true;
    }
    if (
      node.type === "UpdateExpression" &&
      assignmentTargetMutatesBinding(node.argument, name)
    ) {
      mutated = true;
    }
    if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      assignmentTargetMutatesBinding(node.argument, name)
    ) {
      mutated = true;
    }
    if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type !== "VariableDeclaration" &&
      assignmentTargetMutatesBinding(node.left, name)
    ) {
      mutated = true;
    }
  });
  return mutated;
}

function assertUpdaterContainerStable(ast, candidate) {
  const bindings = topLevelBindings(ast, candidate.containerName);
  if (
    bindings.length !== 1 ||
    bindings[0].kind !== "variable" ||
    bindings[0].node !== candidate.declarator
  ) {
    throw new Error(
      `updater container ${candidate.containerName} must have one module-scope binding`,
    );
  }
  if (moduleScopeBindingMutated(ast, candidate.containerName)) {
    throw new Error(`updater container ${candidate.containerName} is mutated at module scope`);
  }
}

function exactGetterFunction(descriptor) {
  if (descriptor?.type !== "ObjectExpression") return null;
  const allowedKeys = new Set(["get", "enumerable", "configurable"]);
  const seenKeys = new Set();
  for (const property of descriptor.properties) {
    if (property.type !== "Property" || property.computed) return null;
    const key = propertyName(property.key);
    if (!allowedKeys.has(key) || seenKeys.has(key)) return null;
    seenKeys.add(key);
  }
  const getters = descriptor.properties.filter((property) => propertyName(property.key) === "get");
  if (getters.length !== 1) return null;
  const getter = getters[0].value;
  if (
    getter?.type !== "FunctionExpression" ||
    getter.async ||
    getter.generator ||
    getter.params.length !== 0 ||
    getter.body.type !== "BlockStatement" ||
    getter.body.body.length !== 1
  ) {
    return null;
  }
  return getter;
}

function exactGetterReturnName(descriptor) {
  const getter = exactGetterFunction(descriptor);
  if (!getter) return null;
  const statement = getter.body.body[0];
  return statement.type === "ReturnStatement" && statement.argument?.type === "Identifier"
    ? statement.argument.name
    : null;
}

function exactContainerGetter(descriptor, containerName) {
  return exactGetterReturnName(descriptor) === containerName;
}

function commonJsExportRecords(ast) {
  const records = [];
  for (const statement of ast.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const expressions =
      statement.expression.type === "SequenceExpression"
        ? statement.expression.expressions
        : [statement.expression];
    for (const expression of expressions) {
      if (expression.type !== "CallExpression" || expression.arguments.length !== 3) continue;
      const callee = unwrapChain(expression.callee);
      if (
        callee.type !== "MemberExpression" ||
        unwrapChain(callee.object)?.type !== "Identifier" ||
        unwrapChain(callee.object).name !== "Object" ||
        staticMemberName(callee) !== "defineProperty" ||
        expression.arguments[0]?.type !== "Identifier" ||
        expression.arguments[0].name !== "exports"
      ) {
        continue;
      }
      records.push({
        key: staticModuleSpecifier(expression.arguments[1]),
        descriptor: expression.arguments[2],
      });
    }
  }
  return records;
}

function findReviewedContainerExport(ast, containerName) {
  const records = commonJsExportRecords(ast);
  const mappings = records.filter((record) =>
    exactContainerGetter(record.descriptor, containerName),
  );
  if (mappings.length !== 1) {
    throw new Error(
      `updater container export for ${containerName} must have exactly one reviewed getter`,
    );
  }
  const mapping = mappings[0];
  if (!mapping.key) {
    throw new Error(`updater container export for ${containerName} must use a static key`);
  }
  if (records.filter((record) => record.key === mapping.key).length !== 1) {
    throw new Error(
      `updater container export key ${mapping.key} must be defined exactly once`,
    );
  }
  return mapping.key;
}

function topLevelVariableDeclarator(ast, name, label) {
  const bindings = topLevelBindings(ast, name);
  if (bindings.length !== 1 || bindings[0].kind !== "variable") {
    throw new Error(`${label} ${name} must have one module-scope variable binding`);
  }
  return bindings[0].node;
}

function exactBuildFlavorObject(node) {
  if (node?.type !== "ObjectExpression" || node.properties.length !== Object.keys(BUILD_FLAVORS).length) {
    return null;
  }
  const values = new Map();
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed) return null;
    const key = propertyName(property.key);
    const value = staticModuleSpecifier(property.value);
    if (!key || value == null || values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

function validateExactBuildFlavorObject(ast, name, moduleFile, namespaceDeclarator = null) {
  const declarator = topLevelVariableDeclarator(ast, name, "build flavor base");
  const values = exactBuildFlavorObject(declarator.init);
  if (!values) {
    throw new Error(`build flavor module ${moduleFile} base ${name} is not an exact flavor object`);
  }
  for (const [key, expected] of Object.entries(BUILD_FLAVORS)) {
    if (values.get(key) !== expected) {
      throw new Error(
        `build flavor module ${moduleFile} has invalid ${key}: expected ${expected}, got ${String(values.get(key))}`,
      );
    }
  }
  if (analyzeConsumerAlias(ast, name, null).mutated) {
    throw new Error(`build flavor module ${moduleFile} binding ${name} is mutated`);
  }
  if (namespaceDeclarator) {
    assertBuildFlavorBaseReferences(ast, name, declarator, namespaceDeclarator, moduleFile);
  }
}

function validateBuildFlavorNamespace(ast, containerName, moduleFile, getter) {
  const declarator = topLevelVariableDeclarator(ast, containerName, "build flavor namespace");
  const directValues = exactBuildFlavorObject(declarator.init);
  if (directValues) {
    validateExactBuildFlavorObject(ast, containerName, moduleFile);
    assertStaticNamespaceReferences(
      ast,
      containerName,
      declarator,
      getter,
      "build flavor namespace",
    );
    return;
  }
  if (declarator.init?.type !== "ObjectExpression") {
    throw new Error(`build flavor module ${moduleFile} export ${containerName} is not an object`);
  }
  const spreads = declarator.init.properties.filter((property) => property.type === "SpreadElement");
  if (spreads.length !== 1 || spreads[0].argument.type !== "Identifier") {
    throw new Error(
      `build flavor module ${moduleFile} export ${containerName} must spread one exact flavor object`,
    );
  }
  for (const property of declarator.init.properties) {
    if (property.type !== "Property") continue;
    if (property.computed) {
      throw new Error(
        `build flavor module ${moduleFile} export ${containerName} contains a computed property`,
      );
    }
    const key = propertyName(property.key);
    if (key && Object.prototype.hasOwnProperty.call(BUILD_FLAVORS, key)) {
      throw new Error(`build flavor module ${moduleFile} export overrides ${key}`);
    }
  }
  validateExactBuildFlavorObject(ast, spreads[0].argument.name, moduleFile, declarator);
  if (analyzeConsumerAlias(ast, containerName, null).mutated) {
    throw new Error(`build flavor module ${moduleFile} binding ${containerName} is mutated`);
  }
  assertStaticNamespaceReferences(
    ast,
    containerName,
    declarator,
    getter,
    "build flavor namespace",
  );
}

function validateRequiredBuildFlavorModule(jsSources, candidate, state) {
  const binding = state.buildFlavorBinding;
  const target = resolveInternalRequire(candidate.file, binding.specifier);
  const moduleSource = target ? jsSources.find((file) => file.name === target) : null;
  if (!moduleSource) {
    throw new Error(`build flavor module not found for ${candidate.file}: ${binding.specifier}`);
  }
  const ast = parseJavaScript(moduleSource.source, moduleSource.name);
  assertTrustedHostBindings(
    ast,
    { Object: "any", exports: "exports" },
    `build flavor module ${moduleSource.name}`,
  );
  const matchingExports = commonJsExportRecords(ast).filter(
    (record) => record.key === binding.exportKey,
  );
  if (matchingExports.length !== 1) {
    throw new Error(
      `build flavor module ${moduleSource.name} must define export ${binding.exportKey} exactly once`,
    );
  }
  const containerName = exactGetterReturnName(matchingExports[0].descriptor);
  if (!containerName) {
    throw new Error(
      `build flavor module ${moduleSource.name} export ${binding.exportKey} must use an exact getter`,
    );
  }
  const namespaceGetters = new Set(
    commonJsExportRecords(ast)
      .filter((record) => exactGetterReturnName(record.descriptor) === containerName)
      .map((record) => exactGetterFunction(record.descriptor)),
  );
  validateBuildFlavorNamespace(ast, containerName, moduleSource.name, namespaceGetters);
  return moduleSource;
}

function directRelativeRequire(init) {
  if (
    init?.type !== "CallExpression" ||
    init.callee.type !== "Identifier" ||
    init.callee.name !== "require" ||
    init.arguments.length !== 1
  ) {
    return null;
  }
  const specifier = staticModuleSpecifier(init.arguments[0]);
  return specifier && /^(?:\.\/|\.\.\/)/.test(specifier) ? specifier : null;
}

function resolveInternalRequire(fromFile, specifier) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    return null;
  }
  return resolved;
}

function functionScopeBindsName(fnNode, name) {
  if (fnNode.id?.name === name || fnNode.params.some((param) => patternBindsName(param, name))) {
    return true;
  }
  let bound = false;
  function visit(node) {
    if (!node || typeof node !== "object" || bound) return;
    if (isFunctionNode(node)) {
      if (node.type === "FunctionDeclaration" && node.id?.name === name) bound = true;
      return;
    }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      if (node.declarations.some((declarator) => patternBindsName(declarator.id, name))) {
        bound = true;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  if (fnNode.body?.type === "BlockStatement") {
    for (const statement of fnNode.body.body) visit(statement);
  }
  return bound;
}

function blockScopeBindsName(block, name) {
  return block.body.some((statement) => {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      return statement.declarations.some((declarator) => patternBindsName(declarator.id, name));
    }
    return (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id?.name === name
    );
  });
}

function loopScopeBindsName(node, name) {
  const declaration = node.type === "ForStatement" ? node.init : node.left;
  return (
    declaration?.type === "VariableDeclaration" &&
    declaration.kind !== "var" &&
    declaration.declarations.some((declarator) => patternBindsName(declarator.id, name))
  );
}

function switchScopeBindsName(node, name) {
  return node.cases.some((caseNode) =>
    caseNode.consequent.some((statement) => {
      if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
        return statement.declarations.some((declarator) => patternBindsName(declarator.id, name));
      }
      return (
        (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
        statement.id?.name === name
      );
    }),
  );
}

function walkAstWithAncestors(node, visitor, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, ancestors);
  const nextAncestors = node.type ? [...ancestors, node] : ancestors;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) => walkAstWithAncestors(item, visitor, nextAncestors));
    } else if (value && typeof value === "object") {
      walkAstWithAncestors(value, visitor, nextAncestors);
    }
  }
}

function bindingShadowedByAncestors(ancestors, name) {
  return ancestors.some((ancestor) => {
    if (isFunctionNode(ancestor)) return functionScopeBindsName(ancestor, name);
    if (ancestor.type === "BlockStatement") return blockScopeBindsName(ancestor, name);
    if (ancestor.type === "CatchClause") return patternBindsName(ancestor.param, name);
    if (
      ancestor.type === "ForStatement" ||
      ancestor.type === "ForInStatement" ||
      ancestor.type === "ForOfStatement"
    ) {
      return loopScopeBindsName(ancestor, name);
    }
    if (ancestor.type === "SwitchStatement") return switchScopeBindsName(ancestor, name);
    if (ancestor.type === "ClassExpression" || ancestor.type === "ClassDeclaration") {
      return ancestor.id?.name === name;
    }
    return false;
  });
}

function assertStaticDataBindingReferences(ast, name, declarator) {
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === declarator.id || bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (
      parent?.type === "Property" &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand
    ) {
      return;
    }
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
      return;
    }
    if (parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") {
      return;
    }
    if (parent?.type === "MemberExpression" && parent.object === node) {
      let chain = parent;
      let index = ancestors.length - 2;
      while (
        index >= 0 &&
        ancestors[index].type === "MemberExpression" &&
        ancestors[index].object === chain
      ) {
        chain = ancestors[index];
        index -= 1;
      }
      if (
        ancestors[index]?.type === "ChainExpression" &&
        ancestors[index].expression === chain
      ) {
        chain = ancestors[index];
        index -= 1;
      }
      const consumer = ancestors[index];
      if (consumer?.type === "CallExpression" && unwrapChain(consumer.callee) === unwrapChain(chain)) {
        if (staticMemberName(unwrapChain(chain)) === "includes") return;
        violation = `call through ${name}.${String(staticMemberName(unwrapChain(chain)))}`;
        return;
      }
      return;
    }
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(`static data binding ${name} has unreviewed reference: ${violation}`);
  }
}

function isNonReferenceIdentifier(node, parent) {
  if (
    parent?.type === "Property" &&
    parent.key === node &&
    !parent.computed &&
    !parent.shorthand
  ) {
    return true;
  }
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return true;
  }
  return (
    parent?.type === "LabeledStatement" ||
    parent?.type === "BreakStatement" ||
    parent?.type === "ContinueStatement"
  );
}

function exactGetterReturnsIdentifier(getters, node, parent) {
  const candidates = getters instanceof Set ? getters : new Set(getters ? [getters] : []);
  return [...candidates].some(
    (getter) =>
      parent === getter.body.body[0] &&
      parent.type === "ReturnStatement" &&
      parent.argument === node,
  );
}

function assertStaticNamespaceReferences(ast, name, declarator, getters, label) {
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === declarator.id || bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      staticMemberName(parent)
    ) {
      return;
    }
    if (exactGetterReturnsIdentifier(getters, node, parent)) return;
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(`${label} ${name} has unreviewed reference: ${violation}`);
  }
}

function assertBuildFlavorBaseReferences(
  ast,
  name,
  declarator,
  namespaceDeclarator,
  moduleFile,
) {
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === declarator.id || bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      Object.prototype.hasOwnProperty.call(BUILD_FLAVORS, staticMemberName(parent))
    ) {
      return;
    }
    if (
      parent?.type === "SpreadElement" &&
      parent.argument === node &&
      ancestors.at(-2) === namespaceDeclarator.init
    ) {
      return;
    }
    if (parent?.type === "CallExpression" && parent.arguments.length === 1 && parent.arguments[0] === node) {
      const callee = unwrapChain(parent.callee);
      if (
        callee.type === "MemberExpression" &&
        unwrapChain(callee.object)?.type === "Identifier" &&
        unwrapChain(callee.object).name === "Object" &&
        staticMemberName(callee) === "values"
      ) {
        return;
      }
    }
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(
      `build flavor base ${name} in ${moduleFile} has unreviewed reference: ${violation}`,
    );
  }
}

function assertUpdaterBuildFlavorBindingReferences(ast, binding, exportKey, containerDeclarator) {
  const name = binding.id.name;
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === binding.id || bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      staticMemberName(parent) === exportKey
    ) {
      const usage = ancestors.at(-2);
      if (
        usage?.type === "MemberExpression" &&
        usage.object === parent &&
        Object.prototype.hasOwnProperty.call(BUILD_FLAVORS, staticMemberName(usage))
      ) {
        return;
      }
      if (
        usage?.type === "SpreadElement" &&
        usage.argument === parent &&
        ancestors.at(-3) === containerDeclarator.init
      ) {
        return;
      }
    }
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(`updater build flavor binding ${name} has unreviewed reference: ${violation}`);
  }
}

function assertConsumerExportReferences(ast, name, declarator, exportKey, file) {
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === declarator.id || bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (parent?.type === "MemberExpression" && parent.object === node) {
      const key = staticMemberName(parent);
      if (key && key !== exportKey) return;
      const usage = ancestors.at(-2);
      if (
        key === exportKey &&
        usage?.type === "MemberExpression" &&
        usage.object === parent &&
        staticMemberName(usage)
      ) {
        return;
      }
    }
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(
      `updater consumer export ${name}.${exportKey} in ${file} has unreviewed reference: ${violation}`,
    );
  }
}

function memberPathFromBinding(node, name) {
  const target = unwrapChain(node);
  if (!target) return null;
  if (target.type === "Identifier") return target.name === name ? [] : null;
  if (target.type !== "MemberExpression") return null;
  const path = [];
  let current = target;
  while (current?.type === "MemberExpression") {
    path.unshift(staticMemberName(current));
    current = unwrapChain(current.object);
  }
  return current?.type === "Identifier" && current.name === name ? path : null;
}

function targetMutatesTrustedHost(node, name, protectedMembers) {
  const target = unwrapChain(node);
  if (!target) return false;
  const path = memberPathFromBinding(target, name);
  if (path) {
    if (path.length === 0) return true;
    if (protectedMembers === null) return true;
    if (path[0] == null) return true;
    return protectedMembers.has(path[0]);
  }
  if (target.type === "RestElement") {
    return targetMutatesTrustedHost(target.argument, name, protectedMembers);
  }
  if (target.type === "AssignmentPattern") {
    return targetMutatesTrustedHost(target.left, name, protectedMembers);
  }
  if (target.type === "ArrayPattern") {
    return target.elements.some((element) =>
      targetMutatesTrustedHost(element, name, protectedMembers),
    );
  }
  if (target.type === "ObjectPattern") {
    return target.properties.some((property) =>
      property.type === "RestElement"
        ? targetMutatesTrustedHost(property.argument, name, protectedMembers)
        : targetMutatesTrustedHost(property.value, name, protectedMembers),
    );
  }
  return false;
}

function trustedHostBindingMutated(ast, name, protectedMembers) {
  let mutated = false;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (mutated) return;
    let target = null;
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      target = node.type === "AssignmentExpression" ? node.left : node.argument;
    } else if (node.type === "UnaryExpression" && node.operator === "delete") {
      target = node.argument;
    } else if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type !== "VariableDeclaration"
    ) {
      target = node.left;
    }
    if (!target || bindingShadowedByAncestors(ancestors, name)) return;
    mutated = targetMutatesTrustedHost(target, name, protectedMembers);
  });
  return mutated;
}

function assertTrustedHostBinding(ast, name, mode, label) {
  if (topLevelBindings(ast, name).length !== 0) {
    throw new Error(`${label} trusted host binding ${name} is shadowed`);
  }
  const protectedMembers =
    name === "Object"
      ? new Set(["defineProperty", "values"])
      : name === "process"
        ? new Set(["arch", "env", "platform"])
        : name === "module"
          ? new Set(["require"])
        : name === "exports"
          ? null
          : new Set();
  if (trustedHostBindingMutated(ast, name, protectedMembers)) {
    throw new Error(`${label} trusted host binding ${name} is reassigned`);
  }
  if (mode === "any") return;

  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (bindingShadowedByAncestors(ancestors, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (mode === "call" && parent?.type === "CallExpression" && parent.callee === node) {
      return;
    }
    if (
      mode === "member" &&
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      staticMemberName(parent)
    ) {
      return;
    }
    if (mode === "exports" && parent?.type === "CallExpression" && parent.arguments[0] === node) {
      const callee = unwrapChain(parent.callee);
      if (
        callee.type === "MemberExpression" &&
        unwrapChain(callee.object)?.type === "Identifier" &&
        unwrapChain(callee.object).name === "Object" &&
        staticMemberName(callee) === "defineProperty"
      ) {
        return;
      }
    }
    violation = parent?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(`${label} trusted host binding ${name} has unreviewed reference: ${violation}`);
  }
}

function assertTrustedHostBindings(ast, requirements, label) {
  for (const [name, mode] of Object.entries(requirements)) {
    assertTrustedHostBinding(ast, name, mode, label);
  }
}

function assertNoCommonJsLoaderAccess(ast, label) {
  let specifier = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (specifier || node.type !== "CallExpression") return;
    const callee = unwrapChain(node.callee);
    if (
      callee.type !== "Identifier" ||
      callee.name !== "require" ||
      bindingShadowedByAncestors(ancestors, "require") ||
      node.arguments.length !== 1
    ) {
      return;
    }
    const value = staticModuleSpecifier(node.arguments[0]);
    if (value === "module" || value === "node:module") specifier = value;
  });
  if (specifier) {
    throw new Error(`${label} contains unreviewed CommonJS loader access: ${specifier}`);
  }
}

function variableBindingScope(ancestors, declaration) {
  const declarationIndex = ancestors.lastIndexOf(declaration);
  const candidates = declarationIndex >= 0 ? ancestors.slice(0, declarationIndex) : ancestors;
  if (declaration.kind === "var") {
    return [...candidates]
      .reverse()
      .find((node) => node.type === "Program" || isFunctionNode(node));
  }
  return [...candidates].reverse().find((node) =>
    [
      "Program",
      "BlockStatement",
      "ForStatement",
      "ForInStatement",
      "ForOfStatement",
      "SwitchStatement",
    ].includes(node.type),
  );
}

function bindingShadowedBelowScope(ancestors, scope, name) {
  const scopeIndex = ancestors.indexOf(scope);
  const nestedAncestors = scopeIndex >= 0 ? ancestors.slice(scopeIndex + 1) : ancestors;
  return bindingShadowedByAncestors(nestedAncestors, name);
}

function assertReadOnlyObjectAlias(scope, name, declarator, label) {
  let violation = null;
  walkAstWithAncestors(scope, (node, ancestors) => {
    if (violation || node.type !== "Identifier" || node.name !== name) return;
    if (node === declarator.id || bindingShadowedBelowScope(ancestors, scope, name)) return;
    const parent = ancestors.at(-1);
    if (isNonReferenceIdentifier(node, parent)) return;
    if (
      parent?.type !== "MemberExpression" ||
      parent.object !== node ||
      !staticMemberName(parent)
    ) {
      violation = parent?.type || "unknown expression";
      return;
    }
    const memberName = staticMemberName(parent);
    if (!ENVIRONMENT_VARIABLE_NAME.test(memberName)) {
      violation = `member ${memberName}`;
      return;
    }

    let chain = parent;
    let index = ancestors.length - 2;
    while (
      index >= 0 &&
      ancestors[index].type === "MemberExpression" &&
      ancestors[index].object === chain
    ) {
      chain = ancestors[index];
      index -= 1;
    }
    if (chain !== parent) {
      violation = "nested member access";
      return;
    }
    const consumer = ancestors[index];
    if (
      (consumer?.type === "AssignmentExpression" &&
        assignmentTargetMutatesBinding(consumer.left, name)) ||
      (consumer?.type === "UpdateExpression" &&
        assignmentTargetMutatesBinding(consumer.argument, name)) ||
      (consumer?.type === "UnaryExpression" &&
        consumer.operator === "delete" &&
        assignmentTargetMutatesBinding(consumer.argument, name)) ||
      ((consumer?.type === "ForInStatement" || consumer?.type === "ForOfStatement") &&
        consumer.left.type !== "VariableDeclaration" &&
        assignmentTargetMutatesBinding(consumer.left, name)) ||
      (consumer?.type === "CallExpression" &&
        unwrapChain(consumer.callee) === unwrapChain(chain))
    ) {
      violation = consumer.type;
    }
  });
  if (violation) {
    throw new Error(`${label} ${name} has unreviewed reference: ${violation}`);
  }
}

function assertProcessEnvReferences(ast, label) {
  const aliases = [];
  let violation = null;
  walkAstWithAncestors(ast, (node, ancestors) => {
    if (
      violation ||
      node.type !== "Identifier" ||
      node.name !== "process" ||
      bindingShadowedByAncestors(ancestors, "process")
    ) {
      return;
    }
    const member = ancestors.at(-1);
    if (
      member?.type !== "MemberExpression" ||
      member.object !== node ||
      staticMemberName(member) !== "env"
    ) {
      return;
    }
    const usage = ancestors.at(-2);
    if (
      usage?.type === "MemberExpression" &&
      usage.object === member &&
      staticMemberName(usage)
    ) {
      return;
    }
    if (usage?.type === "AssignmentPattern" && usage.right === member) return;
    if (
      usage?.type === "VariableDeclarator" &&
      usage.init === member &&
      usage.id.type === "Identifier"
    ) {
      const declaration = ancestors.at(-3);
      const scope =
        declaration?.type === "VariableDeclaration"
          ? variableBindingScope(ancestors, declaration)
          : null;
      if (!scope) {
        violation = "unscoped alias";
        return;
      }
      aliases.push({ scope, declarator: usage, name: usage.id.name });
      return;
    }
    violation = usage?.type || "unknown expression";
  });
  if (violation) {
    throw new Error(`${label} process.env has unreviewed reference: ${violation}`);
  }
  for (const alias of aliases) {
    assertReadOnlyObjectAlias(
      alias.scope,
      alias.name,
      alias.declarator,
      `${label} process.env alias`,
    );
  }
}

function analyzeConsumerAlias(ast, localName, exportKey) {
  const calls = new Set();
  let mutated = false;

  function inspect(node, shadowed) {
    if (shadowed) return;
    if (
      node.type === "AssignmentExpression" &&
      assignmentTargetMutatesBinding(node.left, localName)
    ) {
      mutated = true;
    }
    if (
      node.type === "UpdateExpression" &&
      assignmentTargetMutatesBinding(node.argument, localName)
    ) {
      mutated = true;
    }
    if (
      node.type === "UnaryExpression" &&
      node.operator === "delete" &&
      assignmentTargetMutatesBinding(node.argument, localName)
    ) {
      mutated = true;
    }
    if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type !== "VariableDeclaration" &&
      assignmentTargetMutatesBinding(node.left, localName)
    ) {
      mutated = true;
    }
    if (node.type !== "CallExpression") return;
    const callee = unwrapChain(node.callee);
    const namespace = callee.type === "MemberExpression" ? unwrapChain(callee.object) : null;
    const root = namespace?.type === "MemberExpression" ? unwrapChain(namespace.object) : null;
    const method = callee.type === "MemberExpression" ? staticMemberName(callee) : null;
    if (
      exportKey !== null &&
      root?.type === "Identifier" &&
      root.name === localName &&
      staticMemberName(namespace) === exportKey &&
      (method === "shouldIncludeSparkle" || method === "shouldIncludeUpdater")
    ) {
      calls.add(method);
    }
  }

  function visit(node, shadowed = false) {
    if (!node || typeof node !== "object") return;
    if (isFunctionNode(node)) {
      const nextShadowed = shadowed || functionScopeBindsName(node, localName);
      for (const param of node.params) visit(param, nextShadowed);
      visit(node.body, nextShadowed);
      return;
    }
    if (node.type === "BlockStatement") {
      const nextShadowed = shadowed || blockScopeBindsName(node, localName);
      for (const statement of node.body) visit(statement, nextShadowed);
      return;
    }
    if (node.type === "CatchClause") {
      const nextShadowed = shadowed || patternBindsName(node.param, localName);
      visit(node.param, nextShadowed);
      visit(node.body, nextShadowed);
      return;
    }
    if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      inspect(node, shadowed);
      const nextShadowed = shadowed || loopScopeBindsName(node, localName);
      for (const key of ["init", "left", "right", "test", "update", "body"]) {
        visit(node[key], nextShadowed);
      }
      return;
    }
    if (node.type === "SwitchStatement") {
      const nextShadowed = shadowed || switchScopeBindsName(node, localName);
      visit(node.discriminant, shadowed);
      for (const caseNode of node.cases) visit(caseNode, nextShadowed);
      return;
    }
    if (node.type === "ClassExpression" || node.type === "ClassDeclaration") {
      const nextShadowed = shadowed || node.id?.name === localName;
      visit(node.superClass, shadowed);
      visit(node.body, nextShadowed);
      return;
    }

    inspect(node, shadowed);
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((item) => visit(item, shadowed));
      else if (value && typeof value === "object") visit(value, shadowed);
    }
  }

  visit(ast);
  return { calls, mutated };
}

function findDualCallConsumer(jsSources, candidateFile, exportKey, parseRecord) {
  let mutationError = null;
  for (const file of jsSources) {
    if (file.name === candidateFile || !file.source.includes("shouldIncludeUpdater")) continue;
    const ast = parseRecord(file);
    for (const statement of ast.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declarator of statement.declarations) {
        if (declarator.id?.type !== "Identifier") continue;
        const specifier = directRelativeRequire(declarator.init);
        if (!specifier || resolveInternalRequire(file.name, specifier) !== candidateFile) continue;
        const bindings = topLevelBindings(ast, declarator.id.name);
        if (
          bindings.length !== 1 ||
          bindings[0].kind !== "variable" ||
          bindings[0].node !== declarator
        ) {
          continue;
        }
        const analysis = analyzeConsumerAlias(ast, declarator.id.name, exportKey);
        if (analysis.mutated) {
          mutationError = new Error(
            `updater consumer alias ${declarator.id.name} is mutated in ${file.name}`,
          );
          continue;
        }
        try {
          assertTrustedHostBindings(
            ast,
            { require: "call", module: "member" },
            `updater consumer ${file.name}`,
          );
        } catch (error) {
          mutationError = error;
          continue;
        }
        assertConsumerExportReferences(
          ast,
          declarator.id.name,
          declarator,
          exportKey,
          file.name,
        );
        if (
          analysis.calls.has("shouldIncludeSparkle") &&
          analysis.calls.has("shouldIncludeUpdater")
        ) {
          return {
            file: file.name,
            localName: declarator.id.name,
            sourceHash: sha256Text(file.source),
          };
        }
      }
    }
  }
  if (mutationError) throw mutationError;
  throw new Error(
    `updater dual-call consumer not found for ${candidateFile} export ${exportKey}`,
  );
}

function findMainUpdaterCandidate(jsSources) {
  const astCache = new Map();
  const parseRecord = (file) => {
    if (!astCache.has(file.name)) {
      astCache.set(file.name, parseJavaScript(file.source, file.name));
    }
    return astCache.get(file.name);
  };
  const rawCandidates = [];
  for (const file of jsSources) {
    if (
      !file.source.includes("shouldIncludeSparkle") ||
      !file.source.includes("shouldIncludeUpdater")
    ) {
      continue;
    }
    const ast = parseRecord(file);
    for (const candidate of updaterContainerCandidates(ast)) {
      rawCandidates.push({
        ...candidate,
        file: file.name,
        sourceHash: sha256Text(file.source),
        ast,
      });
    }
  }
  if (rawCandidates.length === 0) {
    throw new Error("main updater container not found");
  }

  const matches = [];
  const failures = [];
  for (const candidate of rawCandidates) {
    let exportKey;
    try {
      exportKey = findReviewedContainerExport(candidate.ast, candidate.containerName);
    } catch (error) {
      failures.push({ score: 1, error });
      continue;
    }
    let consumer;
    try {
      consumer = findDualCallConsumer(jsSources, candidate.file, exportKey, parseRecord);
    } catch (error) {
      failures.push({ score: 2, error });
      continue;
    }
    try {
      assertUpdaterContainerStable(candidate.ast, candidate);
    } catch (error) {
      failures.push({ score: 3, error });
      continue;
    }
    matches.push({ ...candidate, exportKey, consumer });
  }
  if (matches.length === 0) {
    failures.sort((left, right) => right.score - left.score);
    throw failures[0]?.error || new Error("main updater call chain not found");
  }
  if (matches.length !== 1) {
    throw new Error(
      `main updater call chain is ambiguous: ${matches.map((match) => match.file).join(", ")}`,
    );
  }
  return matches[0];
}

function assertReviewedUpdaterCallChain(candidate, buildFlavorSource, reviewedCallChains) {
  const actual = {
    definitionHash: candidate.sourceHash,
    buildFlavorHash: sha256Text(buildFlavorSource.source),
    consumerHash: candidate.consumer.sourceHash,
  };
  const reviewed = reviewedCallChains.some(
    (entry) =>
      entry?.definitionHash === actual.definitionHash &&
      entry?.buildFlavorHash === actual.buildFlavorHash &&
      entry?.consumerHash === actual.consumerHash,
  );
  if (!reviewed) {
    throw new Error(
      "updater call-chain source hashes are not reviewed: " +
        `definition=${actual.definitionHash} buildFlavor=${actual.buildFlavorHash} ` +
        `consumer=${actual.consumerHash}`,
    );
  }
}

function staticCheckUpdaterCandidate(candidate, jsSources, reviewedCallChains) {
  assertTrustedHostBindings(
    candidate.ast,
    {
      require: "call",
      module: "member",
      Object: "member",
      exports: "exports",
      process: "member",
    },
    `updater module ${candidate.file}`,
  );
  assertNoCommonJsLoaderAccess(candidate.ast, `updater module ${candidate.file}`);
  assertProcessEnvReferences(candidate.ast, `updater module ${candidate.file}`);
  const state = collectStaticScope(candidate.ast);
  assertUpdaterBuildFlavorBindingReferences(
    candidate.ast,
    state.buildFlavorBinding.declarator,
    state.buildFlavorBinding.exportKey,
    candidate.declarator,
  );
  const containerExport = commonJsExportRecords(candidate.ast).find(
    (record) =>
      record.key === candidate.exportKey &&
      exactGetterReturnName(record.descriptor) === candidate.containerName,
  );
  if (!containerExport) {
    throw new Error(`updater container export ${candidate.exportKey} is not available for review`);
  }
  assertStaticNamespaceReferences(
    candidate.ast,
    candidate.containerName,
    candidate.declarator,
    exactGetterFunction(containerExport.descriptor),
    "updater container",
  );
  const buildFlavorSource = validateRequiredBuildFlavorModule(jsSources, candidate, state);
  assertReviewedUpdaterCallChain(candidate, buildFlavorSource, reviewedCallChains);
  const context = createBaseContext(state);
  for (const predicateName of ["shouldIncludeSparkle", "shouldIncludeUpdater"]) {
    const result = evalFunction(
      candidate.predicates.get(predicateName),
      [BUILD_FLAVORS.Prod, "darwin", context.process.env],
      state,
      context,
      0,
    );
    if (result !== true) {
      throw new Error(
        `${predicateName} does not statically evaluate true for mac-arm64 production metadata in ${candidate.file}`,
      );
    }
  }
  for (const name of state.usedBindings) {
    const bindings = topLevelBindings(candidate.ast, name);
    if (bindings.length !== 1) {
      throw new Error(`static binding ${name} must be unique at module scope`);
    }
    if (analyzeConsumerAlias(candidate.ast, name, null).mutated) {
      throw new Error(`static binding ${name} is mutated after initialization`);
    }
    const init = state.values.get(name);
    if (
      name !== candidate.containerName &&
      bindings[0].kind === "variable" &&
      (init?.type === "ArrayExpression" || init?.type === "ObjectExpression")
    ) {
      assertStaticDataBindingReferences(candidate.ast, name, bindings[0].node);
    }
  }
}

function verifyUpdaterNotDisabledWithReviewedCallChains(app, asarPath, reviewedCallChains) {
  const sparkle = path.join(app, "Contents", "Frameworks", "Sparkle.framework");
  if (!fs.existsSync(sparkle)) {
    throw new Error("Sparkle.framework not found");
  }

  const jsSources = extractAsarJavaScriptSources(asarPath);
  staticCheckUpdaterCandidate(
    findMainUpdaterCandidate(jsSources),
    jsSources,
    reviewedCallChains,
  );
}

function verifyUpdaterNotDisabled(app, asarPath) {
  return verifyUpdaterNotDisabledWithReviewedCallChains(
    app,
    asarPath,
    REVIEWED_UPDATER_CALL_CHAINS,
  );
}

function verifyAppcast() {
  const appcast = path.join(OUT_DIR, "release", "appcast-darwin-arm64.xml");
  const releaseDir = path.join(OUT_DIR, "release");
  if (!fs.existsSync(appcast)) {
    throw new Error(`appcast not found: ${appcast}`);
  }

  const xml = readText(appcast);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
  });
  const parsed = parser.parse(xml);
  const item = Array.isArray(parsed.rss?.channel?.item)
    ? parsed.rss.channel.item[0]
    : parsed.rss?.channel?.item;
  const enclosure = Array.isArray(item?.enclosure) ? item.enclosure[0] : item?.enclosure;
  if (!enclosure) {
    throw new Error("appcast enclosure missing");
  }

  const url = enclosure["@_url"];
  const length = Number(enclosure["@_length"]);
  const version = enclosure["@_sparkle:version"];
  const shortVersion = enclosure["@_sparkle:shortVersionString"];
  const signature = enclosure["@_sparkle:edSignature"];
  const hardware = item?.["sparkle:hardwareRequirements"];
  if (!/^https:\/\/github\.com\/itstarts\/codex-app-rebuild\//.test(url || "")) {
    throw new Error("appcast URL is not the project release URL");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("appcast length must be a non-negative integer");
  }
  if (!/^\d{16}$/.test(version || "")) {
    throw new Error("appcast sparkle:version must be a 16-digit rebuild build number");
  }
  if (!shortVersion) {
    throw new Error("appcast sparkle:shortVersionString missing");
  }
  if (!signature) {
    throw new Error("appcast sparkle:edSignature missing");
  }
  if (!/arm64/i.test(String(hardware || ""))) {
    throw new Error("appcast hardware requirements must constrain arm64");
  }

  const zipPath = path.join(releaseDir, path.basename(new URL(url).pathname));
  if (!fs.existsSync(zipPath)) {
    throw new Error(`release zip referenced by appcast not found: ${zipPath}`);
  }
  const actualLength = fs.statSync(zipPath).size;
  if (length !== actualLength) {
    throw new Error(`appcast length ${length} does not match zip size ${actualLength}`);
  }
  verifySparkleSignature(zipPath, signature, readText(PUBLIC_KEY_PATH).trim());
  return { version, shortVersion, url, length, signature, hardware };
}

function verifyBuildNumberCases() {
  assertBuildNumberGreater("2026070601020302", "2026070601020301");
  assertBuildNumberGreater("2026070601020400", "2026070601020301");

  for (const candidate of ["2026070601020301", "2026070601020300"]) {
    try {
      assertBuildNumberGreater(candidate, "2026070601020301");
      throw new Error(`${candidate} build number accepted`);
    } catch (error) {
      if (!/not greater/.test(error.message)) {
        throw error;
      }
    }
  }
}

function main({ verifyRuntimeEvidence = true } = {}) {
  const app = path.join(OUT_DIR, PLATFORM, APP_BUNDLE_NAME);
  const plist = path.join(app, "Contents", "Info.plist");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const metadata = JSON.parse(readText(path.join(SRC_DIR, PLATFORM, "upstream-metadata.json")));

  if (!fs.existsSync(app)) {
    throw new Error(`${app} not found`);
  }
  if (!fs.existsSync(plist)) {
    throw new Error(`${plist} not found`);
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error(`${asarPath} not found`);
  }
  verifyBundleExecutable(app, metadata.upstreamExecutable);

  assertEqual(plutilGet(plist, "CFBundleIdentifier"), BUNDLE_ID, "bundle id");
  assertEqual(plutilGet(plist, "CFBundleName"), APP_NAME, "bundle name");
  assertEqual(plutilGet(plist, "CFBundleDisplayName"), APP_NAME, "display name");
  assertEqual(
    plutilGet(plist, "CFBundleShortVersionString"),
    metadata.upstreamVersion,
    "short version",
  );
  assertEqual(plutilGet(plist, "SUFeedURL"), FEED_URL, "feed URL");
  assertEqual(plutilGet(plist, "SUPublicEDKey"), readText(PUBLIC_KEY_PATH).trim(), "public key");

  verifyHelperBundleIds(app);
  verifyAsarPackage(asarPath);
  verifyAsarIntegrity(app, plist);
  verifyAboutText(asarPath);
  verifyUpdaterNotDisabled(app, asarPath);

  const appcastInfo = verifyAppcast();
  assertEqual(plutilGet(plist, "CFBundleVersion"), appcastInfo.version, "bundle version");
  assertEqual(
    plutilGet(plist, "CFBundleShortVersionString"),
    appcastInfo.shortVersion,
    "short version",
  );

  run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  verifyBuildNumberCases();
  if (verifyRuntimeEvidence) {
    verifyRequestEvidence(path.join(OUT_DIR, "verify"));
  }
  console.log(verifyRuntimeEvidence ? "[verify] ok" : "[verify:static] ok");
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--static")) {
      throw new Error("usage: node scripts/verify-build.js [--static]");
    }
    main({ verifyRuntimeEvidence: args[0] !== "--static" });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  verifyBundleExecutable,
  verifyRequestEvidence,
  verifyBuildNumberCases,
  verifyHelperBundleIds,
  verifyAsarPackage,
  verifyAsarIntegrity,
  verifyAboutText,
  verifyUpdaterNotDisabled,
  verifyUpdaterNotDisabledWithReviewedCallChains,
  verifyAppcast,
};
