#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { PROJECT_ROOT, SRC_DIR, PLATFORM } = require("./lib/constants");
const {
  walkAst,
  applyTextPatches,
  locateAsarAssetBundles,
  locateAsarBuildBundles,
  resolveAsarRoot,
} = require("./patch-util");
const {
  verifyFastTierAttestation,
  verifyFastTierIntegrity,
} = require("./lib/fast-tier-attestation");

const FAST_TIER_KEYS = new Set(["service_tier", "serviceTier", "tier"]);
const NATIVE_SERVICE_TIER_HELPERS = new Set(["Cf"]);
const TRUSTED_REQUEST_CALLS = new Set(["Hs", "Ts", "T", "eu"]);
const NORMALIZER_STRING_COERCION_HELPERS = new Set(["String", "Bt"]);

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

function isStringLiteral(node, value) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;
  if (unwrapped.type === "Literal") return unwrapped.value === value;
  if (
    unwrapped.type === "TemplateLiteral" &&
    unwrapped.expressions.length === 0 &&
    unwrapped.quasis.length === 1
  ) {
    return unwrapped.quasis[0].value.cooked === value;
  }
  return false;
}

function isNullLiteral(node) {
  return unwrapChain(node)?.type === "Literal" && unwrapChain(node).value === null;
}

function isBooleanLiteral(node, value) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type === "Literal") return unwrapped.value === value;
  if (unwrapped?.type === "UnaryExpression" && unwrapped.operator === "!") {
    const argument = unwrapChain(unwrapped.argument);
    if (argument?.type === "Literal") {
      return !Boolean(argument.value) === value;
    }
  }
  return false;
}

function walkNode(node, visitor, { skipNestedFunctions = false, isRoot = true } = {}) {
  if (!node || typeof node !== "object") return;
  if (
    !isRoot &&
    skipNestedFunctions &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  ) {
    return;
  }

  if (node.type) {
    visitor(node);
  }

  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item) =>
        walkNode(item, visitor, { skipNestedFunctions, isRoot: false }),
      );
      continue;
    }
    if (value && typeof value === "object") {
      walkNode(value, visitor, { skipNestedFunctions, isRoot: false });
    }
  }
}

function isAuthMethodMember(node) {
  const unwrapped = unwrapChain(node);
  return (
    unwrapped?.type === "MemberExpression" &&
    getPropertyName(unwrapped.property) === "authMethod"
  );
}

function patternBindsPropertyName(pattern, identifierName, propertyName) {
  if (!pattern || typeof pattern !== "object") return false;

  if (pattern.type === "Identifier") {
    return pattern.name === identifierName && identifierName === propertyName;
  }

  if (pattern.type === "RestElement") {
    return patternBindsPropertyName(pattern.argument, identifierName, propertyName);
  }

  if (pattern.type === "AssignmentPattern") {
    return patternBindsPropertyName(pattern.left, identifierName, propertyName);
  }

  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) => {
      if (property.type === "RestElement") {
        return patternBindsPropertyName(property.argument, identifierName, propertyName);
      }

      if (property.type !== "Property") return false;
      if (
        getPropertyName(property.key) === propertyName &&
        collectPatternIdentifiers(property.value, []).includes(identifierName)
      ) {
        return true;
      }
      return patternBindsPropertyName(property.value, identifierName, propertyName);
    });
  }

  if (pattern.type === "ArrayPattern") {
    return pattern.elements.some((element) =>
      patternBindsPropertyName(element, identifierName, propertyName),
    );
  }

  return false;
}

function isAuthMethodReferenceInScope(
  node,
  currentScope,
  scopesByNode,
  authBindings = null,
  seenBindings = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (isAuthMethodMember(unwrapped)) return true;

  if (unwrapped.type !== "Identifier") return false;

  const bindingInfo = resolveVisibleBindingInfo(unwrapped.name, currentScope);
  if (!bindingInfo) {
    return unwrapped.name === "authMethod";
  }

  const { binding, scope } = bindingInfo;
  if (authBindings?.has(binding)) return true;
  if (seenBindings.has(binding)) return false;
  seenBindings.add(binding);

  if (binding.kind === "parameter") {
    return patternBindsPropertyName(binding.node, unwrapped.name, "authMethod");
  }

  if (binding.kind !== "variable" || !binding.node.init) return false;

  const initScope = scopesByNode?.get(binding.node.init) ?? scope ?? currentScope;
  return isAuthMethodReferenceInScope(
    binding.node.init,
    initScope,
    scopesByNode,
    authBindings,
    seenBindings,
  );
}

function collectAuthMethodBindings(fnNode, scopesByNode) {
  const authBindings = new Set();

  walkNode(fnNode, (child) => {
    if (
      child.type !== "Property" ||
      getPropertyName(child.key) !== "authMethod" ||
      unwrapChain(child.value)?.type !== "Identifier"
    ) {
      return;
    }

    const bindingInfo = resolveVisibleBindingInfo(
      unwrapChain(child.value).name,
      scopesByNode.get(child.value),
    );
    if (bindingInfo) {
      authBindings.add(bindingInfo.binding);
    }
  }, { skipNestedFunctions: true });

  let changed = true;

  while (changed) {
    changed = false;

    walkNode(fnNode, (child) => {
      if (child.type === "VariableDeclarator" && child.id.type === "Identifier" && child.init) {
        const bindingInfo = resolveVisibleBindingInfo(
          child.id.name,
          scopesByNode.get(child.id),
        );
        if (!bindingInfo || authBindings.has(bindingInfo.binding)) return;

        const initScope = scopesByNode.get(child.init) ?? bindingInfo.scope;
        if (
          isAuthMethodReferenceInScope(
            child.init,
            initScope,
            scopesByNode,
            authBindings,
          )
        ) {
          authBindings.add(bindingInfo.binding);
          changed = true;
        }
        return;
      }

      if (
        child.type === "AssignmentExpression" &&
        child.operator === "=" &&
        child.left.type === "Identifier"
      ) {
        const bindingInfo = resolveVisibleBindingInfo(
          child.left.name,
          scopesByNode.get(child.left),
        );
        if (!bindingInfo || authBindings.has(bindingInfo.binding)) return;

        const rightScope = scopesByNode.get(child.right) ?? bindingInfo.scope;
        if (
          isAuthMethodReferenceInScope(
            child.right,
            rightScope,
            scopesByNode,
            authBindings,
          )
        ) {
          authBindings.add(bindingInfo.binding);
          changed = true;
        }
      }
    }, { skipNestedFunctions: true });
  }

  return authBindings;
}

function collectPatternIdentifiers(pattern, identifiers = []) {
  if (!pattern || typeof pattern !== "object") return identifiers;
  if (pattern.type === "Identifier") {
    identifiers.push(pattern.name);
    return identifiers;
  }
  if (pattern.type === "RestElement") {
    return collectPatternIdentifiers(pattern.argument, identifiers);
  }
  if (pattern.type === "AssignmentPattern") {
    return collectPatternIdentifiers(pattern.left, identifiers);
  }
  if (pattern.type === "ArrayPattern") {
    pattern.elements.forEach((element) => collectPatternIdentifiers(element, identifiers));
    return identifiers;
  }
  if (pattern.type === "ObjectPattern") {
    pattern.properties.forEach((property) => {
      if (property.type === "Property") {
        collectPatternIdentifiers(property.value, identifiers);
        return;
      }
      if (property.type === "RestElement") {
        collectPatternIdentifiers(property.argument, identifiers);
      }
    });
  }
  return identifiers;
}

function collectFunctionMap(ast) {
  const functions = new Map();
  const programScope = { type: "Program", parent: null, bindings: new Map() };
  const scopesByNode = new WeakMap();

  function addScopeBinding(scope, name, binding) {
    if (!scope || !name) return;
    const bindings = scope.bindings.get(name) ?? [];
    bindings.push(binding);
    scope.bindings.set(name, bindings);
  }

  function getVariableBindingScope(scope) {
    let current = scope;
    while (current && current.type !== "FunctionScope" && current.type !== "Program") {
      current = current.parent;
    }
    return current ?? programScope;
  }

  function visit(node, scope, parent = null) {
    if (!node || typeof node !== "object") return;

    let nextScope = scope;
    if (node.type === "BlockStatement") {
      nextScope = { type: "BlockScope", parent: scope ?? programScope, bindings: new Map() };
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      nextScope = { type: "FunctionScope", parent: scope ?? programScope, bindings: new Map() };
      scopesByNode.set(node, nextScope);
      node.params.forEach((param) => {
        collectPatternIdentifiers(param).forEach((name) => {
          addScopeBinding(nextScope, name, { kind: "parameter", node: param });
        });
      });
    }
    scopesByNode.set(node, nextScope ?? programScope);

    if (node.type === "FunctionDeclaration" && node.id?.name) {
      functions.set(node.id.name, { fnNode: node, scope: nextScope });
      addScopeBinding(scope ?? programScope, node.id.name, {
        kind: "function",
        node,
        scope: nextScope,
      });
    } else if (
      node.type === "VariableDeclarator" &&
      parent?.type === "VariableDeclaration"
    ) {
      const bindingScope =
        parent.kind === "var"
          ? getVariableBindingScope(scope ?? programScope)
          : (scope ?? programScope);
      collectPatternIdentifiers(node.id).forEach((name) => {
        addScopeBinding(bindingScope, name, {
          kind: "variable",
          node,
          scope: bindingScope,
          declarationKind: parent.kind,
        });
      });

      if (
        node.id.type === "Identifier" &&
        node.init &&
        (node.init.type === "FunctionExpression" ||
          node.init.type === "ArrowFunctionExpression")
      ) {
        functions.set(node.id.name, { fnNode: node.init, scope: bindingScope });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, nextScope, node));
        continue;
      }
      if (value && typeof value === "object") {
        visit(value, nextScope, node);
      }
    }
  }

  visit(ast, programScope);

  return { functions, scopesByNode };
}

function collectBindings(fnNode, scopesByNode = null) {
  const bindings = new Map();
  const writesByBinding = new WeakMap();

  function recordBindingValue(name, value, nameNode, valueScopeFallback) {
    bindings.set(name, value);
    if (!scopesByNode || !nameNode) return;
    const bindingInfo = resolveVisibleBindingInfo(
      name,
      getNodeScope(nameNode, null, scopesByNode),
    );
    if (!bindingInfo) return;
    const writes = writesByBinding.get(bindingInfo.binding) ?? [];
    writes.push({
      value,
      scope: getNodeScope(value, bindingInfo.scope ?? valueScopeFallback, scopesByNode),
      start: value.start ?? nameNode.start ?? 0,
    });
    writesByBinding.set(bindingInfo.binding, writes);
  }

  walkNode(fnNode, (child) => {
    if (child.type === "VariableDeclarator" && child.id.type === "Identifier" && child.init) {
      recordBindingValue(child.id.name, child.init, child.id, null);
      return;
    }

    if (
      child.type === "AssignmentExpression" &&
      child.operator === "=" &&
      child.left.type === "Identifier"
    ) {
      recordBindingValue(child.left.name, child.right, child.left, null);
    }
  }, { skipNestedFunctions: true });

  bindings.writesByBinding = writesByBinding;
  return bindings;
}

function getBindingWritesBeforeReference(binding, referenceNode, bindings) {
  const writes = bindings?.writesByBinding?.get(binding) ?? [];
  const referenceStart = referenceNode?.start ?? Number.POSITIVE_INFINITY;
  return writes.filter((write) => write.start <= referenceStart);
}

function getLatestBindingWriteBeforeReference(binding, referenceNode, bindings) {
  return getBindingWritesBeforeReference(binding, referenceNode, bindings).at(-1) ?? null;
}

function bindingHasFalseWriteBeforeReference(binding, referenceNode, bindings) {
  return getBindingWritesBeforeReference(binding, referenceNode, bindings).some((write) =>
    isBooleanLiteral(write.value, false),
  );
}

function resolveVisibleBinding(name, currentScope) {
  const bindingInfo = resolveVisibleBindingInfo(name, currentScope);
  return bindingInfo?.binding ?? null;
}

function resolveVisibleBindingInfo(name, currentScope) {
  let scope = currentScope;
  while (scope) {
    const bindings = scope.bindings.get(name);
    if (bindings?.length) {
      return {
        binding: bindings[bindings.length - 1],
        scope,
      };
    }
    scope = scope.parent;
  }
  return null;
}

function getNodeScope(node, currentScope, scopesByNode) {
  return scopesByNode?.get(node) ?? currentScope ?? null;
}

function resolveIdentifierReference(node, bindings, currentScope, scopesByNode) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "Identifier") return null;

  if (currentScope) {
    const bindingInfo = resolveVisibleBindingInfo(unwrapped.name, currentScope);
    if (bindingInfo) {
      const { binding, scope } = bindingInfo;

      if (binding.kind === "variable" && binding.node.init) {
        const latest = getLatestBindingWriteBeforeReference(binding, unwrapped, bindings);
        if (latest) {
          return {
            binding,
            value: latest.value,
            scope: latest.scope,
          };
        }
        return {
          binding,
          value: binding.node.init,
          scope: getNodeScope(binding.node.init, scope, scopesByNode),
        };
      }

      if (binding.kind === "function") {
        return {
          binding,
          value: binding.node,
          scope: binding.scope ?? scope,
        };
      }

      return {
        binding,
        value: null,
        scope,
      };
    }
  }

  const fallback = bindings?.get(unwrapped.name);
  if (!fallback) return null;
  return {
    binding: fallback,
    value: fallback,
    scope: getNodeScope(fallback, currentScope, scopesByNode),
  };
}

function resolveVisibleFunctionRecord(name, currentScope) {
  const bindingInfo = resolveVisibleBindingInfo(name, currentScope);
  const binding = bindingInfo?.binding;
  if (!binding) return null;

  if (binding.kind === "function") {
    return { fnNode: binding.node, scope: binding.scope };
  }

  if (
    binding.kind === "variable" &&
    binding.node.init &&
    (binding.node.init.type === "FunctionExpression" ||
      binding.node.init.type === "ArrowFunctionExpression")
  ) {
    return { fnNode: binding.node.init, scope: binding.scope };
  }

  return false;
}

function hasFastStandardBranches(node) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped || unwrapped.type !== "ConditionalExpression") return false;

  const consequentIsFast = isStringLiteral(unwrapped.consequent, "fast");
  const consequentIsStandard = isStringLiteral(unwrapped.consequent, "standard");
  const alternateIsFast = isStringLiteral(unwrapped.alternate, "fast");
  const alternateIsStandard = isStringLiteral(unwrapped.alternate, "standard");
  if (
    (!consequentIsFast && !consequentIsStandard) ||
    (!alternateIsFast && !alternateIsStandard)
  ) {
    return false;
  }

  const test = unwrapChain(unwrapped.test);
  if (test?.type !== "BinaryExpression") return false;

  const leftIsFast = isStringLiteral(test.left, "fast");
  const rightIsFast = isStringLiteral(test.right, "fast");
  if (!leftIsFast && !rightIsFast) return false;

  if (test.operator === "===") {
    return consequentIsFast && alternateIsStandard;
  }

  if (test.operator === "!==") {
    return consequentIsStandard && alternateIsFast;
  }

  return false;
}

function getFastStandardPatchBranchValues(node) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "BinaryExpression") return null;

  if (unwrapped.operator === "===") {
    return { consequent: "fast", alternate: "standard" };
  }

  if (unwrapped.operator === "!==") {
    return { consequent: "standard", alternate: "fast" };
  }

  return null;
}

function isUiStateObjectReference(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value) {
      return unwrapped.name === "state";
    }
    if (seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isUiStateObjectReference(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isUiFastSelectorReference(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (
    unwrapped.type === "MemberExpression" &&
    getPropertyName(unwrapped.property) === "speed"
  ) {
    return isUiStateObjectReference(
      unwrapped.object,
      bindings,
      getNodeScope(unwrapped.object, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isUiFastSelectorReference(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isUiFastSelectorTest(node, bindings, currentScope, scopesByNode) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped || unwrapped.type !== "BinaryExpression") return false;
  if (unwrapped.operator !== "===" && unwrapped.operator !== "!==") return false;

  if (isStringLiteral(unwrapped.left, "fast")) {
    return isUiFastSelectorReference(
      unwrapped.right,
      bindings,
      getNodeScope(unwrapped.right, currentScope, scopesByNode),
      scopesByNode,
    );
  }

  if (isStringLiteral(unwrapped.right, "fast")) {
    return isUiFastSelectorReference(
      unwrapped.left,
      bindings,
      getNodeScope(unwrapped.left, currentScope, scopesByNode),
      scopesByNode,
    );
  }

  return false;
}

function isFastStandardChoice(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "ConditionalExpression") {
    return (
      hasFastStandardBranches(unwrapped) &&
      isUiFastSelectorTest(
        unwrapped.test,
        bindings,
        getNodeScope(unwrapped.test, currentScope, scopesByNode),
        scopesByNode,
      )
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isFastStandardChoice(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isServiceTierMember(node) {
  const unwrapped = unwrapChain(node);
  return (
    unwrapped?.type === "MemberExpression" &&
    getPropertyName(unwrapped.property) === "service_tier"
  );
}

function hasNullServiceTierProperty(node) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "ObjectExpression") return false;

  return unwrapped.properties.some((property) => {
    return (
      property.type === "Property" &&
      getPropertyName(property.key) === "service_tier" &&
      isNullLiteral(property.value)
    );
  });
}

function isReadConfigForHostCall(node, currentScope, scopesByNode, source) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "AwaitExpression") {
    return isReadConfigForHostCall(
      unwrapped.argument,
      getNodeScope(unwrapped.argument, currentScope, scopesByNode),
      scopesByNode,
      source,
    );
  }

  if (unwrapped.type !== "CallExpression") return false;

  const callee = unwrapChain(unwrapped.callee);
  return (
    isTrustedRequestCallee(callee, currentScope, source) &&
    isStringLiteral(unwrapped.arguments[0], "read-config-for-host")
  );
}

function isReadConfigForHostConfigReference(
  node,
  currentScope,
  scopesByNode,
  source,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped || unwrapped.type !== "Identifier") return false;

  const bindingInfo = resolveVisibleBindingInfo(unwrapped.name, currentScope);
  if (!bindingInfo) return false;

  const { binding, scope } = bindingInfo;
  if (seen.has(binding)) return false;
  seen.add(binding);

  if (binding.kind !== "variable" || !binding.node.init) return false;

  if (patternBindsPropertyName(binding.node.id, unwrapped.name, "config")) {
    return isReadConfigForHostCall(
      binding.node.init,
      getNodeScope(binding.node.init, scope, scopesByNode),
      scopesByNode,
      source,
    );
  }

  const nextScope = getNodeScope(binding.node.init, scope, scopesByNode);
  return isReadConfigForHostConfigReference(
    binding.node.init,
    nextScope,
    scopesByNode,
    source,
    seen,
  );
}

function isNativeServiceTierStateObjectReference(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "CallExpression") {
    const callee = unwrapChain(unwrapped.callee);
    return (
      callee?.type === "Identifier" &&
      callee.name === "Qp" &&
      hasNullServiceTierProperty(unwrapped.arguments[0])
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isNativeServiceTierStateObjectReference(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isReadConfigServiceTierStateObjectReference(
  node,
  bindings,
  currentScope,
  scopesByNode,
  source,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "CallExpression") {
    const callee = unwrapChain(unwrapped.callee);
    return (
      callee?.type === "Identifier" &&
      callee.name === "Qp" &&
      isReadConfigForHostConfigReference(
        unwrapped.arguments[0],
        currentScope,
        scopesByNode,
        source,
      )
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isReadConfigServiceTierStateObjectReference(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      source,
      seen,
    );
  }

  return false;
}

function isNativeConfigServiceTierLookup(
  node,
) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "CallExpression") return false;

  const callee = unwrapChain(unwrapped.callee);
  if (callee?.type !== "Identifier" || callee.name !== "Tne") return false;

  if (unwrapped.arguments.length < 2 || !isNullLiteral(unwrapped.arguments[1])) {
    return false;
  }

  return true;
}

function isServiceTierStateReference(
  node,
  bindings,
  currentScope,
  scopesByNode,
  source,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (
    isNativeConfigServiceTierLookup(
      unwrapped,
    )
  ) {
    return true;
  }

  if (isServiceTierMember(unwrapped)) {
    const objectScope = getNodeScope(unwrapped.object, currentScope, scopesByNode);
    return (
      isNativeServiceTierStateObjectReference(
        unwrapped.object,
        bindings,
        objectScope,
        scopesByNode,
        new Set(seen),
      ) ||
      isReadConfigServiceTierStateObjectReference(
        unwrapped.object,
        bindings,
        objectScope,
        scopesByNode,
        source,
        new Set(seen),
      )
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isServiceTierStateReference(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      source,
      seen,
    );
  }

  return false;
}

function isHostTierLookup(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "AwaitExpression") {
    return isHostTierLookup(
      unwrapped.argument,
      bindings,
      getNodeScope(unwrapped.argument, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (isNullLiteral(unwrapped)) return true;

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isHostTierLookup(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type !== "CallExpression") return false;

  const callee = unwrapChain(unwrapped.callee);
  return callee?.type === "Identifier" && callee.name === "Hje";
}

function isFastModeFlag(node, bindings, currentScope, scopesByNode, seen = new Set()) {
  return isFastModeFlagWithScope(node, bindings, currentScope, scopesByNode, seen);
}

function isTopLevelOrNativeVjeReference(currentScope) {
  const bindingInfo = resolveVisibleBindingInfo("Vje", currentScope);
  if (!bindingInfo) return true;
  return bindingInfo.scope.type === "Program";
}

function isFastModeFlagCallee(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "Identifier") {
    if (unwrapped.name === "Vje") {
      return isTopLevelOrNativeVjeReference(currentScope);
    }

    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isFastModeFlagCallee(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isFastModeFlagWithScope(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (isBooleanLiteral(unwrapped, true)) {
    return true;
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    if (bindingHasFalseWriteBeforeReference(reference.binding, unwrapped, bindings)) {
      return false;
    }
    seen.add(reference.binding);
    return isFastModeFlagWithScope(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "AwaitExpression") {
    return isFastModeFlagWithScope(
      unwrapped.argument,
      bindings,
      getNodeScope(unwrapped.argument, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type !== "CallExpression") return false;

  return isFastModeFlagCallee(
    unwrapped.callee,
    bindings,
    getNodeScope(unwrapped.callee, currentScope, scopesByNode),
    scopesByNode,
    seen,
  );
}

function isKnownReactRetryLaneHelper(node, source) {
  if (
    !node ||
    (node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression")
  ) {
    return false;
  }

  if (node.params.length !== 2) return false;

  const text = source.slice(node.start, node.end);
  return (
    text.includes("memoizedState") &&
    text.includes("dehydrated") &&
    text.includes("retryLane")
  );
}

function isIgnoredNativeServiceTierShadow(binding, source) {
  if (binding.kind === "function") {
    return isKnownReactRetryLaneHelper(binding.node, source);
  }

  if (
    binding.kind === "variable" &&
    binding.node.init &&
    (binding.node.init.type === "FunctionExpression" ||
      binding.node.init.type === "ArrowFunctionExpression")
  ) {
    return isKnownReactRetryLaneHelper(binding.node.init, source);
  }

  return false;
}

function hasShadowingNativeServiceTierHelper(helperName, currentScope, source) {
  let visible = currentScope;
  while (visible) {
    const bindings = visible.bindings.get(helperName) ?? [];
    for (const binding of bindings) {
      if (!isIgnoredNativeServiceTierShadow(binding, source)) {
        return true;
      }
    }
    visible = visible.parent;
  }
  return false;
}

function isNativeServiceTierHelperCall(
  node,
  bindings,
  currentScope,
  source,
  scopesByNode,
) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "CallExpression") return false;

  const callee = unwrapChain(unwrapped.callee);
  if (callee?.type !== "Identifier" || !NATIVE_SERVICE_TIER_HELPERS.has(callee.name)) {
    return false;
  }
  if (hasShadowingNativeServiceTierHelper(callee.name, currentScope, source)) {
    return false;
  }

  if (unwrapped.arguments.length < 3) return false;

  const [tierSource, serviceTierState, nativeFlag] = unwrapped.arguments;
  if (!isHostTierLookup(tierSource, bindings, currentScope, scopesByNode)) return false;
  if (
    !isServiceTierStateReference(
      serviceTierState,
      bindings,
      currentScope,
      scopesByNode,
      source,
    )
  ) {
    return false;
  }
  return (
    nativeFlag != null &&
    isFastModeFlagWithScope(nativeFlag, bindings, currentScope, scopesByNode)
  );
}

function getFunctionReturnExpressions(fnNode) {
  if (fnNode.body.type !== "BlockStatement") {
    return [fnNode.body];
  }

  const expressions = [];
  walkNode(fnNode.body, (child) => {
    if (child.type === "ReturnStatement" && child.argument) {
      expressions.push(child.argument);
    }
  }, { skipNestedFunctions: true });
  return expressions;
}

function helperReturnsNativeServiceTierValue(
  fnName,
  currentScope,
  source,
  scopesByNode,
  seen = new Set(),
) {
  if (!fnName || seen.has(fnName)) return false;
  const fnRecord = resolveVisibleFunctionRecord(fnName, currentScope);
  if (!fnRecord) return false;

  const nextSeen = new Set(seen);
  nextSeen.add(fnName);
  const { fnNode, scope } = fnRecord;
  const bindings = collectBindings(fnNode, scopesByNode);
  const returnExpressions = getFunctionReturnExpressions(fnNode);
  if (returnExpressions.length === 0) return false;

  let hasNativeReturn = false;
  for (const expression of returnExpressions) {
    const expressionScope = scopesByNode?.get(expression) ?? scope;
    if (
      isNativeServiceTierChain(
        expression,
        bindings,
        source,
        expressionScope,
        scopesByNode,
        new Set(nextSeen),
      )
    ) {
      hasNativeReturn = true;
      continue;
    }

    if (
      isNeutralServiceTierReturn(
        expression,
        bindings,
        expressionScope,
        scopesByNode,
      )
    ) {
      continue;
    }

    return false;
  }

  return hasNativeReturn;
}

function isNeutralServiceTierReturn(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (isNullLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === "SequenceExpression" && unwrapped.expressions.length > 0) {
    const lastExpression = unwrapped.expressions[unwrapped.expressions.length - 1];
    return isNeutralServiceTierReturn(
      lastExpression,
      bindings,
      getNodeScope(lastExpression, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isNeutralServiceTierReturn(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return false;
}

function isNativeServiceTierChain(
  node,
  bindings,
  source,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    seen.add(reference.binding);
    return isNativeServiceTierChain(
      reference.value,
      bindings,
      source,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "AwaitExpression") {
    return isNativeServiceTierChain(
      unwrapped.argument,
      bindings,
      source,
      getNodeScope(unwrapped.argument, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "ConditionalExpression") {
    return (
      isNativeServiceTierChain(
        unwrapped.consequent,
        bindings,
        source,
        getNodeScope(unwrapped.consequent, currentScope, scopesByNode),
        scopesByNode,
        seen,
      ) &&
      isNativeServiceTierChain(
        unwrapped.alternate,
        bindings,
        source,
        getNodeScope(unwrapped.alternate, currentScope, scopesByNode),
        scopesByNode,
        seen,
      )
    );
  }

  if (unwrapped.type !== "CallExpression") return false;

  const callee = unwrapChain(unwrapped.callee);
  if (callee?.type !== "Identifier") return false;

  if (
    isNativeServiceTierHelperCall(
      unwrapped,
      bindings,
      currentScope,
      source,
      scopesByNode,
    )
  ) {
    return true;
  }

  return (
    helperReturnsNativeServiceTierValue(
      callee.name,
      currentScope,
      source,
      scopesByNode,
      seen,
    ) ||
    helperReturnsConfigDerivedServiceTierValue(
      callee.name,
      currentScope,
      source,
      scopesByNode,
      seen,
    )
  );
}

function findProperty(node, keyName) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped || unwrapped.type !== "ObjectExpression") return null;
  return (
    unwrapped.properties.find((property) => {
      return property.type === "Property" && getPropertyName(property.key) === keyName;
    }) ?? null
  );
}

function getIdentifierName(node) {
  const unwrapped = unwrapChain(node);
  return unwrapped?.type === "Identifier" ? unwrapped.name : null;
}

function fallbackFunctionSourceForName(name, source) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const firstBrace = source.indexOf("{", start + marker.length);
  if (firstBrace === -1) return "";
  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  return "";
}

function fallbackFunctionRecordForName(name, source) {
  const text = fallbackFunctionSourceForName(name, source);
  if (!text) return null;
  try {
    const ast = acorn.parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
    const fnNode = ast.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
    );
    return fnNode ? { fnNode, text } : null;
  } catch {
    return null;
  }
}

function functionSourceForName(name, currentScope, source) {
  const fnRecord = resolveVisibleFunctionRecord(name, currentScope);
  if (fnRecord === false) {
    return "";
  }
  if (fnRecord == null) {
    return fallbackFunctionSourceForName(name, source);
  }
  return source.slice(fnRecord.fnNode.start, fnRecord.fnNode.end);
}

function isNormalizerReturnIdentifierAllowed(node, parameterNames) {
  return (
    parameterNames.has(node.name) ||
    NORMALIZER_STRING_COERCION_HELPERS.has(node.name)
  );
}

function hasAllowedConfigTierNormalizerReturns(fnNode) {
  const parameterNames = new Set();
  for (const param of fnNode.params ?? []) {
    collectPatternIdentifiers(param).forEach((name) => parameterNames.add(name));
  }
  if (parameterNames.size === 0) return false;

  const returns = getFunctionReturnExpressions(fnNode);
  if (returns.length === 0) return false;

  let hasNull = false;
  let hasStringCoercion = false;
  let allowed = true;
  for (const expression of returns) {
    walkNode(expression, (child) => {
      if (isNullLiteral(child)) {
        hasNull = true;
      }
      if (
        child.type === "CallExpression" &&
        NORMALIZER_STRING_COERCION_HELPERS.has(getIdentifierName(child.callee))
      ) {
        hasStringCoercion = true;
      }
      if (
        child.type === "Identifier" &&
        !isNormalizerReturnIdentifierAllowed(child, parameterNames)
      ) {
        allowed = false;
      }
    }, { skipNestedFunctions: true });
  }

  return allowed && hasNull && hasStringCoercion;
}

function isKnownConfigTierNormalizerName(name, currentScope, source) {
  const fnRecord = resolveVisibleFunctionRecord(name, currentScope);
  if (fnRecord === false) return false;
  const fallbackRecord =
    fnRecord == null ? fallbackFunctionRecordForName(name, source) : null;
  const fnNode = fnRecord?.fnNode ?? fallbackRecord?.fnNode;
  if (!fnNode) return false;
  const text =
    fnRecord == null
      ? fallbackRecord.text
      : source.slice(fnRecord.fnNode.start, fnRecord.fnNode.end);
  return (
    /[=!]==?null|null[=!]==?/.test(text) &&
    text.includes("typeof") &&
    text.includes("symbol") &&
    text.includes("boolean") &&
    text.includes("function") &&
    hasAllowedConfigTierNormalizerReturns(fnNode)
  );
}

function isKnownConfigModelLookupCall(
  node,
  configTierObjectNames,
  currentScope,
  source,
  scopesByNode,
) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "AwaitExpression") return false;
  const argument = unwrapChain(unwrapped.argument);
  if (argument?.type !== "CallExpression") return false;
  const calleeName = getIdentifierName(argument.callee);
  if (!calleeName) return false;
  const fnRecord = resolveVisibleFunctionRecord(calleeName, currentScope);
  if (!fnRecord) return false;
  let hasTrustedModelListRequest = false;
  walkNode(fnRecord.fnNode, (child) => {
    const call = unwrapChain(child);
    if (call?.type !== "CallExpression") return;
    const callee = unwrapChain(call.callee);
    if (
      isTrustedRequestCallee(callee, getNodeScope(call, fnRecord.scope, scopesByNode), source) &&
      isStringLiteral(call.arguments[0], "list-models-for-host")
    ) {
      hasTrustedModelListRequest = true;
    }
  }, { skipNestedFunctions: true });
  if (!hasTrustedModelListRequest) return false;
  return argument.arguments.some((item) =>
    hasConfigModelReference(item, configTierObjectNames),
  );
}

function getMemberObjectIdentifierName(node, propertyName) {
  const unwrapped = unwrapChain(node);
  if (
    unwrapped?.type !== "MemberExpression" ||
    getPropertyName(unwrapped.property) !== propertyName
  ) {
    return null;
  }
  const object = unwrapChain(unwrapped.object);
  return object?.type === "Identifier" ? object.name : null;
}

function isConfigServiceTierArgument(node, configTierObjectNames) {
  const objectName = getMemberObjectIdentifierName(node, "service_tier");
  return objectName != null && configTierObjectNames.has(objectName);
}

function hasConfigModelReference(node, configTierObjectNames) {
  let found = false;
  walkNode(node, (child) => {
    const objectName = getMemberObjectIdentifierName(child, "model");
    if (objectName != null && configTierObjectNames.has(objectName)) {
      found = true;
    }
  }, { skipNestedFunctions: true });
  return found;
}

function isConfigTierNormalizerModelArgument(
  node,
  configTierObjectNames,
  currentScope,
  source,
  scopesByNode,
) {
  const unwrapped = unwrapChain(node);
  if (isNullLiteral(unwrapped)) return true;
  return isKnownConfigModelLookupCall(
    unwrapped,
    configTierObjectNames,
    currentScope,
    source,
    scopesByNode,
  );
}

function isConfigTierNormalizerFlagArgument(
  node,
  bindings,
  currentScope,
  scopesByNode,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return false;
  if (isBooleanLiteral(unwrapped, false)) return false;

  if (unwrapped.type === "SequenceExpression" && unwrapped.expressions.length > 0) {
    const lastExpression = unwrapped.expressions[unwrapped.expressions.length - 1];
    return isConfigTierNormalizerFlagArgument(
      lastExpression,
      bindings,
      getNodeScope(lastExpression, currentScope, scopesByNode),
      scopesByNode,
      seen,
    );
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return false;
    if (bindingHasFalseWriteBeforeReference(reference.binding, unwrapped, bindings)) {
      return false;
    }
    seen.add(reference.binding);
    return isConfigTierNormalizerFlagArgument(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      seen,
    );
  }

  return true;
}

function isConfigDerivedServiceTierNormalizerCall(
  node,
  configTierObjectNames,
  bindings,
  currentScope,
  scopesByNode,
  source,
) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "CallExpression") return false;
  const calleeName = getIdentifierName(unwrapped.callee);
  if (!calleeName || !isKnownConfigTierNormalizerName(calleeName, currentScope, source)) {
    return false;
  }
  if (unwrapped.arguments.length < 3) return false;
  const serviceTierObjectName = getMemberObjectIdentifierName(
    unwrapped.arguments[1],
    "service_tier",
  );
  if (
    serviceTierObjectName == null ||
    !configTierObjectNames.has(serviceTierObjectName)
  ) {
    return false;
  }
  const sameConfigObjectNames = new Set([serviceTierObjectName]);
  return (
    isConfigTierNormalizerModelArgument(
      unwrapped.arguments[0],
      sameConfigObjectNames,
      currentScope,
      source,
      scopesByNode,
    ) &&
    isConfigTierNormalizerFlagArgument(
      unwrapped.arguments[2],
      bindings,
      getNodeScope(unwrapped.arguments[2], currentScope, scopesByNode),
      scopesByNode,
    )
  );
}

function collectConfigDerivedServiceTierNormalizerCallees(
  expressions,
  configTierObjectNames,
  bindings,
  currentScope,
  scopesByNode,
  source,
) {
  const callees = new Set();
  for (const expression of expressions) {
    walkNode(expression, (node) => {
      if (
        !isConfigDerivedServiceTierNormalizerCall(
          node,
          configTierObjectNames,
          bindings,
          currentScope,
          scopesByNode,
          source,
        )
      ) {
        return;
      }
      const name = getIdentifierName(node.callee);
      if (name) callees.add(name);
    });
  }
  return callees;
}

function isServiceStateNormalizerCall(node, serviceTierStateNames) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "CallExpression" || unwrapped.arguments.length < 2) {
    return false;
  }
  const calleeName = getIdentifierName(unwrapped.callee);
  if (calleeName !== "kl") return false;
  const state = unwrapChain(unwrapped.arguments[0]);
  return (
    state?.type === "Identifier" &&
    serviceTierStateNames.has(state.name) &&
    isNullLiteral(unwrapped.arguments[1])
  );
}

function isNeutralConfigDerivedServiceTierNormalizerCall(
  node,
  nativeCallees,
  serviceTierStateNames,
  bindings,
  currentScope,
  scopesByNode,
  source,
) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "CallExpression") return false;
  const calleeName = getIdentifierName(unwrapped.callee);
  if (!calleeName || !nativeCallees.has(calleeName)) return false;
  if (!isKnownConfigTierNormalizerName(calleeName, currentScope, source)) {
    return false;
  }
  if (unwrapped.arguments.length < 3) return false;
  if (!isNullLiteral(unwrapped.arguments[0])) return false;
  if (!isServiceStateNormalizerCall(unwrapped.arguments[1], serviceTierStateNames)) {
    return false;
  }
  return isConfigTierNormalizerFlagArgument(
    unwrapped.arguments[2],
    bindings,
    getNodeScope(unwrapped.arguments[2], currentScope, scopesByNode),
    scopesByNode,
  );
}

function collectReadConfigNames(fnNode, scope, scopesByNode, source) {
  const configNames = new Set();
  walkNode(fnNode, (child) => {
    if (
      child.type !== "VariableDeclarator" ||
      !child.init ||
      !isReadConfigForHostCall(
        child.init,
        getNodeScope(child.init, scope, scopesByNode),
        scopesByNode,
        source,
      )
    ) {
      return;
    }
    collectPatternIdentifiers(child.id).forEach((name) => {
      if (patternBindsPropertyName(child.id, name, "config")) {
        configNames.add(name);
      }
    });
  }, { skipNestedFunctions: true });
  return configNames;
}

function collectConfigTierObjectNames(fnNode, scope, scopesByNode, source) {
  const configNames = collectReadConfigNames(fnNode, scope, scopesByNode, source);
  const objectNames = new Set();
  walkNode(fnNode, (child) => {
    if (
      child.type !== "VariableDeclarator" ||
      child.id.type !== "Identifier" ||
      unwrapChain(child.init)?.type !== "CallExpression"
    ) {
      return;
    }
    const call = unwrapChain(child.init);
    const firstArgument = unwrapChain(call.arguments[0]);
    if (firstArgument?.type === "Identifier" && configNames.has(firstArgument.name)) {
      objectNames.add(child.id.name);
    }
  }, { skipNestedFunctions: true });
  return objectNames;
}

function collectScopeParameterNames(fnNode) {
  const scopeNames = new Set();
  const firstParam = fnNode.params?.[0];
  collectPatternIdentifiers(firstParam).forEach((name) => scopeNames.add(name));
  return scopeNames;
}

function collectServiceTierStateNames(fnNode) {
  const scopeNames = collectScopeParameterNames(fnNode);
  const stateNames = new Set();
  walkNode(fnNode, (child) => {
    if (
      child.type !== "VariableDeclarator" ||
      child.id.type !== "Identifier" ||
      unwrapChain(child.init)?.type !== "CallExpression"
    ) {
      return;
    }
    const call = unwrapChain(child.init);
    const callee = unwrapChain(call.callee);
    const object = unwrapChain(callee?.object);
    if (
      callee?.type === "MemberExpression" &&
      getPropertyName(callee.property) === "get" &&
      object?.type === "Identifier" &&
      scopeNames.has(object.name)
    ) {
      stateNames.add(child.id.name);
    }
  }, { skipNestedFunctions: true });
  return stateNames;
}

function classifyConfigDerivedServiceTierReturn(
  node,
  bindings,
  currentScope,
  scopesByNode,
  nativeNormalizerCallees,
  configTierObjectNames,
  serviceTierStateNames,
  source,
  seen = new Set(),
) {
  const unwrapped = unwrapChain(node);
  if (!unwrapped) return "invalid";

  if (isNullLiteral(unwrapped)) {
    return "neutral";
  }

  if (unwrapped.type === "AwaitExpression") {
    return classifyConfigDerivedServiceTierReturn(
      unwrapped.argument,
      bindings,
      getNodeScope(unwrapped.argument, currentScope, scopesByNode),
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      seen,
    );
  }

  if (unwrapped.type === "SequenceExpression" && unwrapped.expressions.length > 0) {
    const lastExpression = unwrapped.expressions[unwrapped.expressions.length - 1];
    return classifyConfigDerivedServiceTierReturn(
      lastExpression,
      bindings,
      getNodeScope(lastExpression, currentScope, scopesByNode),
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      seen,
    );
  }

  if (unwrapped.type === "ConditionalExpression") {
    const consequent = classifyConfigDerivedServiceTierReturn(
      unwrapped.consequent,
      bindings,
      getNodeScope(unwrapped.consequent, currentScope, scopesByNode),
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      new Set(seen),
    );
    const alternate = classifyConfigDerivedServiceTierReturn(
      unwrapped.alternate,
      bindings,
      getNodeScope(unwrapped.alternate, currentScope, scopesByNode),
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      new Set(seen),
    );
    if (consequent === "invalid" || alternate === "invalid") return "invalid";
    return consequent === "native" || alternate === "native" ? "native" : "neutral";
  }

  if (unwrapped.type === "Identifier") {
    const reference = resolveIdentifierReference(
      unwrapped,
      bindings,
      currentScope,
      scopesByNode,
    );
    if (!reference?.value || seen.has(reference.binding)) return "invalid";
    seen.add(reference.binding);
    return classifyConfigDerivedServiceTierReturn(
      reference.value,
      bindings,
      reference.scope,
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      seen,
    );
  }

  if (unwrapped.type !== "CallExpression") {
    return "invalid";
  }

  if (
    isConfigDerivedServiceTierNormalizerCall(
      unwrapped,
      configTierObjectNames,
      bindings,
      currentScope,
      scopesByNode,
      source,
    )
  ) {
    return "native";
  }

  return isNeutralConfigDerivedServiceTierNormalizerCall(
    unwrapped,
    nativeNormalizerCallees,
    serviceTierStateNames,
    bindings,
    currentScope,
    scopesByNode,
    source,
  )
    ? "neutral"
    : "invalid";
}

function helperReturnsConfigDerivedServiceTierValue(
  fnName,
  currentScope,
  source,
  scopesByNode,
  seen = new Set(),
) {
  if (!fnName || seen.has(fnName)) return false;
  const fnRecord = resolveVisibleFunctionRecord(fnName, currentScope);
  if (!fnRecord) return false;

  const { fnNode, scope } = fnRecord;
  const helperSource = source.slice(fnNode.start, fnNode.end);
  if (
    !helperSource.includes("read-config-for-host") ||
    !helperSource.includes("service_tier")
  ) {
    return false;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(fnName);
  const bindings = collectBindings(fnNode, scopesByNode);
  const returnExpressions = getFunctionReturnExpressions(fnNode);
  if (returnExpressions.length === 0) return false;

  const configTierObjectNames = collectConfigTierObjectNames(
    fnNode,
    scope,
    scopesByNode,
    source,
  );
  if (configTierObjectNames.size === 0) return false;
  const serviceTierStateNames = collectServiceTierStateNames(fnNode);
  const nativeNormalizerCallees =
    collectConfigDerivedServiceTierNormalizerCallees(
      returnExpressions,
      configTierObjectNames,
      bindings,
      scope,
      scopesByNode,
      source,
    );
  if (nativeNormalizerCallees.size === 0) return false;
  let hasNativeReturn = false;
  for (const expression of returnExpressions) {
    const expressionScope = scopesByNode?.get(expression) ?? scope;
    const classification = classifyConfigDerivedServiceTierReturn(
      expression,
      bindings,
      expressionScope,
      scopesByNode,
      nativeNormalizerCallees,
      configTierObjectNames,
      serviceTierStateNames,
      source,
      new Set(nextSeen),
    );
    if (classification === "invalid") return false;
    if (classification === "native") hasNativeReturn = true;
  }

  return hasNativeReturn;
}

function isTrustedRequestCallee(callee, currentScope, source) {
  const calleeName = getIdentifierName(callee);
  if (!calleeName) return false;
  const visibleBinding = resolveVisibleBindingInfo(calleeName, currentScope);
  if (TRUSTED_REQUEST_CALLS.has(calleeName) && !visibleBinding) return true;
  const text = functionSourceForName(calleeName, currentScope, source);
  return (
    text.includes("electronBridge") ||
    text.includes("dispatchMessage") ||
    text.includes("ipcRenderer") ||
    text.includes(".invoke(")
  );
}

function getRequestTierProperty(call, currentScope, source) {
  const unwrapped = unwrapChain(call);
  if (unwrapped?.type !== "CallExpression") return null;

  const callee = unwrapChain(unwrapped.callee);
  if (!isTrustedRequestCallee(callee, currentScope, source)) return null;

  const [action, payload] = unwrapped.arguments;
  if (isStringLiteral(action, "start-conversation")) {
    const serviceTierProperty = findProperty(payload, "serviceTier");
    if (!serviceTierProperty) return null;
    return {
      action: "start-conversation",
      property: serviceTierProperty,
    };
  }

  if (!isStringLiteral(action, "start-turn-for-host")) return null;
  const paramsProperty = findProperty(payload, "params");
  const serviceTierProperty = paramsProperty
    ? findProperty(paramsProperty.value, "serviceTier")
    : null;
  if (!serviceTierProperty) return null;
  return {
    action: "start-turn-for-host",
    property: serviceTierProperty,
  };
}

function collectFastGatePatches(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const { scopesByNode } = collectFunctionMap(ast);
  const patches = [];

  walkAst(ast, (node) => {
    const isFunction =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFunction) return;

    const text = source.slice(node.start, node.end);
    if (!text.includes("fast_mode") || !text.includes("chatgpt")) return;
    const authBindings = collectAuthMethodBindings(node, scopesByNode);

    walkNode(node, (child) => {
      if (child.type !== "BinaryExpression") return;
      if (child.operator !== "===" && child.operator !== "!==") return;
      const leftIsChatGpt = isStringLiteral(child.left, "chatgpt");
      const rightIsChatGpt = isStringLiteral(child.right, "chatgpt");
      if (!leftIsChatGpt && !rightIsChatGpt) return;

      const authSide = leftIsChatGpt ? child.right : child.left;
      const authScope = scopesByNode.get(authSide) ?? scopesByNode.get(child);
      if (
        !isAuthMethodReferenceInScope(
          authSide,
          authScope,
          scopesByNode,
          authBindings,
        )
      ) {
        return;
      }

      patches.push({
        id: "fast_mode_auth_gate",
        start: child.start,
        end: child.end,
        replacement: child.operator === "===" ? "!0" : "!1",
      });
    }, { skipNestedFunctions: true });
  });

  return patches;
}

function collectFastRequestPatches(source, options = {}) {
  void options;
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const { scopesByNode } = collectFunctionMap(ast);
  const patches = [];

  walkAst(ast, (node) => {
    const isFunction =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFunction) return;

    const bindings = collectBindings(node, scopesByNode);

    walkNode(node, (child) => {
      const requestTier = getRequestTierProperty(child, scopesByNode.get(child), source);
      if (!requestTier) return;

      const value = requestTier.property.value;
      if (value.type !== "ConditionalExpression") return;

      const testSource = source.slice(value.test.start, value.test.end);
      const consequent = source.slice(value.consequent.start, value.consequent.end);
      const alternate = source.slice(value.alternate.start, value.alternate.end);
      const sendsStandardForBothBranches =
        /["'`]standard["'`]/.test(consequent) &&
        /["'`]standard["'`]/.test(alternate);
      const alreadySendsFast =
        /["'`]fast["'`]/.test(consequent) || /["'`]fast["'`]/.test(alternate);

      if (
        isUiFastSelectorTest(
          value.test,
          bindings,
          getNodeScope(value.test, scopesByNode.get(node), scopesByNode),
          scopesByNode,
        ) &&
        sendsStandardForBothBranches &&
        !alreadySendsFast
      ) {
        const branchValues = getFastStandardPatchBranchValues(value.test);
        if (!branchValues) return;
        patches.push({
          id: "fast_mode_request_tier",
          start: value.start,
          end: value.end,
          replacement: `${testSource}?"${branchValues.consequent}":"${branchValues.alternate}"`,
        });
      }
    }, { skipNestedFunctions: true });
  });

  return patches;
}

function collectFastRequestEvidence(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const { scopesByNode } = collectFunctionMap(ast);
  const evidence = [];

  walkAst(ast, (node) => {
    const isFunction =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFunction) return;

    const bindings = collectBindings(node, scopesByNode);

    walkNode(node, (child) => {
      const requestTier = getRequestTierProperty(child, scopesByNode.get(child), source);
      if (!requestTier) return;

      const serviceTierProperty = requestTier.property;
      const valueScope = getNodeScope(
        serviceTierProperty.value,
        scopesByNode.get(node),
        scopesByNode,
      );
      const hasConditionalTier = isFastStandardChoice(
        serviceTierProperty.value,
        bindings,
        valueScope,
        scopesByNode,
      );
      const hasNativeTierChain = isNativeServiceTierChain(
        serviceTierProperty.value,
        bindings,
        source,
        valueScope,
        scopesByNode,
      );
      if (!hasConditionalTier && !hasNativeTierChain) return;

      evidence.push({
        id: hasConditionalTier
          ? "fast_mode_request_tier_native"
          : requestTier.action === "start-conversation"
            ? "fast_mode_request_service_tier_chain"
            : "fast_mode_request_service_tier_handoff",
        start: serviceTierProperty.start,
        end: serviceTierProperty.end,
      });
    }, { skipNestedFunctions: true });
  });

  return evidence;
}

function patchFiles(files, collector, label, check) {
  let total = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const patches = collector(source);
    if (!patches.length) continue;

    console.log(`[${label}] ${file}: ${patches.length}`);
    total += patches.length;
    if (!check) {
      fs.writeFileSync(file, applyTextPatches(source, patches));
    }
  }

  return total;
}

function scanFastRequestFiles(files, check) {
  let patched = 0;
  let nativeEvidence = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const patches = collectFastRequestPatches(source);
    const evidence = collectFastRequestEvidence(source);

    if (patches.length || evidence.length) {
      console.log(
        `[fast-request] ${file}: patches=${patches.length}, nativeEvidence=${evidence.length}`,
      );
    }

    patched += patches.length;
    nativeEvidence += evidence.length;

    if (!check && patches.length) {
      fs.writeFileSync(file, applyTextPatches(source, patches));
    }
  }

  return { patched, nativeEvidence };
}

function readUpstreamMetadata() {
  return JSON.parse(
    fs.readFileSync(path.join(SRC_DIR, PLATFORM, "upstream-metadata.json"), "utf8"),
  );
}

function logFastTierAttestation(attestation) {
  if (!attestation.required) {
    console.log("[fast-attestation] unknown upstream identity; using legacy analysis");
    return;
  }
  console.log(
    `[fast-attestation] provenance=${attestation.provenance ?? "reviewed-hash"} upstream=${attestation.manifest.upstreamVersion}/${attestation.manifest.upstreamBuild} appAsarSha256=${attestation.actualAsarSha256}`,
  );
  for (const [role, record] of attestation.roles) {
    console.log(
      `[fast-attestation] role=${role} path=${record.module.path} audit=${record.module.sha256} asar=${record.originalSha256} work=${record.workSha256}`,
    );
  }
  for (const evidence of attestation.evidence) {
    console.log(
      `[fast-attestation] action=${evidence.action} file=${evidence.file} resolver=${evidence.resolverExport}->${evidence.resolverImport} start=${evidence.start}`,
    );
  }
}

function runFastModePatch({
  check = false,
  assetBundles = locateAsarAssetBundles(),
  buildBundles = locateAsarBuildBundles(),
  metadata = readUpstreamMetadata(),
  manifests,
  projectRoot = PROJECT_ROOT,
  workRoot,
} = {}) {
  const resolvedWorkRoot =
    workRoot ??
    (path.resolve(projectRoot) === PROJECT_ROOT
      ? resolveAsarRoot()
      : path.join(path.resolve(projectRoot), "src", PLATFORM, "_asar"));
  const attestationOptions = { metadata, projectRoot, workRoot: resolvedWorkRoot };
  if (manifests !== undefined) {
    attestationOptions.manifests = manifests;
  }
  attestationOptions.candidateFiles = assetBundles;
  const attestation = verifyFastTierIntegrity(attestationOptions);
  logFastTierAttestation(attestation);

  const gateTotal = patchFiles(
    assetBundles,
    collectFastGatePatches,
    "fast-gate",
    check,
  );
  const request = scanFastRequestFiles(
    [...assetBundles, ...buildBundles],
    check,
  );

  if (gateTotal === 0) {
    throw new Error("No Fast mode auth gate patch target found");
  }

  if (attestation.required) {
    if (request.patched !== 0) {
      throw new Error("Attested Fast tier request implementation must not be text-patched");
    }
    const actions = new Set(attestation.evidence.map((item) => item.action));
    if (!actions.has("start-conversation") || !actions.has("start-turn-for-host")) {
      throw new Error("Attested Fast tier evidence must cover conversation and turn requests");
    }
  } else if (request.patched === 0 && request.nativeEvidence === 0) {
    throw new Error(
      "No Fast mode request tier patch target or native fast/standard evidence found",
    );
  }
  return { gateTotal, request, attestation };
}

function run({ check = false } = {}) {
  return runFastModePatch({ check });
}

if (require.main === module) {
  run({ check: process.argv.includes("--check") });
}

module.exports = {
  collectFastGatePatches,
  collectFastRequestPatches,
  collectFastRequestEvidence,
  runFastModePatch,
  verifyFastTierAttestation,
  verifyFastTierIntegrity,
  run,
};
