const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { packAsar } = require("../scripts/lib/asar-utils");
const {
  verifyAsarIntegrity,
  verifyBundleExecutable,
  verifyBuildNumberCases,
  verifyRequestEvidence,
  REVIEWED_UPDATER_CALL_CHAINS,
  verifyUpdaterNotDisabled: verifyUpdaterNotDisabledRaw,
  verifyUpdaterNotDisabledWithReviewedCallChains,
} = require("../scripts/verify-build");

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function createEvidenceDir({ fast = { service_tier: "fast" }, standard = { service_tier: "standard" } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-evidence-"));
  if (fast !== undefined) {
    writeJson(path.join(dir, "fast-request.json"), fast);
  }
  if (standard !== undefined) {
    writeJson(path.join(dir, "standard-request.json"), standard);
  }
  return dir;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writePlist(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.entries(values)
    .map(([key, value]) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`)
    .join("\n");
  fs.writeFileSync(
    file,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      entries,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createAsarIntegrityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-asar-integrity-"));
  const app = path.join(root, "Codex-rebuild.app");
  const plist = path.join(app, "Contents", "Info.plist");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  const header = Buffer.from("header-json", "utf8");
  const bytes = Buffer.alloc(16 + header.length);
  bytes.writeUInt32LE(header.length, 12);
  header.copy(bytes, 16);
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, bytes);
  writePlist(plist, {});
  const insert = spawnSync(
    "plutil",
    [
      "-insert",
      "ElectronAsarIntegrity",
      "-xml",
      `<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${sha256(header)}</string></dict></dict>`,
      plist,
    ],
    { encoding: "utf8" },
  );
  assert.equal(insert.status, 0, insert.stderr || insert.stdout);
  return { app, plist };
}

function createBundleExecutableFixture({ executable = "file", mode = 0o755 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-bundle-executable-"));
  const app = path.join(root, "Codex-rebuild.app");
  const executablePath = path.join(app, "Contents", "MacOS", "ChatGPT");
  writePlist(path.join(app, "Contents", "Info.plist"), {
    CFBundleExecutable: "ChatGPT",
  });
  if (executable === "file") {
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "fixture");
    fs.chmodSync(executablePath, mode);
  } else if (executable === "directory") {
    fs.mkdirSync(executablePath, { recursive: true });
  }
  return app;
}

const REQUIRED_UPDATER_FLAVORS = ["Nightly", "InternalAlpha", "PublicBeta", "Prod"];
const reviewedFixtureConsumers = new Map();

function updaterDefinitionSource({
  bindingName = "t",
  exportKey = "As",
  flavors = REQUIRED_UPDATER_FLAVORS,
  requireStatement = `const ${bindingName}=require(\`./src-build-flavors.js\`);`,
  containerName = "h",
  commonJsExportKey = "a",
  exportStatement,
  getterBody = `return ${containerName};`,
  additionalExportStatements = [],
  extraStatements = [],
} = {}) {
  const flavorList = flavors.map((flavor) => `${bindingName}.${exportKey}.${flavor}`).join(",");
  const reviewedExport =
    exportStatement === undefined
      ? `Object.defineProperty(exports,${JSON.stringify(commonJsExportKey)},{enumerable:true,get:function(){${getterBody}}});`
      : exportStatement;
  return [
    requireStatement,
    `const l=[${flavorList}];`,
    "const d=e=>e.CODEX_SPARKLE_ENABLED==='false';",
    "const f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
    `const ${containerName}={...${bindingName}.${exportKey},shouldIncludeSparkle(e,t,n=process.env){return f(e,t,'darwin',n)},shouldIncludeWindowsUpdater(){return false},shouldIncludeUpdater(e,t,n=process.env){return ${containerName}.shouldIncludeSparkle(e,t,n)||${containerName}.shouldIncludeWindowsUpdater(e,t,n)}};`,
    reviewedExport,
    ...additionalExportStatements,
    ...extraStatements,
  ].join("\n");
}

function updaterConsumerSource({
  definitionName = "file-based-logger-fixture.js",
  localName = "i",
  commonJsExportKey = "a",
  methods = ["shouldIncludeSparkle", "shouldIncludeUpdater"],
  requireStatement = `const ${localName}=require(\`./${definitionName}\`);`,
  beforeCalls = [],
} = {}) {
  const calls = methods.map(
    (method) => `${localName}.${commonJsExportKey}.${method}('prod','darwin',process.env);`,
  );
  return [requireStatement, ...beforeCalls, `function boot(){${calls.join("")}}`].join("\n");
}

function buildFlavorModuleSource({
  exportKeys = ["As", "qs"],
  prod = "prod",
} = {}) {
  const exports = exportKeys.map(
    (key) =>
      `Object.defineProperty(exports,${JSON.stringify(key)},{get:function(){return namespace}});`,
  );
  return [
    `const base={Dev:\`dev\`,Agent:\`agent\`,Nightly:\`nightly\`,InternalAlpha:\`internal-alpha\`,PublicBeta:\`public-beta\`,Prod:${JSON.stringify(prod)}};`,
    "const namespace={...base,values:Object.values(base)};",
    ...exports,
  ].join("\n");
}

async function createUpdaterFixture(
  t,
  {
    definitionName = "file-based-logger-fixture.js",
    definitionSource = updaterDefinitionSource(),
    buildFlavorSource = buildFlavorModuleSource(),
    consumerSource,
    extraFiles = {},
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-updater-"));
  t.after(() => {
    reviewedFixtureConsumers.delete(asarPath);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = path.join(root, "Codex-rebuild.app");
  const asarSource = path.join(root, "asar");
  const buildDir = path.join(asarSource, ".vite", "build");
  const asarPath = path.join(root, "app.asar");
  fs.mkdirSync(path.join(app, "Contents", "Frameworks", "Sparkle.framework"), {
    recursive: true,
  });
  fs.mkdirSync(buildDir, { recursive: true });
  if (buildFlavorSource !== null) {
    fs.writeFileSync(path.join(buildDir, "src-build-flavors.js"), buildFlavorSource, "utf8");
  }
  const resolvedConsumerSource = consumerSource ?? updaterConsumerSource({ definitionName });
  fs.writeFileSync(path.join(buildDir, "main-consumer.js"), resolvedConsumerSource, "utf8");
  for (const [name, source] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(buildDir, name), source, "utf8");
  }
  fs.writeFileSync(path.join(buildDir, definitionName), definitionSource, "utf8");
  await packAsar(asarSource, asarPath);
  const reviewedCallChain = {
    definitionHash: sha256(definitionSource),
    buildFlavorHash: buildFlavorSource === null ? null : sha256(buildFlavorSource),
    consumerHash: sha256(resolvedConsumerSource),
  };
  reviewedFixtureConsumers.set(asarPath, reviewedCallChain);
  return { app, asarPath, consumerSource: resolvedConsumerSource };
}

function verifyUpdaterNotDisabled(app, asarPath) {
  return verifyUpdaterNotDisabledWithReviewedCallChains(
    app,
    asarPath,
    [reviewedFixtureConsumers.get(asarPath)],
  );
}

test("reviewed updater chains include upstream 26.707.31428 final patched tuple", () => {
  assert.ok(Array.isArray(REVIEWED_UPDATER_CALL_CHAINS));
  assert.deepEqual(
    REVIEWED_UPDATER_CALL_CHAINS.find(
      (entry) =>
        entry.consumerHash ===
        "68ae81f787fdf534d730f5ee85ad3645fe5ae56393f59e015f07f6d0fb5ece43",
    ),
    {
      definitionHash: "755ee00ba69271766dc8d6913fc7e51d1671717be5986fd7c531586f6c1cc1b5",
      buildFlavorHash: "7e6d33aab29002935149edd23a0ce1afa71f4ed829e02b267c16a2265fc90618",
      consumerHash: "68ae81f787fdf534d730f5ee85ad3645fe5ae56393f59e015f07f6d0fb5ece43",
    },
  );
});

test("reviewed updater chains include upstream 26.707.41301 final patched tuple", () => {
  assert.deepEqual(
    REVIEWED_UPDATER_CALL_CHAINS.find(
      (entry) =>
        entry.consumerHash ===
        "2147f521b3d267915faed26418e9ddc9f838f339d733f47d53a196dc7fedfc61",
    ),
    {
      definitionHash: "755ee00ba69271766dc8d6913fc7e51d1671717be5986fd7c531586f6c1cc1b5",
      buildFlavorHash: "7e6d33aab29002935149edd23a0ce1afa71f4ed829e02b267c16a2265fc90618",
      consumerHash: "2147f521b3d267915faed26418e9ddc9f838f339d733f47d53a196dc7fedfc61",
    },
  );
});

test("reviewed updater chains include upstream 26.707.61608 final patched tuple", () => {
  assert.deepEqual(
    REVIEWED_UPDATER_CALL_CHAINS.find(
      (entry) =>
        entry.consumerHash ===
        "213a47da33e8d275dae891d5d1e86955e5561a1858111c2f80d28055046f552b",
    ),
    {
      definitionHash: "bb7afbfd50c3a5809750a3890a5b9ea5fb6d5acdcd4e7c9110c51d0f125639e3",
      buildFlavorHash: "59ed239a7e2862572030c2fec8af9d1e456d8213a01d17c57072d89e08513d59",
      consumerHash: "213a47da33e8d275dae891d5d1e86955e5561a1858111c2f80d28055046f552b",
    },
  );
});

test("reviewed updater chains include upstream 26.707.71524 final patched tuple", () => {
  assert.deepEqual(
    REVIEWED_UPDATER_CALL_CHAINS.find(
      (entry) =>
        entry.consumerHash ===
        "23b6541ecda71e19473b28b7afb1794d936d5428b791634ad4d9727f111c40d1",
    ),
    {
      definitionHash: "7af97450ed4b3accc73cfb1bcc87fb666b9f8033d4ee68dc562648c54ee2cedd",
      buildFlavorHash: "5c436ced43c0b649de367fe9b60dd8a2ef6897551dfe2eb3c4012ba9a14e6df8",
      consumerHash: "23b6541ecda71e19473b28b7afb1794d936d5428b791634ad4d9727f111c40d1",
    },
  );
});

test("verifyRequestEvidence requires fast and standard captured tiers", () => {
  const dir = createEvidenceDir();

  assert.doesNotThrow(() => verifyRequestEvidence(dir));
});

test("verifyRequestEvidence fails when captured request files are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-evidence-missing-"));

  assert.throws(() => verifyRequestEvidence(dir), /fast-request\.json/);
});

test("verifyRequestEvidence accepts upstream standard equivalent tiers", () => {
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ standard: { service_tier: undefined } })),
  );
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ standard: { service_tier: null } })),
  );
});

test("verifyRequestEvidence accepts upstream fast equivalent tiers", () => {
  assert.doesNotThrow(() =>
    verifyRequestEvidence(createEvidenceDir({ fast: { service_tier: "priority" } })),
  );
});

test("verifyRequestEvidence fails when fast tier is not a fast equivalent", () => {
  const dir = createEvidenceDir({ fast: { service_tier: "standard" } });

  assert.throws(() => verifyRequestEvidence(dir), /fast-request\.json.*fast tier/);
});

test("verifyRequestEvidence fails when standard tier uses a fast equivalent", () => {
  const dir = createEvidenceDir({ standard: { service_tier: "priority" } });

  assert.throws(() => verifyRequestEvidence(dir), /standard-request\.json.*standard tier/);
});

test("verifyBuildNumberCases covers rebuild build number boundaries", () => {
  assert.doesNotThrow(() => verifyBuildNumberCases());
});

test("verifyAsarIntegrity reads Electron plist literal Resources/app.asar key", () => {
  const { app, plist } = createAsarIntegrityFixture();

  assert.doesNotThrow(() => verifyAsarIntegrity(app, plist));
});

test("verifyBundleExecutable accepts the executable recorded in upstream metadata", () => {
  const app = createBundleExecutableFixture();

  assert.doesNotThrow(() => verifyBundleExecutable(app, "ChatGPT"));
});

test("verifyBundleExecutable rejects missing expected executable metadata", () => {
  const app = createBundleExecutableFixture();

  assert.throws(
    () => verifyBundleExecutable(app),
    /expected bundle executable name is required/,
  );
});

test("verifyBundleExecutable rejects executable metadata mismatch", () => {
  const app = createBundleExecutableFixture();

  assert.throws(
    () => verifyBundleExecutable(app, "Codex"),
    /bundle executable mismatch: expected Codex, got ChatGPT/,
  );
});

test("verifyBundleExecutable rejects a missing executable", () => {
  const app = createBundleExecutableFixture({ executable: "missing" });

  assert.throws(
    () => verifyBundleExecutable(app, "ChatGPT"),
    /app bundle executable not found/,
  );
});

test("verifyBundleExecutable rejects an executable directory", () => {
  const app = createBundleExecutableFixture({ executable: "directory" });

  assert.throws(
    () => verifyBundleExecutable(app, "ChatGPT"),
    /app bundle executable not found/,
  );
});

test("verifyBundleExecutable rejects a non-executable file", () => {
  const app = createBundleExecutableFixture({ mode: 0o644 });

  assert.throws(() => verifyBundleExecutable(app, "ChatGPT"), /EACCES/);
});

test("verifyUpdaterNotDisabled accepts reviewed old and current build flavor exports", async (t) => {
  await t.test("old As export with string require", async (t) => {
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({
        exportKey: "As",
        requireStatement: "const t=require('./src-build-flavors.js');",
      }),
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });

  await t.test("current qs export with static template require", async (t) => {
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });
});

test("verifyUpdaterNotDisabled validates the required build flavor module export", async (t) => {
  const computedOverride = buildFlavorModuleSource({ exportKeys: ["qs"] }).replace(
    "const namespace={...base,values:Object.values(base)};",
    "const key='Prod';const namespace={...base,[key]:'dev',values:Object.values(base)};",
  );
  const asyncGetter = buildFlavorModuleSource({ exportKeys: ["qs"] }).replace(
    "get:function()",
    "get:async function()",
  );
  const conflictingGetter = buildFlavorModuleSource({ exportKeys: ["qs"] }).replace(
    "{get:function(){return namespace}}",
    "{get:function(){return namespace},set:function(){}}",
  );
  const mutatedBaseAlias = buildFlavorModuleSource({ exportKeys: ["qs"] }).replace(
    "const namespace={...base,values:Object.values(base)};",
    "const alias=base;alias.Prod='dev';const namespace={...base,values:Object.values(base)};",
  );
  const mutatedNamespaceAlias = buildFlavorModuleSource({ exportKeys: ["qs"] }).replace(
    "const namespace={...base,values:Object.values(base)};",
    "const namespace={...base,values:Object.values(base)};const alias=namespace;alias.Prod='dev';",
  );
  const shadowedObject = `const Object=globalThis.Object;${buildFlavorModuleSource({ exportKeys: ["qs"] })}`;
  const shadowedExports = `var exports={};${buildFlavorModuleSource({ exportKeys: ["qs"] })}`;
  const cases = [
    ["missing required chunk", null, /build flavor module.*not found/i],
    [
      "missing selected export",
      buildFlavorModuleSource({ exportKeys: ["As"] }),
      /build flavor module.*export qs/i,
    ],
    [
      "mismatched Prod value",
      buildFlavorModuleSource({ prod: "dev" }),
      /build flavor module.*Prod/i,
    ],
    ["computed Prod override", computedOverride, /build flavor module.*computed/i],
    ["async export getter", asyncGetter, /build flavor module.*exact getter/i],
    ["conflicting export descriptor", conflictingGetter, /build flavor module.*exact getter/i],
    ["base alias mutation", mutatedBaseAlias, /build flavor base.*unreviewed reference/i],
    [
      "namespace alias mutation",
      mutatedNamespaceAlias,
      /build flavor namespace.*unreviewed reference/i,
    ],
    ["shadowed Object host", shadowedObject, /trusted host binding Object/i],
    ["shadowed exports host", shadowedExports, /trusted host binding exports/i],
  ];

  for (const [name, buildFlavorSource, expected] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
        buildFlavorSource,
      });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        expected,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects shadowed trusted updater hosts", async (t) => {
  const fakeFlavors =
    "{Dev:'dev',Agent:'agent',Nightly:'nightly',InternalAlpha:'internal-alpha',PublicBeta:'public-beta',Prod:'dev'}";
  const cases = [
    [
      "shadowed require",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          `function require(){return {qs:${fakeFlavors}}}` +
          "const t=require('./src-build-flavors.js');",
      }),
      /trusted host binding require/i,
    ],
    [
      "shadowed Object",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          "const Object=globalThis.Object;const t=require('./src-build-flavors.js');",
      }),
      /trusted host binding Object/i,
    ],
    [
      "shadowed exports",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement: "var exports={};const t=require('./src-build-flavors.js');",
      }),
      /trusted host binding exports/i,
    ],
    [
      "shadowed process",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          "const process={env:{NODE_ENV:'production'},platform:'win32',arch:'x64'};" +
          "const t=require('./src-build-flavors.js');",
      }).replace("return f(e,t,'darwin',n)", "return f(e,t,process.platform,n)"),
      /trusted host binding process/i,
    ],
    [
      "module.require override",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          `module.require=()=>({qs:${fakeFlavors}});` +
          "const t=require('./src-build-flavors.js');",
      }),
      /trusted host binding module/i,
    ],
    [
      "loader prototype override",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          `const Loader=require('module');Loader.prototype.require=()=>({qs:${fakeFlavors}});` +
          "const t=require('./src-build-flavors.js');",
      }),
      /CommonJS loader access/i,
    ],
    [
      "process.env mutator argument",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nObject.assign(process.env,{CODEX_SPARKLE_ENABLED:'false'});`,
      /process\.env.*unreviewed reference/i,
    ],
    [
      "process.env alias mutation",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nconst env=process.env;Object.assign(env,{CODEX_SPARKLE_ENABLED:'false'});`,
      /process\.env alias.*unreviewed reference/i,
    ],
    [
      "process.env prototype alias mutation",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nconst env=process.env;const proto=env.__proto__;proto.CODEX_SPARKLE_ENABLED='false';`,
      /process\.env alias.*unreviewed reference/i,
    ],
  ];

  for (const [name, definitionSource, expected] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath), expected);
    });
  }
});

test("verifyUpdaterNotDisabled rejects loose equality in static predicates", async (t) => {
  for (const operator of ["==", "!="]) {
    await t.test(operator, async (t) => {
      const definitionSource = updaterDefinitionSource({ exportKey: "qs" }).replace(
        "const f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
        `const f=()=>1${operator}'1';`,
      );
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        /loose equality/i,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects mutated or impure static helper bindings", async (t) => {
  const base = updaterDefinitionSource({ exportKey: "qs" }).replace(
    "const f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
    "let f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
  );
  const cases = [
    ["module reassignment", `${base}\nf=()=>false;`, /static binding f.*mutated/i],
    [
      "nested reassignment",
      `${base}\nfunction mutate(){f=()=>false}`,
      /static binding f.*mutated/i,
    ],
    [
      "helper side effect",
      updaterDefinitionSource({ exportKey: "qs" }).replace(
        "const f=(e,t,n,r)=>!d(r)&&l.includes(e)&&t===n;",
        "function f(e,t,n,r){sideEffect();return !d(r)&&l.includes(e)&&t===n}",
      ),
      /single return-only statement/i,
    ],
    [
      "array alias mutation",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nconst alias=l;alias.length=0;`,
      /static data binding l.*unreviewed/i,
    ],
    [
      "array mutator call",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nl.splice(0);`,
      /static data binding l.*unreviewed/i,
    ],
    [
      "array escape to Object.assign",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nObject.assign(l,{length:0});`,
      /static data binding l.*unreviewed/i,
    ],
    [
      "updater container alias mutation",
      `${updaterDefinitionSource({ exportKey: "qs" })}\nconst alias=h;alias.shouldIncludeSparkle=()=>false;alias.shouldIncludeUpdater=()=>false;`,
      /updater container h.*unreviewed reference/i,
    ],
  ];

  for (const [name, definitionSource, expected] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        expected,
      );
    });
  }
});

test("verifyUpdaterNotDisabled ignores references and nested names before the definition", async (t) => {
  const referenceSource = [
    "const shouldIncludeUpdater=api.shouldIncludeUpdater;",
    "const refs={shouldIncludeSparkle:api.shouldIncludeSparkle};",
    "function wrapper(){",
    "  function shouldIncludeSparkle(){return false}",
    "  const shouldIncludeUpdater=()=>false;",
    "  const nested={shouldIncludeUpdater(){return false}};",
    "  return nested;",
    "}",
  ].join("\n");
  const fixture = await createUpdaterFixture(t, {
    definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
    extraFiles: { "a-reference.js": referenceSource },
  });

  assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
});

test("verifyUpdaterNotDisabled ignores an unconsumed worker copy", async (t) => {
  const fixture = await createUpdaterFixture(t, {
    definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
    extraFiles: {
      "worker.js": updaterDefinitionSource({
        exportKey: "qs",
        containerName: "workerBuildFlavor",
        commonJsExportKey: "worker",
      }),
    },
  });

  assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
});

test("verifyUpdaterNotDisabled rejects two consumed updater modules", async (t) => {
  const fixture = await createUpdaterFixture(t, {
    definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
    extraFiles: {
      "file-based-logger-second.js": updaterDefinitionSource({
        exportKey: "qs",
        containerName: "second",
        commonJsExportKey: "b",
      }),
      "second-consumer.js": updaterConsumerSource({
        definitionName: "file-based-logger-second.js",
        localName: "secondModule",
        commonJsExportKey: "b",
      }),
    },
  });

  assert.throws(
    () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
    /main updater.*ambiguous/i,
  );
});

test("verifyUpdaterNotDisabled requires an exact CommonJS container getter", async (t) => {
  await t.test("top-level sequence exports allow unrelated getters", async (t) => {
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({
        exportKey: "qs",
        exportStatement: [
          "const other={};",
          "(Object.defineProperty(exports,'a',{get:function(){return h}}),",
          "Object.defineProperty(exports,'x',{get:function(){return other}}),",
          "Object.defineProperty(exports,'y',{get:function(){return other}}));",
        ].join(""),
      }),
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });

  await t.test("unrelated getters are allowed", async (t) => {
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({
        exportKey: "qs",
        additionalExportStatements: [
          "const other={};",
          "Object.defineProperty(exports,'x',{get:function(){return other}});",
          "Object.defineProperty(exports,'y',{get:function(){return other}});",
        ],
      }),
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });

  const cases = [
    [
      "wrong container",
      updaterDefinitionSource({
        exportKey: "qs",
        getterBody: "return other;",
        extraStatements: ["const other={};"],
      }),
    ],
    [
      "getter side effects",
      updaterDefinitionSource({
        exportKey: "qs",
        getterBody: "const value=h;return value;",
      }),
    ],
    [
      "dynamic export key",
      updaterDefinitionSource({
        exportKey: "qs",
        exportStatement:
          "const exportKey='a';Object.defineProperty(exports,exportKey,{get:function(){return h}});",
      }),
    ],
    [
      "conditional export call",
      updaterDefinitionSource({
        exportKey: "qs",
        exportStatement:
          "true?Object.defineProperty(exports,'a',{get:function(){return h}}):null;",
      }),
    ],
    [
      "async getter",
      updaterDefinitionSource({
        exportKey: "qs",
        exportStatement:
          "Object.defineProperty(exports,'a',{get:async function(){return h}});",
      }),
    ],
    [
      "conflicting accessor descriptor",
      updaterDefinitionSource({
        exportKey: "qs",
        exportStatement:
          "Object.defineProperty(exports,'a',{get:function(){return h},set:function(){}});",
      }),
    ],
    [
      "duplicate selected key",
      updaterDefinitionSource({
        exportKey: "qs",
        additionalExportStatements: [
          "Object.defineProperty(exports,'a',{get:function(){return h}});",
        ],
      }),
    ],
    [
      "same container under another key",
      updaterDefinitionSource({
        exportKey: "qs",
        additionalExportStatements: [
          "Object.defineProperty(exports,'b',{get:function(){return h}});",
        ],
      }),
    ],
  ];
  for (const [name, definitionSource] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        /container export/i,
      );
    });
  }
});

test("verifyUpdaterNotDisabled requires final synchronous ordinary updater methods", async (t) => {
  const base = updaterDefinitionSource({ exportKey: "qs" });
  const sparkleMethod =
    "shouldIncludeSparkle(e,t,n=process.env){return f(e,t,'darwin',n)}";
  const updaterMethod =
    "shouldIncludeUpdater(e,t,n=process.env){return h.shouldIncludeSparkle(e,t,n)||h.shouldIncludeWindowsUpdater(e,t,n)}";
  const getterSource = base
    .replace(sparkleMethod, "get shouldIncludeSparkle(){return true}")
    .replace(updaterMethod, "get shouldIncludeUpdater(){return true}");
  const asyncSource = base
    .replace(sparkleMethod, `async ${sparkleMethod}`)
    .replace(updaterMethod, `async ${updaterMethod}`);
  const generatorSource = base
    .replace(sparkleMethod, `*${sparkleMethod}`)
    .replace(updaterMethod, `*${updaterMethod}`);
  const trailingSpread = updaterDefinitionSource({
    exportKey: "qs",
    requireStatement:
      "const t=require('./src-build-flavors.js');" +
      "const evil={shouldIncludeSparkle:()=>false,shouldIncludeUpdater:()=>false};",
  }).replace("}};\nObject.defineProperty", "},...evil};\nObject.defineProperty");
  const computedOverride = updaterDefinitionSource({
    exportKey: "qs",
    requireStatement:
      "const t=require('./src-build-flavors.js');" +
      "const sparkle='shouldIncludeSparkle',updater='shouldIncludeUpdater';",
  }).replace(
    "}};\nObject.defineProperty",
    "},[sparkle]:()=>false,[updater]:()=>false};\nObject.defineProperty",
  );
  const cases = [
    ["accessor predicates", getterSource],
    ["async predicates", asyncSource],
    ["generator predicates", generatorSource],
    ["trailing spread override", trailingSpread],
    ["computed property override", computedOverride],
  ];

  for (const [name, definitionSource] of cases) {
    await t.test(name, async (t) => {
      assert.notEqual(definitionSource, base);
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        /main updater container not found|updater container export/i,
      );
    });
  }
});

test("verifyUpdaterNotDisabled requires an unshadowed dual-call consumer", async (t) => {
  const definitionName = "file-based-logger-fixture.js";
  const callPair =
    "i.a.shouldIncludeSparkle('prod','darwin',process.env);i.a.shouldIncludeUpdater('prod','darwin',process.env);";
  const cases = [
    [
      "only one call",
      updaterConsumerSource({ definitionName, methods: ["shouldIncludeUpdater"] }),
    ],
    [
      "wrong required module",
      updaterConsumerSource({ definitionName: "src-build-flavors.js" }),
    ],
    [
      "dynamic require",
      "const moduleName='file-based-logger-fixture.js';const i=require(`./${moduleName}`);" +
        `function boot(){${callPair}}`,
    ],
    [
      "function parameter shadow",
      `const i=require('./${definitionName}');function decoy(i){${callPair}}`,
    ],
    [
      "function var shadow",
      `const i=require('./${definitionName}');function decoy(){var i=other;${callPair}}`,
    ],
    [
      "block binding shadow",
      `const i=require('./${definitionName}');function decoy(){{const i=other;${callPair}}}`,
    ],
    [
      "catch parameter shadow",
      `const i=require('./${definitionName}');try{}catch(i){${callPair}}`,
    ],
    [
      "shadowed CommonJS require",
      "function require(){return {a:{shouldIncludeSparkle:()=>false,shouldIncludeUpdater:()=>false}}}" +
        `const i=require('./${definitionName}');function boot(){${callPair}}`,
      /trusted host binding require/i,
    ],
  ];

  for (const [name, consumerSource, expected = /dual-call consumer/i] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
        consumerSource,
      });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        expected,
      );
    });
  }

  await t.test("writes to a shadowed alias do not mutate the module binding", async (t) => {
    const consumerSource = [
      `const i=require('./${definitionName}');`,
      "function decoy(i){i.a=other;}",
      `function boot(){${callPair}}`,
    ].join("\n");
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
      consumerSource,
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });

  await t.test("expression-bodied arrows do not create block scopes", async (t) => {
    const consumerSource = [
      `const i=require('./${definitionName}');`,
      "const factory=()=>function nested(){return true};",
      `function boot(){${callPair}}`,
    ].join("\n");
    const fixture = await createUpdaterFixture(t, {
      definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
      consumerSource,
    });

    assert.doesNotThrow(() => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath));
  });
});

test("verifyUpdaterNotDisabled requires reviewed updater call-chain source hashes", async (t) => {
  const definitionName = "file-based-logger-fixture.js";
  const callPair =
    "i.a.shouldIncludeSparkle('dev','linux',process.env);i.a.shouldIncludeUpdater('dev','linux',process.env);";
  const cases = [
    { name: "otherwise valid fixture" },
    {
      name: "wrong runtime arguments",
      consumerSource: `const i=require('./${definitionName}');function boot(){${callPair}}`,
    },
    {
      name: "statically unreachable calls",
      consumerSource: `const i=require('./${definitionName}');if(false){${callPair}}`,
    },
    {
      name: "updater definition prototype side effect",
      definitionSource:
        `${updaterDefinitionSource({ exportKey: "qs" })}\n` +
        "Array.prototype.includes=()=>false;",
    },
    {
      name: "build flavor prototype side effect",
      buildFlavorSource:
        `${buildFlavorModuleSource()}\n` +
        "Array.prototype.includes=()=>false;",
    },
  ];

  for (const { name, ...options } of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
        ...options,
      });
      assert.throws(
        () => verifyUpdaterNotDisabledRaw(fixture.app, fixture.asarPath),
        /updater call-chain source hashes.*not reviewed/i,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects writes to the module consumer alias", async (t) => {
  const definitionName = "file-based-logger-fixture.js";
  const calls =
    "function boot(){i.a.shouldIncludeSparkle('prod','darwin',process.env);i.a.shouldIncludeUpdater('prod','darwin',process.env);}";
  const cases = [
    ["binding assignment", `let i=require('./${definitionName}');i=other;${calls}`],
    ["namespace assignment", `const i=require('./${definitionName}');i.a=other;${calls}`],
    [
      "method assignment",
      `const i=require('./${definitionName}');i.a.shouldIncludeUpdater=other;${calls}`,
    ],
    [
      "nested assignment",
      `const i=require('./${definitionName}');function mutate(){i.a=other}${calls}`,
    ],
    [
      "destructuring assignment",
      `let i=require('./${definitionName}');({x:i}=value);${calls}`,
    ],
    [
      "for-of assignment",
      `let i=require('./${definitionName}');for([i] of values){}${calls}`,
    ],
    ["member delete", `const i=require('./${definitionName}');delete i.a;${calls}`],
    [
      "export namespace alias mutation",
      `const i=require('./${definitionName}');const alias=i.a;alias.shouldIncludeSparkle=other;${calls}`,
      /consumer export.*unreviewed reference/i,
    ],
  ];

  for (const [name, consumerSource, expected = /consumer alias.*mutated/i] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({ exportKey: "qs" }),
        consumerSource,
      });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        expected,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects unreviewed build flavor bindings", async (t) => {
  const cases = [
    ["unknown export", updaterDefinitionSource({ exportKey: "Unknown" }), /export key/i],
    [
      "different require alias",
      updaterDefinitionSource({ bindingName: "u", exportKey: "qs" }),
      /binding.*t/i,
    ],
    [
      "missing require binding",
      updaterDefinitionSource({ exportKey: "qs", requireStatement: "" }),
      /binding.*t/i,
    ],
    [
      "ordinary object binding",
      updaterDefinitionSource({ exportKey: "qs", requireStatement: "const t={};" }),
      /direct.*require/i,
    ],
    [
      "duplicate binding",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          "var t=require('./src-build-flavors.js');var t=require('./src-build-flavors.js');",
      }),
      /binding.*t/i,
    ],
    [
      "dynamic template require",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement: "const chunk='src-build-flavors';const t=require(`./${chunk}.js`);",
      }),
      /relative require/i,
    ],
    [
      "absolute require",
      updaterDefinitionSource({ exportKey: "qs", requireStatement: "const t=require('/tmp/x.js');" }),
      /relative require/i,
    ],
    [
      "bare require",
      updaterDefinitionSource({ exportKey: "qs", requireStatement: "const t=require('package');" }),
      /relative require/i,
    ],
    [
      "dot-prefixed bare require",
      updaterDefinitionSource({ exportKey: "qs", requireStatement: "const t=require('.package');" }),
      /relative require/i,
    ],
    [
      "missing required flavor",
      updaterDefinitionSource({
        exportKey: "qs",
        flavors: REQUIRED_UPDATER_FLAVORS.filter((flavor) => flavor !== "PublicBeta"),
      }),
      /missing.*PublicBeta/i,
    ],
    [
      "unknown flavor",
      updaterDefinitionSource({
        exportKey: "qs",
        flavors: [...REQUIRED_UPDATER_FLAVORS, "Canary"],
      }),
      /unknown.*Canary/i,
    ],
    [
      "namespace alias mutation",
      updaterDefinitionSource({
        exportKey: "qs",
        requireStatement:
          "const t=require('./src-build-flavors.js');const alias=t.qs;alias.Prod='dev';",
      }),
      /build flavor binding t.*unreviewed reference/i,
    ],
  ];

  for (const [name, definitionSource, expected] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, { definitionSource });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        expected,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects module-scope build flavor mutations", async (t) => {
  const cases = [
    ["binding assignment", "t=other;"],
    ["namespace assignment", "t.qs=other;"],
    ["flavor assignment", "t.qs.Prod='dev';"],
    ["flavor update", "t.qs.Prod++;"],
    ["flavor delete", "delete t.qs.Prod;"],
    ["object destructuring assignment", "({x:t}=value);"],
    ["array destructuring assignment", "[t]=value;"],
  ];

  for (const [name, mutation] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({
          exportKey: "qs",
          requireStatement: "let t=require(`./src-build-flavors.js`);",
          extraStatements: [mutation],
        }),
      });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        /binding.*mutated/i,
      );
    });
  }
});

test("verifyUpdaterNotDisabled rejects module-scope updater container mutations", async (t) => {
  const cases = [
    ["container assignment", "h=other;"],
    ["method assignment", "h.shouldIncludeUpdater=other;"],
    ["method update", "h.shouldIncludeUpdater++;"],
    ["method delete", "delete h.shouldIncludeSparkle;"],
    ["object destructuring assignment", "({x:h}=value);"],
    ["array destructuring assignment", "[h]=value;"],
  ];

  for (const [name, mutation] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createUpdaterFixture(t, {
        definitionSource: updaterDefinitionSource({
          exportKey: "qs",
          extraStatements: [mutation],
        }),
      });
      assert.throws(
        () => verifyUpdaterNotDisabled(fixture.app, fixture.asarPath),
        /updater container.*mutated/i,
      );
    });
  }
});
