#!/usr/bin/env node

const fs = require("node:fs");
const acorn = require("acorn");
const {
  walkAst,
  applyTextPatches,
  locateAsarBuildBundles,
} = require("./patch-util");

const OLD_COPYRIGHT = "© OpenAI";
const NEW_COPYRIGHT = "© OpenAI · itstarts Rebuild";
const ABOUT_HTML_MARKERS = [
  '<main class="dialog"',
  'aria-labelledby="app-name"',
  'class="app-name"',
  'class="build-info"',
];
const ABOUT_HTML_COPYRIGHT_RE =
  /(<div\s+class=(["'])copyright\2\s*>\s*)(© OpenAI(?: · itstarts Rebuild)?)(\s*<\/div>)/g;

function propertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

function isSetAboutPanelOptionsCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    propertyName(node.callee.property) === "setAboutPanelOptions"
  );
}

function isStringValue(node, expected) {
  return (
    (node?.type === "Literal" && node.value === expected) ||
    (node?.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis[0]?.value?.cooked === expected)
  );
}

function createReplacement(value) {
  return value.type === "TemplateLiteral"
    ? `\`${NEW_COPYRIGHT}\``
    : JSON.stringify(NEW_COPYRIGHT);
}

function isAboutHtmlTemplate(node) {
  if (node?.type !== "TemplateLiteral") {
    return false;
  }
  const raw = node.quasis.map((quasi) => quasi.value.raw).join("");
  return ABOUT_HTML_MARKERS.every((marker) => raw.includes(marker));
}

function collectAboutHtmlTemplateEntries(node) {
  if (!isAboutHtmlTemplate(node)) {
    return [];
  }
  const entries = [];
  for (const quasi of node.quasis) {
    const raw = quasi.value.raw;
    for (const match of raw.matchAll(ABOUT_HTML_COPYRIGHT_RE)) {
      const copyrightStart = quasi.start + match.index + match[1].length;
      const copyright = match[3];
      entries.push({
        start: copyrightStart,
        end: copyrightStart + copyright.length,
        replacement: NEW_COPYRIGHT,
        isOld: copyright === OLD_COPYRIGHT,
        isPatched: copyright === NEW_COPYRIGHT,
      });
    }
  }
  return entries;
}

function collectAboutCopyrightEntries(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const entries = [];

  walkAst(ast, (node) => {
    entries.push(...collectAboutHtmlTemplateEntries(node));

    if (!isSetAboutPanelOptionsCall(node)) {
      return;
    }
    const options = node.arguments[0];
    if (options?.type !== "ObjectExpression") {
      return;
    }
    for (const property of options.properties) {
      if (
        property?.type !== "Property" ||
        property.kind !== "init" ||
        propertyName(property.key) !== "copyright"
      ) {
        continue;
      }
      entries.push({
        property,
        value: property.value,
        start: property.value.start,
        end: property.value.end,
        replacement: createReplacement(property.value),
        isOld: isStringValue(property.value, OLD_COPYRIGHT),
        isPatched: isStringValue(property.value, NEW_COPYRIGHT),
      });
    }
  });

  return entries;
}

function collectCopyrightPatches(source) {
  const patches = [];
  for (const entry of collectAboutCopyrightEntries(source)) {
    if (entry.isOld) {
      patches.push({
        id: "about_copyright",
        start: entry.start,
        end: entry.end,
        replacement: entry.replacement,
      });
    }
  }
  return patches;
}

function hasPatchedAboutCopyright(source) {
  return collectAboutCopyrightEntries(source).some((entry) => entry.isPatched);
}

function run({ check = false, files = locateAsarBuildBundles() } = {}) {
  let total = 0;
  if (files.length === 0) {
    throw new Error("No ASAR main build bundles found for About patch");
  }

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const patches = collectCopyrightPatches(source);
    if (patches.length === 0 && !hasPatchedAboutCopyright(source)) {
      throw new Error(`No copyright patch target found in ${file}`);
    }

    total += patches.length;
    console.log(`[copyright] ${file}: ${patches.length}`);
    if (!check && patches.length > 0) {
      fs.writeFileSync(file, applyTextPatches(source, patches));
    }
  }

  if (total === 0) {
    console.log("[copyright] already patched");
  }
}

if (require.main === module) {
  run({ check: process.argv.includes("--check") });
}

module.exports = {
  collectCopyrightPatches,
  hasPatchedAboutCopyright,
  run,
};
