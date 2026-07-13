const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const acorn = require("acorn");
const { PROJECT_ROOT, PLATFORM } = require("./constants");

const REQUIRED_ROLES = [
  "serviceTier",
  "requestResolver",
  "mainUi",
  "uiConsumer",
  "actionConsumer",
];
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_PATTERN = /^(?:0|[1-9]\d*)$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

const FAST_TIER_ATTESTATIONS = deepFreeze([
  {
    upstreamVersion: "26.707.30751",
    upstreamBuild: "5018",
    appAsarSha256: "bf6a8d30300c95cd12eb51fc39ea462a3b1bd4719a4ab260b22194340d0b2959",
    modules: [
      {
        role: "serviceTier",
        path: "webview/assets/app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~h59fr3q5-Cm3GYhJA.js",
        sha256: "56588ce901508a26cbd8ce472733d1f7b9ef95c1449d83c24becd42e62564005",
      },
      {
        role: "requestResolver",
        path: "webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~fpuf7waw-TVgZSYtN.js",
        sha256: "ee4f0ebd6a5232799d7ae6d142d9bb671713e2a7443c7533f36f90b075084ff7",
      },
      {
        role: "mainUi",
        path: "webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-BfuFOm2j.js",
        sha256: "fe1ea8d514d2fee341de36fd406805ef773ce17f44eb2aa4273c39d2799100d8",
      },
      {
        role: "uiConsumer",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-DN861ZdI.js",
        sha256: "60319960149cdb2532fb89db6f90bad0a495bcf83ff4ae493bca796c6a44d460",
      },
      {
        role: "actionConsumer",
        path: "webview/assets/review-mode-content-DUvP_Pse.js",
        sha256: "1a766c116c54841832566db935cf3eec2d5eac224d7bbb1d6eb88e837e9e7729",
      },
    ],
  },
  {
    upstreamVersion: "26.707.31428",
    upstreamBuild: "5059",
    appAsarSha256: "cc1bebbd77b827bc9f96f89216c8e101cdfc6d8ddd886d22b7e9507167be94b8",
    modules: [
      {
        role: "serviceTier",
        path: "webview/assets/app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-y0KJWbm3.js",
        sha256: "d4f74a3278e2bdb673809b4bdb609a5328316a74a8c983ea2bff9b29f0651afb",
      },
      {
        role: "requestResolver",
        path: "webview/assets/app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-y0KJWbm3.js",
        sha256: "d4f74a3278e2bdb673809b4bdb609a5328316a74a8c983ea2bff9b29f0651afb",
      },
      {
        role: "mainUi",
        path: "webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-C17KDkOa.js",
        sha256: "1245fed818b25823db965e7a111bc1fba3b5c699ca058de9ba839f832b5b8a99",
      },
      {
        role: "uiConsumer",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-Cdmi2Vi6.js",
        sha256: "3ff639167f02a2b7cea21fcdf37b6c441f80447ca732fc588675ad9c96692024",
      },
      {
        role: "actionConsumer",
        path: "webview/assets/review-mode-content-Bb2tYtzP.js",
        sha256: "6aac3fc4e02f3d096fd8161719205172304437e7594465216040bc9462ce76fd",
      },
    ],
  },
  {
    upstreamVersion: "26.707.41301",
    upstreamBuild: "5103",
    appAsarSha256: "2869c4765e5e0c6466e40f739bd0f7fc9e6b659ac10e1e03d391ca3f5e600b56",
    modules: [
      {
        role: "serviceTier",
        path: "webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-Bj9ubaFn.js",
        sha256: "f2ff3edb1382dcee6e8241fd117b7567c2a851afa19a9d735b446daa983f1a2a",
      },
      {
        role: "requestResolver",
        path: "webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-Bj9ubaFn.js",
        sha256: "f2ff3edb1382dcee6e8241fd117b7567c2a851afa19a9d735b446daa983f1a2a",
      },
      {
        role: "mainUi",
        path: "webview/assets/app-initial~app-main~onboarding-page-D4eTO0KG.js",
        sha256: "4db3de4934ac5af8546e5c1947fdd4a9917a2dc8792b282afc822075f5f8d3bb",
      },
      {
        role: "uiConsumer",
        path: "webview/assets/app-initial~app-main~page-hSvsQcNf.js",
        sha256: "e43103ecb869b1ecea9b2bc7124af1fe65c4ba9af440ab0dd13545df0c10bb0a",
      },
      {
        role: "actionConsumer",
        path: "webview/assets/review-mode-content-SOlP73MN.js",
        sha256: "82802ddd5fa1cb4bfca5949c3bd9e52be39bb1e2be542e19c69ac5d14b12404a",
      },
    ],
  },
  {
    upstreamVersion: "26.707.51957",
    upstreamBuild: "5175",
    appAsarSha256: "26708d5be316b43786ba00ea8581317426e44ff508e0d5cce40f53181582e027",
    modules: [
      {
        role: "serviceTier",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-k1satKyX.js",
        sha256: "4bd5e9614579174f1d612786cc693a3f1babd3dd1884d8949c6fea59091e19ac",
      },
      {
        role: "requestResolver",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-k1satKyX.js",
        sha256: "4bd5e9614579174f1d612786cc693a3f1babd3dd1884d8949c6fea59091e19ac",
      },
      {
        role: "mainUi",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-k1satKyX.js",
        sha256: "4bd5e9614579174f1d612786cc693a3f1babd3dd1884d8949c6fea59091e19ac",
      },
      {
        role: "uiConsumer",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-k1satKyX.js",
        sha256: "4bd5e9614579174f1d612786cc693a3f1babd3dd1884d8949c6fea59091e19ac",
      },
      {
        role: "actionConsumer",
        path: "webview/assets/review-mode-content-JCUBsbK-.js",
        sha256: "05ad476bb111ed2bf756c37c7cd6b80bd1fb3a0ba7bbf696bd42ed3880f859ee",
      },
    ],
  },
  {
    upstreamVersion: "26.707.61608",
    upstreamBuild: "5200",
    appAsarSha256: "7cd7f277d4d4b6221eb2121fd36d2238c28f203875c62f8abd36f3f12898cb86",
    modules: [
      {
        role: "serviceTier",
        path: "webview/assets/app-initial~app-main~new-thread-panel-page~onboarding-page~login-route~appgen-library-page~~gpgl9un5-_t04Xpau.js",
        sha256: "62998a86c70f2879d9cd419c8b2abbf26d4ac85fcbad2126e117a276ec92c461",
      },
      {
        role: "requestResolver",
        path: "webview/assets/app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-CeoeefuW.js",
        sha256: "99cd5e77cf850a987675959edf32e51ff3f52d34c45ce27db4609f8a56153c58",
      },
      {
        role: "mainUi",
        path: "webview/assets/app-initial~app-main~onboarding-page-D9sPBwim.js",
        sha256: "f1675e206f5877557a693318aac1d790fcb030d18cfd7e11d1ddfeec0d060ed1",
      },
      {
        role: "uiConsumer",
        path: "webview/assets/app-initial~app-main~page-CMpPiY3-.js",
        sha256: "cc4219c3c737a4296454dee70e188223f6a12d958649a2316672c59d14cd757a",
      },
      {
        role: "actionConsumer",
        path: "webview/assets/review-mode-content-h8P7xLlA.js",
        sha256: "23f78042ce285b70760b90d111e081f164a88cad8f98da6cacf333fea6204a1d",
      },
    ],
  },
]);

class FastTierAttestationError extends Error {
  constructor(code, message, phase = "attestation") {
    super(message);
    this.name = "FastTierAttestationError";
    this.code = code;
    this.phase = phase;
  }
}

function fail(code, message, phase) {
  throw new FastTierAttestationError(code, message, phase);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateCleanString(value, label, code) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be a non-empty string without surrounding whitespace`, "schema");
  }
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata_invalid", "upstream metadata must be an object", "schema");
  }
  validateCleanString(metadata.upstreamVersion, "upstreamVersion", "metadata_version_invalid");
  if (
    typeof metadata.upstreamBuild !== "string" ||
    !BUILD_PATTERN.test(metadata.upstreamBuild)
  ) {
    fail("metadata_build_invalid", "upstreamBuild must be a canonical decimal string", "schema");
  }
  if (
    typeof metadata.appAsarSha256 !== "string" ||
    !HASH_PATTERN.test(metadata.appAsarSha256)
  ) {
    fail("metadata_asar_hash_invalid", "appAsarSha256 must be 64 lowercase hex characters", "schema");
  }
  validateCleanString(metadata.appPath, "appPath", "metadata_app_path_invalid");
}

function validateInternalPath(value, label) {
  validateCleanString(value, label, "manifest_path_invalid");
  if (value.includes("\\") || value.startsWith("/") || path.posix.normalize(value) !== value) {
    fail("manifest_path_invalid", `${label} must be a normalized POSIX relative path`, "manifest");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("manifest_path_invalid", `${label} contains an invalid path segment`, "manifest");
  }
}

function validateManifests(manifests) {
  if (!Array.isArray(manifests)) {
    fail("manifest_invalid", "Fast tier attestations must be an array", "manifest");
  }
  const compositeKeys = new Set();
  const identityHashes = new Map();

  for (const [index, entry] of manifests.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("manifest_entry_invalid", `attestation entry ${index} must be an object`, "manifest");
    }
    validateCleanString(
      entry.upstreamVersion,
      `attestation entry ${index} upstreamVersion`,
      "manifest_version_invalid",
    );
    if (typeof entry.upstreamBuild !== "string" || !BUILD_PATTERN.test(entry.upstreamBuild)) {
      fail("manifest_build_invalid", `attestation entry ${index} has invalid upstreamBuild`, "manifest");
    }
    if (typeof entry.appAsarSha256 !== "string" || !HASH_PATTERN.test(entry.appAsarSha256)) {
      fail("manifest_asar_hash_invalid", `attestation entry ${index} has invalid appAsarSha256`, "manifest");
    }

    const identity = `${entry.upstreamVersion}\0${entry.upstreamBuild}`;
    const composite = `${identity}\0${entry.appAsarSha256}`;
    if (compositeKeys.has(composite)) {
      fail("manifest_composite_duplicate", `duplicate Fast tier attestation ${composite}`, "manifest");
    }
    compositeKeys.add(composite);
    const hashes = identityHashes.get(identity) ?? new Set();
    if (hashes.has(entry.appAsarSha256)) {
      fail("manifest_identity_hash_duplicate", `duplicate ASAR hash for ${identity}`, "manifest");
    }
    hashes.add(entry.appAsarSha256);
    identityHashes.set(identity, hashes);

    if (!Array.isArray(entry.modules) || entry.modules.length !== REQUIRED_ROLES.length) {
      fail(
        "manifest_roles_invalid",
        `attestation entry ${index} must contain five role mappings`,
        "manifest",
      );
    }
    const roles = new Set();
    const pathHashes = new Map();
    for (const module of entry.modules) {
      if (!module || typeof module !== "object" || Array.isArray(module)) {
        fail("manifest_module_invalid", `attestation entry ${index} has an invalid module`, "manifest");
      }
      if (!REQUIRED_ROLES.includes(module.role) || roles.has(module.role)) {
        fail("manifest_roles_invalid", `attestation entry ${index} has invalid role ${module.role}`, "manifest");
      }
      roles.add(module.role);
      validateInternalPath(module.path, `attestation role ${module.role} path`);
      if (typeof module.sha256 !== "string" || !HASH_PATTERN.test(module.sha256)) {
        fail("manifest_module_hash_invalid", `attestation role ${module.role} has invalid hash`, "manifest");
      }
      const existingHash = pathHashes.get(module.path);
      if (existingHash !== undefined && existingHash !== module.sha256) {
        fail(
          "manifest_path_hash_conflict",
          `attestation path ${module.path} has conflicting hashes`,
          "manifest",
        );
      }
      pathHashes.set(module.path, module.sha256);
    }
    if (REQUIRED_ROLES.some((role) => !roles.has(role))) {
      fail("manifest_roles_invalid", `attestation entry ${index} is missing a required role`, "manifest");
    }
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertRegularFilePath(projectRoot, target, code, label) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(target);
  if (!isInside(root, absolute)) {
    fail(code, `${label} escapes project root: ${absolute}`, "path");
  }

  const relative = path.relative(root, absolute);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      fail(code, `${label} missing: ${current} (${error.message})`, "path");
    }
    if (stat.isSymbolicLink()) {
      fail(code, `${label} must not contain symbolic links: ${current}`, "path");
    }
    const isLast = index === segments.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) {
      fail(code, `${label} has invalid file type: ${current}`, "path");
    }
  }

  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(absolute);
  if (!isInside(realRoot, realTarget)) {
    fail(code, `${label} resolves outside project root: ${realTarget}`, "path");
  }
  return absolute;
}

function readOriginalRole(asarPath, role, internalPath) {
  let entry;
  try {
    entry = asar.statFile(asarPath, internalPath, false);
  } catch (error) {
    fail("asar_role_missing", `ASAR role ${role} is missing: ${error.message}`, "asar-role");
  }
  if ("link" in entry || "files" in entry) {
    fail("asar_role_not_file", `ASAR role ${role} is not a regular file`, "asar-role");
  }
  try {
    return asar.extractFile(asarPath, internalPath, false);
  } catch (error) {
    fail("asar_role_extract_failed", `ASAR role ${role} extraction failed: ${error.message}`, "asar-role");
  }
}

function parseModule(source, role) {
  try {
    return acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    fail("structure_parse_failed", `${role} could not be parsed: ${error.message}`, "structure");
  }
}

function walk(node, visitor, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, ancestors);
  const nextAncestors = node.type ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, visitor, nextAncestors));
    } else if (value && typeof value === "object") {
      walk(value, visitor, nextAncestors);
    }
  }
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "Literal") return node.name ?? node.value;
  return null;
}

function stringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function findObjectProperty(node, name) {
  if (node?.type !== "ObjectExpression") return null;
  return node.properties.find(
    (property) => property.type === "Property" && propertyName(property.key) === name,
  ) ?? null;
}

function requireMarkers(source, role, markers) {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      fail("structure_marker_missing", `${role} is missing reviewed marker ${marker}`, "structure");
    }
  }
}

function topLevelFunctions(ast) {
  const functions = new Map();
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      functions.set(node.id.name, node);
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        if (
          declarator.id.type === "Identifier" &&
          (declarator.init?.type === "FunctionExpression" ||
            declarator.init?.type === "ArrowFunctionExpression")
        ) {
          functions.set(declarator.id.name, declarator.init);
        }
      }
    }
  }
  return functions;
}

function findResolverExport(ast, source) {
  const functions = topLevelFunctions(ast);
  const candidates = [];
  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers) {
      const local = specifier.local?.name;
      const fn = functions.get(local);
      if (!fn) continue;
      const text = source.slice(fn.start, fn.end);
      if (text.includes("read-config-for-host") && text.includes("service_tier")) {
        candidates.push({ local, exported: specifier.exported?.name, fn });
      }
    }
  }
  if (candidates.length !== 1 || !candidates[0].exported) {
    fail("structure_resolver_export", "request resolver export is not uniquely identifiable", "structure");
  }
  const candidate = candidates[0];
  let reassigned = false;
  walk(ast, (node) => {
    if (node.type !== "AssignmentExpression" && node.type !== "UpdateExpression") return;
    const target = node.type === "AssignmentExpression" ? node.left : node.argument;
    if (target?.type === "Identifier" && target.name === candidate.local) {
      reassigned = true;
    }
  });
  if (reassigned) {
    fail("structure_resolver_mutated", "request resolver binding is reassigned", "structure");
  }
  return candidate;
}

function resolveImportInternalPath(fromInternalPath, sourceValue) {
  if (typeof sourceValue !== "string" || !sourceValue.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromInternalPath), sourceValue));
}

function findImportedLocal(ast, fromInternalPath, targetInternalPath, importedName) {
  const matches = [];
  for (const node of ast.body) {
    if (
      node.type !== "ImportDeclaration" ||
      resolveImportInternalPath(fromInternalPath, node.source.value) !== targetInternalPath
    ) {
      continue;
    }
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported?.name === importedName
      ) {
        matches.push(specifier.local.name);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function nearestFunction(ancestors) {
  return [...ancestors].reverse().find((node) =>
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type),
  ) ?? null;
}

function ancestorFunctions(ancestors) {
  return ancestors
    .filter((node) =>
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type),
    )
    .reverse();
}

function patternContainsName(pattern, name) {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "AssignmentPattern") return patternContainsName(pattern.left, name);
  if (pattern.type === "RestElement") return patternContainsName(pattern.argument, name);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      patternContainsName(property.value ?? property.argument, name),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.some((item) => patternContainsName(item, name));
  }
  return false;
}

function functionBindsName(fn, name, before) {
  if (!fn) return false;
  if (fn.params.some((param) => patternContainsName(param, name))) return true;
  let found = false;
  walk(fn.body, (node, ancestors) => {
    if (found || node.start >= before || nearestFunction(ancestors) !== fn) return;
    if (node.type === "VariableDeclarator" && patternContainsName(node.id, name)) {
      found = true;
    }
  }, [fn]);
  return found;
}

function functionChainBindsName(functions, name, before) {
  return functions.some((fn) => functionBindsName(fn, name, before));
}

function expressionSource(source, node) {
  return node ? source.slice(node.start, node.end) : "";
}

function validateTurnHost(functions, source, payloadHost, resolverHost, callStart) {
  if (expressionSource(source, payloadHost) === expressionSource(source, resolverHost)) {
    return true;
  }
  if (
    payloadHost?.type !== "CallExpression" ||
    payloadHost.callee?.type !== "MemberExpression" ||
    propertyName(payloadHost.callee.property) !== "getHostId" ||
    payloadHost.callee.object?.type !== "Identifier"
  ) {
    return false;
  }
  const connectionName = payloadHost.callee.object.name;
  let valid = false;
  for (const functionNode of functions) {
    walk(functionNode.body, (node, ancestors) => {
      if (valid || node.start >= callStart || nearestFunction(ancestors) !== functionNode) return;
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.id.name === connectionName &&
        node.init?.type === "CallExpression" &&
        node.init.arguments.some(
          (argument) => expressionSource(source, argument) === expressionSource(source, resolverHost),
        )
      ) {
        valid = true;
      }
    }, [functionNode]);
    if (valid) break;
  }
  return valid;
}

function collectActionEvidence({ ast, source, actionPath, requestPath, servicePath, resolverExport }) {
  const resolverLocal = findImportedLocal(ast, actionPath, requestPath, resolverExport);
  if (!resolverLocal) {
    fail("structure_resolver_import", "action consumer does not import the reviewed resolver", "structure");
  }
  const evidence = [];

  walk(ast, (node, ancestors) => {
    if (node.type !== "CallExpression") return;
    const action = stringValue(node.arguments[0]);
    if (action !== "start-conversation" && action !== "start-turn-for-host") return;
    if (node.callee.type !== "Identifier") return;
    const importMatchesDispatcher = ast.body.some((item) =>
      item.type === "ImportDeclaration" &&
      resolveImportInternalPath(actionPath, item.source.value) === servicePath &&
      item.specifiers.some(
        (specifier) => specifier.type === "ImportSpecifier" && specifier.local.name === node.callee.name,
      ),
    );
    if (!importMatchesDispatcher) return;

    const payload = node.arguments[1];
    const hostProperty = findObjectProperty(payload, "hostId");
    const serviceProperty =
      action === "start-conversation"
        ? findObjectProperty(payload, "serviceTier")
        : findObjectProperty(findObjectProperty(payload, "params")?.value, "serviceTier");
    let tier = serviceProperty?.value;
    if (tier?.type === "AwaitExpression") tier = tier.argument;
    if (
      !hostProperty ||
      tier?.type !== "CallExpression" ||
      tier.callee.type !== "Identifier" ||
      tier.callee.name !== resolverLocal ||
      tier.arguments.length < 3 ||
      tier.arguments[0]?.type !== "Identifier" ||
      tier.arguments[1]?.type !== "Identifier" ||
      !(tier.arguments[2]?.type === "Literal" && tier.arguments[2].value === null)
    ) {
      fail("structure_action_tier", `${action} does not use the reviewed service tier resolver`, "structure");
    }
    const functions = ancestorFunctions(ancestors);
    if (!functionChainBindsName(functions, tier.arguments[0].name, node.start)) {
      fail("structure_action_scope", `${action} resolver scope is not bound in the action function`, "structure");
    }
    if (!functionChainBindsName(functions, tier.arguments[1].name, node.start)) {
      fail("structure_action_host", `${action} resolver host is not bound in the action function`, "structure");
    }
    const hostValid =
      action === "start-conversation"
        ? expressionSource(source, hostProperty.value) === expressionSource(source, tier.arguments[1])
        : validateTurnHost(functions, source, hostProperty.value, tier.arguments[1], node.start);
    if (!hostValid) {
      fail("structure_action_host", `${action} resolver host does not match the payload host`, "structure");
    }
    evidence.push({
      action,
      file: actionPath,
      resolverExport,
      resolverImport: resolverLocal,
      start: node.start,
    });
  });

  for (const action of ["start-conversation", "start-turn-for-host"]) {
    if (evidence.filter((item) => item.action === action).length !== 1) {
      fail("structure_action_count", `expected exactly one attested ${action} action`, "structure");
    }
  }
  return evidence;
}

function validateUiConsumer(ast, source) {
  let hasFastOption = false;
  let hasStandardOption = false;
  const setterLocals = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern") {
      for (const property of node.id.properties) {
        if (
          property.type === "Property" &&
          propertyName(property.key) === "setServiceTier" &&
          property.value.type === "Identifier"
        ) {
          setterLocals.add(property.value.name);
        }
      }
    }
    if (node.type === "BinaryExpression") {
      const leftProperty = propertyName(node.left?.property);
      const rightProperty = propertyName(node.right?.property);
      if (
        (leftProperty === "iconKind" && stringValue(node.right) === "fast") ||
        (rightProperty === "iconKind" && stringValue(node.left) === "fast")
      ) {
        hasFastOption = true;
      }
      if (
        ["==", "==="].includes(node.operator) &&
        ((leftProperty === "value" && node.right?.type === "Literal" && node.right.value === null) ||
          (rightProperty === "value" && node.left?.type === "Literal" && node.left.value === null))
      ) {
        hasStandardOption = true;
      }
    }
  });
  if (!hasFastOption) {
    fail("structure_ui_fast_option", "UI consumer does not select the reviewed Fast option", "structure");
  }
  if (!hasStandardOption) {
    fail("structure_ui_standard_option", "UI consumer does not preserve the Standard null option", "structure");
  }

  let setterFlow = false;
  walk(ast, (node) => {
    if (node.type !== "Property" || propertyName(node.key) !== "onSelectServiceTier") return;
    walk(node.value, (child, ancestors) => {
      if (setterFlow || child.type !== "CallExpression" || child.callee.type !== "Identifier") return;
      if (!setterLocals.has(child.callee.name)) return;
      const callback = nearestFunction(ancestors);
      const parameter = callback?.params?.[0];
      if (
        parameter?.type === "Identifier" &&
        child.arguments[0]?.type === "Identifier" &&
        child.arguments[0].name === parameter.name
      ) {
        setterFlow = true;
      }
    });
  });
  if (!setterFlow) {
    fail("structure_ui_setter_flow", "UI consumer does not pass the selected tier to setServiceTier", "structure");
  }
}

function verifyStructure(roleRecords) {
  const service = roleRecords.get("serviceTier");
  const request = roleRecords.get("requestResolver");
  const mainUi = roleRecords.get("mainUi");
  const ui = roleRecords.get("uiConsumer");
  const action = roleRecords.get("actionConsumer");

  requireMarkers(service.source, "serviceTier", ["priority", "default", "serviceTiers", "value:null", "iconKind"]);
  requireMarkers(request.source, "requestResolver", [
    "chatgpt",
    "fast_mode",
    "service_tier",
    "read-config-for-host",
    "list-models-for-host",
  ]);
  requireMarkers(mainUi.source, "mainUi", [
    "serviceTierForRequest",
    "availableOptions",
    "setServiceTier",
    "batch-write-config-value",
    "service_tier",
  ]);
  requireMarkers(ui.source, "uiConsumer", ["iconKind", "fast", "onSelectServiceTier", "setServiceTier"]);

  const serviceAst = parseModule(service.source, "serviceTier");
  const requestAst = parseModule(request.source, "requestResolver");
  const uiAst = parseModule(ui.source, "uiConsumer");
  const actionAst = parseModule(action.source, "actionConsumer");
  const resolver = findResolverExport(requestAst, request.source);
  validateUiConsumer(uiAst, ui.source);
  return collectActionEvidence({
    ast: actionAst,
    source: action.source,
    actionPath: action.module.path,
    requestPath: request.module.path,
    servicePath: service.module.path,
    resolverExport: resolver.exported,
  });
}

function verifyFastTierAttestation({
  metadata,
  manifests = FAST_TIER_ATTESTATIONS,
  projectRoot = PROJECT_ROOT,
} = {}) {
  validateMetadata(metadata);
  validateManifests(manifests);

  const reserved = manifests.filter(
    (entry) =>
      entry.upstreamVersion === metadata.upstreamVersion &&
      entry.upstreamBuild === metadata.upstreamBuild,
  );
  if (reserved.length === 0) {
    return { required: false, evidence: [] };
  }
  const matches = reserved.filter((entry) => entry.appAsarSha256 === metadata.appAsarSha256);
  if (matches.length !== 1) {
    fail(
      "attestation_hash_unreviewed",
      `upstream ${metadata.upstreamVersion}/${metadata.upstreamBuild} has an unreviewed ASAR hash`,
      "selection",
    );
  }
  const manifest = matches[0];
  const expectedAppPath = path.join(
    path.resolve(projectRoot),
    "src",
    PLATFORM,
    "upstream",
    "Codex.app",
  );
  const metadataAppPath = path.resolve(projectRoot, metadata.appPath);
  if (metadataAppPath !== expectedAppPath) {
    fail("attestation_app_path_mismatch", "metadata appPath is not the stable upstream app path", "path");
  }
  const asarPath = assertRegularFilePath(
    projectRoot,
    path.join(expectedAppPath, "Contents", "Resources", "app.asar"),
    "attestation_asar_path_invalid",
    "original app.asar",
  );
  asar.uncache(asarPath);
  const actualAsarSha256 = sha256(fs.readFileSync(asarPath));
  if (
    actualAsarSha256 !== metadata.appAsarSha256 ||
    actualAsarSha256 !== manifest.appAsarSha256
  ) {
    fail("attestation_asar_hash_mismatch", "original app.asar hash does not match metadata and manifest", "asar");
  }

  const extractedRoot = path.join(path.resolve(projectRoot), "src", PLATFORM, "_asar");
  const roleRecords = new Map();
  for (const module of manifest.modules) {
    const originalBytes = readOriginalRole(asarPath, module.role, module.path);
    const workPath = assertRegularFilePath(
      projectRoot,
      path.join(extractedRoot, ...module.path.split("/")),
      "attestation_work_path_invalid",
      `work role ${module.role}`,
    );
    const workBytes = fs.readFileSync(workPath);
    const originalSha256 = sha256(originalBytes);
    const workSha256 = sha256(workBytes);
    if (
      originalSha256 !== module.sha256 ||
      workSha256 !== module.sha256 ||
      !originalBytes.equals(workBytes)
    ) {
      fail(
        "attestation_role_hash_mismatch",
        `attested role ${module.role} differs between ASAR, work tree, and manifest`,
        "role-bytes",
      );
    }
    roleRecords.set(module.role, {
      module,
      source: workBytes.toString("utf8"),
      originalSha256,
      workSha256,
      workPath,
    });
  }

  const evidence = verifyStructure(roleRecords);
  return {
    required: true,
    manifest,
    actualAsarSha256,
    roles: roleRecords,
    evidence,
  };
}

module.exports = {
  FAST_TIER_ATTESTATIONS,
  FastTierAttestationError,
  verifyFastTierAttestation,
};
