#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
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
  EXECUTABLE_NAME,
  FEED_URL,
  PUBLIC_KEY_PATH,
} = require("./lib/constants");
const { readText, run } = require("./lib/fs-utils");
const { plutilGet } = require("./lib/plist-utils");
const { assertBuildNumberGreater } = require("./lib/version-utils");
const { computeAsarHeaderHash } = require("./lib/asar-utils");
const { mapHelperBundleId } = require("./build-mac-arm64");
const { verifySparkleSignature } = require("./generate-appcast");

const ABOUT_COPYRIGHT = "© OpenAI · itstarts Rebuild";
const FAST_TIER_EQUIVALENTS = new Set(["fast", "priority"]);
const BUILD_FLAVORS = {
  Dev: "dev",
  Agent: "agent",
  Nightly: "nightly",
  InternalAlpha: "internal-alpha",
  PublicBeta: "public-beta",
  Prod: "prod",
};

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
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

  return { functions, values, objectMethods };
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function createBaseContext() {
  return {
    process: {
      platform: "darwin",
      arch: "arm64",
      env: {
        NODE_ENV: "production",
      },
    },
    t: {
      As: BUILD_FLAVORS,
    },
  };
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

  const returns = [];
  for (const statement of fnNode.body.body) {
    if (statement.type === "ReturnStatement") {
      returns.push(statement.argument);
    }
  }
  if (returns.length !== 1) {
    throw new Error("predicate helper must have exactly one direct return");
  }
  return evalStatic(returns[0], state, context, depth + 1);
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
        return evalStatic(state.values.get(unwrapped.name), state, createBaseContext(), depth + 1);
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
      if (unwrapped.operator === "===" || unwrapped.operator === "==") {
        return left === right;
      }
      if (unwrapped.operator === "!==" || unwrapped.operator === "!=") {
        return left !== right;
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

function findPredicate(jsSources, predicateName) {
  for (const file of jsSources) {
    if (!file.source.includes(predicateName)) {
      continue;
    }
    const ast = parseJavaScript(file.source, file.name);
    const state = collectStaticScope(ast);
    let predicate = null;
    walkAst(ast, (node) => {
      if (predicate) {
        return;
      }
      if (node.type === "FunctionDeclaration" && node.id?.name === predicateName) {
        predicate = node;
        return;
      }
      if (
        node.type === "VariableDeclarator" &&
        node.id?.name === predicateName &&
        node.init
      ) {
        predicate = node.init;
        return;
      }
      if (node.type === "Property" && propertyName(node.key) === predicateName) {
        predicate = node.value;
      }
    });
    if (predicate) {
      return { file: file.name, predicate, state };
    }
  }
  throw new Error(`${predicateName} predicate not found`);
}

function staticCheckUpdaterPredicate(jsSources, predicateName) {
  const found = findPredicate(jsSources, predicateName);
  const result = evalFunction(
    found.predicate,
    [BUILD_FLAVORS.Prod, "darwin", createBaseContext().process.env],
    found.state,
    createBaseContext(),
    0,
  );
  if (result !== true) {
    throw new Error(
      `${predicateName} does not statically evaluate true for mac-arm64 production metadata in ${found.file}`,
    );
  }
}

function verifyUpdaterNotDisabled(app, asarPath) {
  const sparkle = path.join(app, "Contents", "Frameworks", "Sparkle.framework");
  if (!fs.existsSync(sparkle)) {
    throw new Error("Sparkle.framework not found");
  }

  const jsSources = extractAsarJavaScriptSources(asarPath);
  staticCheckUpdaterPredicate(jsSources, "shouldIncludeSparkle");
  staticCheckUpdaterPredicate(jsSources, "shouldIncludeUpdater");
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

function main() {
  const app = path.join(OUT_DIR, PLATFORM, APP_BUNDLE_NAME);
  const plist = path.join(app, "Contents", "Info.plist");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const executable = path.join(app, "Contents", "MacOS", EXECUTABLE_NAME);
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
  if (!fs.existsSync(executable)) {
    throw new Error(`${executable} not found`);
  }
  fs.accessSync(executable, fs.constants.X_OK);

  assertEqual(plutilGet(plist, "CFBundleIdentifier"), BUNDLE_ID, "bundle id");
  assertEqual(plutilGet(plist, "CFBundleName"), APP_NAME, "bundle name");
  assertEqual(plutilGet(plist, "CFBundleDisplayName"), APP_NAME, "display name");
  assertEqual(plutilGet(plist, "CFBundleExecutable"), EXECUTABLE_NAME, "executable");
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
  verifyRequestEvidence(path.join(OUT_DIR, "verify"));
  console.log("[verify] ok");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  verifyRequestEvidence,
  verifyBuildNumberCases,
  verifyHelperBundleIds,
  verifyAsarPackage,
  verifyAsarIntegrity,
  verifyAboutText,
  verifyUpdaterNotDisabled,
  verifyAppcast,
};
