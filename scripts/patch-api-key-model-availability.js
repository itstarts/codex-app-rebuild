#!/usr/bin/env node

const fs = require("node:fs");
const acorn = require("acorn");
const {
  walkAst,
  applyTextPatches,
  locateAsarAssetBundles,
} = require("./patch-util");

const PATCH_ID = "api_key_model_availability";
const REQUIRED_BINDINGS = [
  "authMethod",
  "availableModels",
  "models",
  "useHiddenModels",
];
const SOURCE_NEEDLES = [
  ...REQUIRED_BINDINGS,
  "amazonBedrock",
  "forEach",
  "has",
  "hidden",
  "model",
  "supportedReasoningEfforts",
];

function parse(source) {
  return acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function isFunctionNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function stringLiteralValue(node) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type === "Literal" && typeof unwrapped.value === "string") {
    return unwrapped.value;
  }
  if (
    unwrapped?.type === "TemplateLiteral" &&
    unwrapped.expressions.length === 0
  ) {
    return unwrapped.quasis[0]?.value?.cooked;
  }
  return undefined;
}

function staticPropertyName(node, computed = false) {
  const unwrapped = unwrapChain(node);
  if (!computed && unwrapped?.type === "Identifier") {
    return unwrapped.name;
  }
  return stringLiteralValue(unwrapped) ?? "";
}

function memberName(node) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "MemberExpression") return "";
  return staticPropertyName(unwrapped.property, unwrapped.computed);
}

function collectPatternIdentifiers(pattern, identifiers = []) {
  if (!pattern || typeof pattern !== "object") return identifiers;
  if (pattern.type === "Identifier") {
    identifiers.push(pattern.name);
  } else if (pattern.type === "RestElement") {
    collectPatternIdentifiers(pattern.argument, identifiers);
  } else if (pattern.type === "AssignmentPattern") {
    collectPatternIdentifiers(pattern.left, identifiers);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      collectPatternIdentifiers(element, identifiers);
    }
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      collectPatternIdentifiers(
        property.type === "RestElement" ? property.argument : property.value,
        identifiers,
      );
    }
  }
  return identifiers;
}

function patternBindsName(pattern, name) {
  return collectPatternIdentifiers(pattern).includes(name);
}

function boundIdentifier(pattern) {
  if (pattern?.type === "Identifier") return pattern.name;
  if (pattern?.type === "AssignmentPattern") {
    return boundIdentifier(pattern.left);
  }
  return null;
}

function objectPatternFromParameter(parameter) {
  if (parameter?.type === "ObjectPattern") return parameter;
  if (parameter?.type === "AssignmentPattern") {
    return objectPatternFromParameter(parameter.left);
  }
  return null;
}

function extractParameterBindings(functionNode) {
  const pattern = objectPatternFromParameter(functionNode.params[0]);
  if (!pattern) return null;

  const bindings = new Map();
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const key = staticPropertyName(property.key, property.computed);
    const identifier = boundIdentifier(property.value);
    if (key && identifier) bindings.set(key, identifier);
  }
  return bindings;
}

function walkOwnFunction(functionNode, visitor) {
  function visit(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node !== functionNode && isFunctionNode(node)) return;
    if (node.type) visitor(node, parent);

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node);
      } else if (value && typeof value === "object") {
        visit(value, node);
      }
    }
  }

  visit(functionNode);
}

function buildParentMap(root) {
  const parentMap = new WeakMap();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (!child || typeof child !== "object") continue;
        parentMap.set(child, node);
        visit(child);
      }
    }
  }

  visit(root);
  return parentMap;
}

function declarationBindsName(declaration, name) {
  return declaration?.type === "VariableDeclarator" &&
    patternBindsName(declaration.id, name);
}

function blockHasLexicalBinding(block, name, allowedDeclaration) {
  for (const statement of block.body ?? []) {
    if (
      statement.type === "VariableDeclaration" &&
      statement.kind !== "var"
    ) {
      if (
        statement.declarations.some(
          (declaration) =>
            declaration !== allowedDeclaration &&
            declarationBindsName(declaration, name),
        )
      ) {
        return true;
      }
    }
    if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration") &&
      statement.id?.name === name
    ) {
      return true;
    }
  }
  return false;
}

function switchHasLexicalBinding(switchNode, name, allowedDeclaration) {
  return switchNode.cases.some((switchCase) =>
    blockHasLexicalBinding(
      { body: switchCase.consequent },
      name,
      allowedDeclaration,
    ),
  );
}

function loopHasLexicalBinding(node, name) {
  const declaration =
    node.type === "ForStatement" ? node.init : node.left;
  return (
    declaration?.type === "VariableDeclaration" &&
    declaration.kind !== "var" &&
    declaration.declarations.some((item) => declarationBindsName(item, name))
  );
}

function functionHasVarBinding(functionNode, name) {
  let found = false;

  function visit(node) {
    if (!node || typeof node !== "object" || found) return;
    if (node !== functionNode.body && isFunctionNode(node)) return;
    if (
      node.type === "VariableDeclaration" &&
      node.kind === "var" &&
      node.declarations.some((item) => declarationBindsName(item, name))
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }

  visit(functionNode.body);
  return found;
}

function isReferenceFromBinding(
  reference,
  {
    boundaryFunction,
    name,
    parentMap,
    allowedDeclaration = null,
  },
) {
  if (reference?.type !== "Identifier" || reference.name !== name) {
    return false;
  }

  let current = parentMap.get(reference);
  while (current && current !== boundaryFunction) {
    if (isFunctionNode(current)) {
      if (current.id?.name === name) return false;
      if (current.params.some((parameter) => patternBindsName(parameter, name))) {
        return false;
      }
      if (functionHasVarBinding(current, name)) return false;
    } else if (
      current.type === "BlockStatement" &&
      blockHasLexicalBinding(current, name, allowedDeclaration)
    ) {
      return false;
    } else if (
      current.type === "CatchClause" &&
      patternBindsName(current.param, name)
    ) {
      return false;
    } else if (
      (current.type === "ForStatement" ||
        current.type === "ForInStatement" ||
        current.type === "ForOfStatement") &&
      loopHasLexicalBinding(current, name)
    ) {
      return false;
    } else if (
      current.type === "SwitchStatement" &&
      switchHasLexicalBinding(current, name, allowedDeclaration)
    ) {
      return false;
    }
    current = parentMap.get(current);
  }

  if (current !== boundaryFunction) return false;
  if (allowedDeclaration) {
    return declarationBindsName(allowedDeclaration, name);
  }
  return boundaryFunction.params.some((parameter) =>
    patternBindsName(parameter, name),
  );
}

function flattenLogicalAnd(node, operands = []) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type === "LogicalExpression" && unwrapped.operator === "&&") {
    flattenLogicalAnd(unwrapped.left, operands);
    flattenLogicalAnd(unwrapped.right, operands);
  } else if (unwrapped) {
    operands.push(unwrapped);
  }
  return operands;
}

function authComparisonInfo(node, authMethodBinding) {
  const unwrapped = unwrapChain(node);
  if (unwrapped?.type !== "BinaryExpression" || unwrapped.operator !== "!==") {
    return null;
  }

  const left = unwrapChain(unwrapped.left);
  const right = unwrapChain(unwrapped.right);
  if (left?.type === "Identifier" && left.name === authMethodBinding) {
    const value = stringLiteralValue(right);
    return value === undefined ? null : { node: unwrapped, identifier: left, value };
  }
  if (right?.type === "Identifier" && right.name === authMethodBinding) {
    const value = stringLiteralValue(left);
    return value === undefined ? null : { node: unwrapped, identifier: right, value };
  }
  return null;
}

function topLevelVariableDeclarators(functionNode, name) {
  if (functionNode.body?.type !== "BlockStatement") return [];
  return functionNode.body.body.flatMap((statement) => {
    if (statement.type !== "VariableDeclaration") return [];
    return statement.declarations.filter(
      (declaration) =>
        declaration.id.type === "Identifier" &&
        declaration.id.name === name,
    );
  });
}

function itemMemberIdentifier(node, itemBinding, property) {
  const member = unwrapChain(node);
  const object = unwrapChain(member?.object);
  if (
    member?.type !== "MemberExpression" ||
    memberName(member) !== property ||
    object?.type !== "Identifier" ||
    object.name !== itemBinding
  ) {
    return null;
  }
  return object;
}

function callbackUsesReasoningMetadata(
  callback,
  itemBinding,
  parentMap,
) {
  let found = false;
  walkOwnFunction(callback, (node) => {
    const item = itemMemberIdentifier(
      node,
      itemBinding,
      "supportedReasoningEfforts",
    );
    if (
      item &&
      isReferenceFromBinding(item, {
        boundaryFunction: callback,
        name: itemBinding,
        parentMap,
      })
    ) {
      found = true;
    }
  });
  return found;
}

function matchModelFilterConditional(
  conditional,
  {
    callback,
    outerFunction,
    availableModelsBinding,
    itemBinding,
    parentMap,
  },
) {
  const parent = parentMap.get(conditional);
  if (parent?.type !== "IfStatement" || parent.test !== conditional) {
    return null;
  }

  const test = unwrapChain(conditional.test);
  const consequent = unwrapChain(conditional.consequent);
  const alternate = unwrapChain(conditional.alternate);
  if (
    test?.type !== "Identifier" ||
    consequent?.type !== "CallExpression" ||
    alternate?.type !== "UnaryExpression" ||
    alternate.operator !== "!"
  ) {
    return null;
  }

  const hasMember = unwrapChain(consequent.callee);
  const availableModels = unwrapChain(hasMember?.object);
  if (
    hasMember?.type !== "MemberExpression" ||
    memberName(hasMember) !== "has" ||
    availableModels?.type !== "Identifier" ||
    availableModels.name !== availableModelsBinding ||
    consequent.arguments.length !== 1
  ) {
    return null;
  }

  const modelItem = itemMemberIdentifier(
    consequent.arguments[0],
    itemBinding,
    "model",
  );
  const hiddenItem = itemMemberIdentifier(
    alternate.argument,
    itemBinding,
    "hidden",
  );
  if (!modelItem || !hiddenItem) return null;

  const availableModelsIsOuterBinding = isReferenceFromBinding(
    availableModels,
    {
      boundaryFunction: outerFunction,
      name: availableModelsBinding,
      parentMap,
    },
  );
  const modelItemIsCallbackBinding = isReferenceFromBinding(modelItem, {
    boundaryFunction: callback,
    name: itemBinding,
    parentMap,
  });
  const hiddenItemIsCallbackBinding = isReferenceFromBinding(hiddenItem, {
    boundaryFunction: callback,
    name: itemBinding,
    parentMap,
  });
  if (
    !availableModelsIsOuterBinding ||
    !modelItemIsCallbackBinding ||
    !hiddenItemIsCallbackBinding
  ) {
    return null;
  }

  return { gateReference: test, gateBinding: test.name };
}

function analyzeGate(
  gateDeclaration,
  {
    outerFunction,
    authMethodBinding,
    useHiddenModelsBinding,
    parentMap,
    source,
  },
) {
  if (!gateDeclaration.init) return { status: "invalid" };
  const operands = flattenLogicalAnd(gateDeclaration.init);
  const useHiddenModels = operands.filter(
    (operand) =>
      operand.type === "Identifier" &&
      operand.name === useHiddenModelsBinding &&
      isReferenceFromBinding(operand, {
        boundaryFunction: outerFunction,
        name: useHiddenModelsBinding,
        parentMap,
      }),
  );
  const comparisons = operands
    .map((operand) => authComparisonInfo(operand, authMethodBinding))
    .filter(Boolean)
    .filter((comparison) =>
      isReferenceFromBinding(comparison.identifier, {
        boundaryFunction: outerFunction,
        name: authMethodBinding,
        parentMap,
      }),
    );
  const amazonComparisons = comparisons.filter(
    (comparison) => comparison.value === "amazonBedrock",
  );
  const apiKeyComparisons = comparisons.filter(
    (comparison) => comparison.value === "apikey",
  );
  const recognizedNodes = new Set([
    ...useHiddenModels,
    ...amazonComparisons.map((comparison) => comparison.node),
    ...apiKeyComparisons.map((comparison) => comparison.node),
  ]);

  if (
    useHiddenModels.length !== 1 ||
    amazonComparisons.length !== 1 ||
    apiKeyComparisons.length > 1 ||
    recognizedNodes.size !== operands.length
  ) {
    return { status: "invalid" };
  }
  if (apiKeyComparisons.length === 1) {
    return { status: "evidence" };
  }

  const comparison = amazonComparisons[0].node;
  return {
    status: "patch",
    patch: {
      id: PATCH_ID,
      start: comparison.start,
      end: comparison.end,
      replacement:
        `${source.slice(comparison.start, comparison.end)}` +
        `&&${authMethodBinding}!==\`apikey\``,
    },
  };
}

function analyzeApiKeyModelAvailability(source) {
  const analysis = {
    patches: [],
    targetCount: 0,
    evidenceCount: 0,
    invalidCount: 0,
  };

  if (!SOURCE_NEEDLES.every((needle) => source.includes(needle))) {
    return analysis;
  }

  const ast = parse(source);
  const parentMap = buildParentMap(ast);
  walkAst(ast, (functionNode) => {
    if (!isFunctionNode(functionNode)) return;
    const bindings = extractParameterBindings(functionNode);
    if (!bindings) return;
    if (!REQUIRED_BINDINGS.every((name) => bindings.has(name))) return;
    if (
      new Set(REQUIRED_BINDINGS.map((name) => bindings.get(name))).size !==
      REQUIRED_BINDINGS.length
    ) {
      return;
    }

    const authMethodBinding = bindings.get("authMethod");
    const availableModelsBinding = bindings.get("availableModels");
    const modelsBinding = bindings.get("models");
    const useHiddenModelsBinding = bindings.get("useHiddenModels");

    walkOwnFunction(functionNode, (node) => {
      const unwrapped = unwrapChain(node);
      if (
        unwrapped?.type !== "CallExpression" ||
        unwrapped.arguments.length !== 1 ||
        !isFunctionNode(unwrapped.arguments[0])
      ) {
        return;
      }

      const callee = unwrapChain(unwrapped.callee);
      const models = unwrapChain(callee?.object);
      if (
        callee?.type !== "MemberExpression" ||
        memberName(callee) !== "forEach" ||
        models?.type !== "Identifier" ||
        models.name !== modelsBinding ||
        !isReferenceFromBinding(models, {
          boundaryFunction: functionNode,
          name: modelsBinding,
          parentMap,
        })
      ) {
        return;
      }

      const callback = unwrapped.arguments[0];
      if (
        callback.params.length !== 1 ||
        callback.params[0].type !== "Identifier"
      ) {
        return;
      }
      const itemBinding = callback.params[0].name;
      if (
        !callbackUsesReasoningMetadata(
          callback,
          itemBinding,
          parentMap,
        )
      ) {
        return;
      }

      walkOwnFunction(callback, (callbackNode) => {
        if (callbackNode.type !== "ConditionalExpression") return;
        const modelFilter = matchModelFilterConditional(callbackNode, {
          callback,
          outerFunction: functionNode,
          availableModelsBinding,
          itemBinding,
          parentMap,
        });
        if (!modelFilter) return;

        analysis.targetCount += 1;
        const gateDeclarations = topLevelVariableDeclarators(
          functionNode,
          modelFilter.gateBinding,
        );
        if (gateDeclarations.length !== 1) {
          analysis.invalidCount += 1;
          return;
        }
        const gateDeclaration = gateDeclarations[0];
        if (
          !isReferenceFromBinding(modelFilter.gateReference, {
            boundaryFunction: functionNode,
            name: modelFilter.gateBinding,
            parentMap,
            allowedDeclaration: gateDeclaration,
          })
        ) {
          analysis.invalidCount += 1;
          return;
        }

        const gate = analyzeGate(gateDeclaration, {
          outerFunction: functionNode,
          authMethodBinding,
          useHiddenModelsBinding,
          parentMap,
          source,
        });
        if (gate.status === "patch") {
          analysis.patches.push(gate.patch);
        } else if (gate.status === "evidence") {
          analysis.evidenceCount += 1;
        } else {
          analysis.invalidCount += 1;
        }
      });
    });
  });

  return analysis;
}

function collectApiKeyModelAvailabilityPatches(source) {
  return analyzeApiKeyModelAvailability(source).patches;
}

function hasPatchedApiKeyModelAvailability(source) {
  return analyzeApiKeyModelAvailability(source).evidenceCount > 0;
}

function inspectApiKeyModelAvailabilityTargets({
  files = locateAsarAssetBundles(),
} = {}) {
  const summary = {
    files: [],
    targetCount: 0,
    patchCount: 0,
    evidenceCount: 0,
    invalidCount: 0,
  };

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const analysis = analyzeApiKeyModelAvailability(source);
    const fileResult = {
      file,
      patches: analysis.patches,
      targetCount: analysis.targetCount,
      evidenceCount: analysis.evidenceCount,
      invalidCount: analysis.invalidCount,
    };
    summary.files.push(fileResult);
    summary.targetCount += analysis.targetCount;
    summary.patchCount += analysis.patches.length;
    summary.evidenceCount += analysis.evidenceCount;
    summary.invalidCount += analysis.invalidCount;
  }

  return summary;
}

function run({ check = false, files = locateAsarAssetBundles() } = {}) {
  const summary = inspectApiKeyModelAvailabilityTargets({ files });
  if (summary.invalidCount > 0) {
    throw new Error(
      `API key model availability patch failed: found ${summary.invalidCount} ambiguous model availability target(s)`,
    );
  }
  if (summary.targetCount !== 1) {
    throw new Error(
      `API key model availability patch failed: expected exactly 1 model availability target, found ${summary.targetCount}`,
    );
  }
  if (summary.patchCount + summary.evidenceCount !== 1) {
    throw new Error(
      "API key model availability patch failed: target has neither one patch nor one evidence match",
    );
  }

  for (const fileResult of summary.files) {
    if (fileResult.targetCount === 0) continue;
    console.log(
      `[api-key-model-availability] ${fileResult.file}: ` +
        `targets=${fileResult.targetCount} patches=${fileResult.patches.length} ` +
        `evidence=${fileResult.evidenceCount}`,
    );
    if (!check && fileResult.patches.length > 0) {
      const source = fs.readFileSync(fileResult.file, "utf8");
      fs.writeFileSync(
        fileResult.file,
        applyTextPatches(source, fileResult.patches),
      );
    }
  }

  console.log(
    `[api-key-model-availability] ${PATCH_ID}: ` +
      `targets=${summary.targetCount} patches=${summary.patchCount} ` +
      `evidence=${summary.evidenceCount}`,
  );
  return summary;
}

if (require.main === module) {
  run({ check: process.argv.includes("--check") });
}

module.exports = {
  collectApiKeyModelAvailabilityPatches,
  hasPatchedApiKeyModelAvailability,
  inspectApiKeyModelAvailabilityTargets,
  run,
};
