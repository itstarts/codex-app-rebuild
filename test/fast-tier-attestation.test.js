const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packAsar } = require("../scripts/lib/asar-utils");
const {
  runFastModePatch,
  verifyFastTierAttestation,
} = require("../scripts/patch-fast-mode");

const MODULES = {
  serviceTier: "webview/assets/service-tier.js",
  requestResolver: "webview/assets/request-resolver.js",
  mainUi: "webview/assets/main-ui.js",
  uiConsumer: "webview/assets/ui-consumer.js",
  actionConsumer: "webview/assets/action-consumer.js",
};

const MODULE_SOURCES = {
  serviceTier: [
    "let FAST_TIER,DEFAULT_TIER,fromConfigState;",
    "function initialize(){FAST_TIER=`priority`;DEFAULT_TIER=`default`;fromConfigState={type:`fromConfig`}}",
    "initialize();",
    "function iconKind(id,name){return id===FAST_TIER||id===`fast`||name===`priority`?`fast`:null}",
    "function options(model){return [{iconKind:null,value:null},...(model?.serviceTiers??[]).map(tier=>({iconKind:iconKind(tier.id,tier.name),value:tier.id}))]}",
    "function toState(value){return value==null?{type:`standard`}:{type:`custom`,serviceTier:value}}",
    "function fromState(state,fallback){switch(state.type){case`fromConfig`:return fallback;case`standard`:return DEFAULT_TIER;case`custom`:return state.serviceTier}}",
    "function normalize(model,tier,enabled=true){if(!enabled)return null;if(tier==null)return model?.defaultServiceTier??null;return tier===DEFAULT_TIER?null:tier}",
    "function configValue(value){return value??DEFAULT_TIER}",
    "function rpc(action,payload){return window.electronBridge.invoke(action,payload)}",
    "const serviceTierStore={defaultValue:fromConfigState};",
    "export{normalize as Ei,fromState as Oi,serviceTierStore as Yr,options as xi,toState as Di,configValue as ki,rpc as Wx};",
  ].join(";"),
  requestResolver: [
    'import{Ei as normalize,Oi as fromState,Yr as serviceTierStore,Wx as rpc}from"./service-tier.js";',
    "async function fastGate(scope,host){let account=await scope.auth(host),auth=account?.authMethod===`chatgpt`,requirements=await scope.requirements(host);return auth&&requirements.featureRequirements.fast_mode!==false}",
    "async function modelFor(host,model){let result=await rpc(`list-models-for-host`,{hostId:host});return result.data.find(item=>item.model===model)??null}",
    "async function resolveTier(scope,host,model){let enabled=await fastGate(scope,host),state=scope.get(serviceTierStore,host),{config}=await rpc(`read-config-for-host`,{hostId:host}),parsed=config;if(state.type!==`fromConfig`)return normalize(null,fromState(state,null),enabled);return parsed.service_tier==null?normalize(await modelFor(host,model??parsed.model),parsed.service_tier,enabled):normalize(null,parsed.service_tier,enabled)}",
    "export{resolveTier as i};",
  ].join(";"),
  mainUi: [
    'import{Ei as normalize,Oi as fromState,Yr as serviceTierStore,xi as options,Di as toState,ki as configValue,Wx as rpc}from"./service-tier.js";',
    "function useServiceTier(scope,host,model,config){let state=scope.get(serviceTierStore,host),selected=fromState(state,config.service_tier),availableOptions=options(model),serviceTierForRequest=normalize(model,selected,true);async function setServiceTier(value){await rpc(`batch-write-config-value`,{hostId:host,keyPath:`service_tier`,value:configValue(value)});scope.set(serviceTierStore,host,toState(value))}return{serviceTierSettings:{availableOptions,selectedServiceTier:selected,serviceTierForRequest},setServiceTier}}",
    "export{useServiceTier as Pm};",
  ].join(";"),
  uiConsumer: [
    'import{Pm as useServiceTier}from"./main-ui.js";',
    "function picker(scope,host,model,config){let{serviceTierSettings,setServiceTier}=useServiceTier(scope,host,model,config),fastValue=serviceTierSettings.availableOptions.find(option=>option.iconKind===`fast`)?.value,standardValue=serviceTierSettings.availableOptions.find(option=>option.value==null)?.value;return{fastValue,standardValue,onSelectServiceTier:value=>setServiceTier(value,`composer_menu`)}}",
    "export{picker};",
  ].join(";"),
  actionConsumer: [
    'import{i as resolveTier}from"./request-resolver.js";',
    'import{Wx as rpc}from"./service-tier.js";',
    "async function send(scope,host,connectionForHost){let connection=connectionForHost(host);await rpc(`start-turn-for-host`,{hostId:connection.getHostId(),params:{serviceTier:await resolveTier(scope,host,null)}});await rpc(`start-conversation`,{hostId:host,serviceTier:await resolveTier(scope,host,null)})}",
    "export{send};",
  ].join(";"),
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function createFixture(
  t,
  {
    asarSources = MODULE_SOURCES,
    workSources = MODULE_SOURCES,
    manifestSources = workSources,
    omitAsarRoles = [],
    asarDirectoryRoles = [],
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fast-tier-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const srcPlatform = path.join(root, "src", "mac-arm64");
  const asarSource = path.join(root, "asar-source");
  const extractedRoot = path.join(srcPlatform, "_asar");
  const appPath = path.join(srcPlatform, "upstream", "Codex.app");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");

  for (const [role, relativePath] of Object.entries(MODULES)) {
    const asarFile = path.join(asarSource, ...relativePath.split("/"));
    if (!omitAsarRoles.includes(role)) {
      if (asarDirectoryRoles.includes(role)) {
        fs.mkdirSync(asarFile, { recursive: true });
        fs.writeFileSync(path.join(asarFile, "nested.txt"), "fixture", "utf8");
      } else {
        fs.mkdirSync(path.dirname(asarFile), { recursive: true });
        fs.writeFileSync(asarFile, asarSources[role], "utf8");
      }
    }
    const workFile = path.join(extractedRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(workFile), { recursive: true });
    fs.writeFileSync(workFile, workSources[role], "utf8");
  }
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  await packAsar(asarSource, asarPath);

  const appAsarSha256 = sha256(fs.readFileSync(asarPath));
  const metadata = {
    platform: "mac-arm64",
    upstreamVersion: "26.707.30751",
    upstreamBuild: "5018",
    appAsarSha256,
    appPath: path.relative(root, appPath),
  };
  const manifests = [
    {
      upstreamVersion: metadata.upstreamVersion,
      upstreamBuild: metadata.upstreamBuild,
      appAsarSha256,
      modules: Object.entries(MODULES).map(([role, relativePath]) => ({
        role,
        path: relativePath,
        sha256: sha256(Buffer.from(manifestSources[role])),
      })),
    },
  ];
  return { root, metadata, manifests, asarPath, extractedRoot };
}

function clone(value) {
  return structuredClone(value);
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function verifyFixture(fixture, overrides = {}) {
  return verifyFastTierAttestation({
    projectRoot: fixture.root,
    metadata: fixture.metadata,
    manifests: fixture.manifests,
    ...overrides,
  });
}

function fixtureWorkFiles(fixture) {
  return Object.values(MODULES).map((relativePath) =>
    path.join(fixture.extractedRoot, ...relativePath.split("/")),
  );
}

function createLegacyEvidenceFile(fixture) {
  const file = path.join(fixture.extractedRoot, "webview", "assets", "legacy-evidence.js");
  fs.writeFileSync(
    file,
    [
      "function gate(req){let auth=req.authMethod===`chatgpt`;return auth&&req.requirements.featureRequirements.fast_mode!==false}",
      "function payload(state){return Hs(`start-conversation`,{serviceTier:state.speed===`fast`?`fast`:`standard`})}",
    ].join(";"),
    "utf8",
  );
  return file;
}

test("version-bound Fast tier attestation proves both request actions", async (t) => {
  const fixture = await createFixture(t);

  const result = verifyFixture(fixture);

  assert.equal(result.required, true);
  assert.deepEqual(
    result.evidence.map((item) => item.action).sort(),
    ["start-conversation", "start-turn-for-host"],
  );
});

test("unknown valid upstream keeps the legacy compatibility path", async (t) => {
  const fixture = await createFixture(t);
  fixture.metadata.upstreamVersion = "99.1.1";

  assert.deepEqual(verifyFixture(fixture), { required: false, evidence: [] });
});

test("invalid metadata cannot fall back to legacy analysis", async (t) => {
  const cases = [
    ["upstreamVersion", " ", "metadata_version_invalid"],
    ["upstreamBuild", 5018, "metadata_build_invalid"],
    ["upstreamBuild", "05018", "metadata_build_invalid"],
    ["appAsarSha256", "A".repeat(64), "metadata_asar_hash_invalid"],
    ["appPath", "", "metadata_app_path_invalid"],
  ];
  for (const [field, value, code] of cases) {
    await t.test(`${field} rejects ${JSON.stringify(value)}`, async (t) => {
      const fixture = await createFixture(t);
      fixture.metadata[field] = value;
      expectCode(() => verifyFixture(fixture), code);
    });
  }
});

test("reserved version and build reject an unreviewed ASAR hash", async (t) => {
  const fixture = await createFixture(t);
  fixture.metadata.appAsarSha256 = "0".repeat(64);

  expectCode(() => verifyFixture(fixture), "attestation_hash_unreviewed");
});

test("original ASAR bytes are freshly hashed", async (t) => {
  const fixture = await createFixture(t);
  fs.appendFileSync(fixture.asarPath, "changed");

  expectCode(() => verifyFixture(fixture), "attestation_asar_hash_mismatch");
});

test("original ASAR path rejects a symbolic link", async (t) => {
  const fixture = await createFixture(t);
  const realAsar = `${fixture.asarPath}.real`;
  fs.renameSync(fixture.asarPath, realAsar);
  fs.symlinkSync(realAsar, fixture.asarPath);

  expectCode(() => verifyFixture(fixture), "attestation_asar_path_invalid");
});

test("every attested work module rejects byte drift", async (t) => {
  for (const [role, relativePath] of Object.entries(MODULES)) {
    await t.test(role, async (t) => {
      const fixture = await createFixture(t);
      fs.appendFileSync(path.join(fixture.extractedRoot, ...relativePath.split("/")), "changed");
      expectCode(() => verifyFixture(fixture), "attestation_role_hash_mismatch");
    });
  }
});

test("work module path rejects final and parent symbolic links", async (t) => {
  await t.test("final file", async (t) => {
    const fixture = await createFixture(t);
    const file = path.join(fixture.extractedRoot, ...MODULES.serviceTier.split("/"));
    const realFile = `${file}.real`;
    fs.renameSync(file, realFile);
    fs.symlinkSync(realFile, file);
    expectCode(() => verifyFixture(fixture), "attestation_work_path_invalid");
  });

  await t.test("parent directory", async (t) => {
    const fixture = await createFixture(t);
    const webview = path.join(fixture.extractedRoot, "webview");
    const realWebview = path.join(fixture.extractedRoot, "webview-real");
    fs.renameSync(webview, realWebview);
    fs.symlinkSync("webview-real", webview);
    expectCode(() => verifyFixture(fixture), "attestation_work_path_invalid");
  });
});

test("ASAR role must exist as a regular file", async (t) => {
  await t.test("missing role", async (t) => {
    const fixture = await createFixture(t, { omitAsarRoles: ["uiConsumer"] });
    expectCode(() => verifyFixture(fixture), "asar_role_missing");
  });

  await t.test("directory role", async (t) => {
    const fixture = await createFixture(t, { asarDirectoryRoles: ["uiConsumer"] });
    expectCode(() => verifyFixture(fixture), "asar_role_not_file");
  });
});

test("original ASAR roles cannot be paired with another work tree", async (t) => {
  const changed = {
    ...MODULE_SOURCES,
    serviceTier: `${MODULE_SOURCES.serviceTier};const unrelated=true`,
  };
  const fixture = await createFixture(t, {
    asarSources: MODULE_SOURCES,
    workSources: changed,
    manifestSources: changed,
  });

  expectCode(() => verifyFixture(fixture), "attestation_role_hash_mismatch");
});

test("manifest schema rejects ambiguity and unsafe module declarations", async (t) => {
  const cases = [
    [
      "duplicate composite key",
      (manifests) => manifests.push(clone(manifests[0])),
      "manifest_composite_duplicate",
    ],
    [
      "missing role",
      (manifests) => manifests[0].modules.pop(),
      "manifest_roles_invalid",
    ],
    [
      "duplicate role",
      (manifests) => {
        manifests[0].modules[1].role = manifests[0].modules[0].role;
      },
      "manifest_roles_invalid",
    ],
    [
      "duplicate path",
      (manifests) => {
        manifests[0].modules[1].path = manifests[0].modules[0].path;
      },
      "manifest_path_duplicate",
    ],
    [
      "absolute path",
      (manifests) => {
        manifests[0].modules[0].path = "/tmp/service-tier.js";
      },
      "manifest_path_invalid",
    ],
    [
      "parent traversal",
      (manifests) => {
        manifests[0].modules[0].path = "../service-tier.js";
      },
      "manifest_path_invalid",
    ],
    [
      "malformed hash",
      (manifests) => {
        manifests[0].modules[0].sha256 = "ABC";
      },
      "manifest_module_hash_invalid",
    ],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createFixture(t);
      const manifests = clone(fixture.manifests);
      mutate(manifests);
      expectCode(() => verifyFixture(fixture, { manifests }), code);
    });
  }
});

test("role swaps pass schema but fail structural diagnostics", async (t) => {
  const fixture = await createFixture(t);
  const manifests = clone(fixture.manifests);
  const first = manifests[0].modules[0].role;
  manifests[0].modules[0].role = manifests[0].modules[1].role;
  manifests[0].modules[1].role = first;

  expectCode(() => verifyFixture(fixture, { manifests }), "structure_marker_missing");
});

test("structural diagnostics run after rebuilt byte attestations", async (t) => {
  const cases = [
    [
      "resolver export",
      "requestResolver",
      (source) => source.replace("export{resolveTier as i}", "export{fastGate as i}"),
      "structure_resolver_export",
    ],
    [
      "resolver update",
      "requestResolver",
      (source) => `${source};resolveTier++`,
      "structure_resolver_mutated",
    ],
    [
      "Fast option",
      "uiConsumer",
      (source) => source.replace("option.iconKind===`fast`", "option.iconKind===`slow`"),
      "structure_ui_fast_option",
    ],
    [
      "Standard option",
      "uiConsumer",
      (source) => source.replace("option.value==null", "option.value===`standard`"),
      "structure_ui_standard_option",
    ],
    [
      "setter flow",
      "uiConsumer",
      (source) => source.replace("setServiceTier(value,`composer_menu`)", "setServiceTier(externalTier,`composer_menu`)") ,
      "structure_ui_setter_flow",
    ],
    [
      "missing turn action",
      "actionConsumer",
      (source) => source.replace(/await rpc\(`start-turn-for-host`[^;]+;/, ""),
      "structure_action_count",
    ],
    [
      "external tier",
      "actionConsumer",
      (source) => source.replace(
        "serviceTier:await resolveTier(scope,host,null)",
        "serviceTier:externalTier",
      ),
      "structure_action_tier",
    ],
    [
      "host mismatch",
      "actionConsumer",
      (source) => source.replace(
        "hostId:host,serviceTier:await resolveTier(scope,host,null)",
        "hostId:otherHost,serviceTier:await resolveTier(scope,host,null)",
      ),
      "structure_action_host",
    ],
    [
      "scope mismatch",
      "actionConsumer",
      (source) => source.replace(
        "resolveTier(scope,host,null)",
        "resolveTier(externalScope,host,null)",
      ),
      "structure_action_scope",
    ],
  ];
  for (const [name, role, mutate, code] of cases) {
    await t.test(name, async (t) => {
      const sources = { ...MODULE_SOURCES, [role]: mutate(MODULE_SOURCES[role]) };
      assert.notEqual(sources[role], MODULE_SOURCES[role]);
      const fixture = await createFixture(t, {
        asarSources: sources,
        workSources: sources,
        manifestSources: sources,
      });
      expectCode(() => verifyFixture(fixture), code);
    });
  }
});

test("patch orchestration uses the original attested snapshot in check and patch modes", async (t) => {
  await t.test("check mode leaves attested bytes unchanged", async (t) => {
    const fixture = await createFixture(t);
    const result = runFastModePatch({
      check: true,
      assetBundles: fixtureWorkFiles(fixture),
      buildBundles: [],
      metadata: fixture.metadata,
      manifests: fixture.manifests,
      projectRoot: fixture.root,
    });

    assert.equal(result.attestation.required, true);
    assert.doesNotThrow(() => verifyFixture(fixture));
  });

  await t.test("patch mode keeps pre-patch evidence after rewriting the gate", async (t) => {
    const fixture = await createFixture(t);
    const requestFile = path.join(
      fixture.extractedRoot,
      ...MODULES.requestResolver.split("/"),
    );
    const before = fs.readFileSync(requestFile, "utf8");

    const result = runFastModePatch({
      check: false,
      assetBundles: fixtureWorkFiles(fixture),
      buildBundles: [],
      metadata: fixture.metadata,
      manifests: fixture.manifests,
      projectRoot: fixture.root,
    });

    assert.equal(result.attestation.required, true);
    assert.notEqual(fs.readFileSync(requestFile, "utf8"), before);
    expectCode(() => verifyFixture(fixture), "attestation_role_hash_mismatch");
  });
});

test("mandatory attestation failures cannot fall back to valid legacy evidence", async (t) => {
  const fixture = await createFixture(t);
  const legacyFile = createLegacyEvidenceFile(fixture);
  fs.appendFileSync(
    path.join(fixture.extractedRoot, ...MODULES.mainUi.split("/")),
    "changed",
  );

  expectCode(
    () =>
      runFastModePatch({
        check: true,
        assetBundles: [...fixtureWorkFiles(fixture), legacyFile],
        buildBundles: [],
        metadata: fixture.metadata,
        manifests: fixture.manifests,
        projectRoot: fixture.root,
      }),
    "attestation_role_hash_mismatch",
  );
});

test("reserved identity hash drift cannot fall back to valid legacy evidence", async (t) => {
  const fixture = await createFixture(t);
  const legacyFile = createLegacyEvidenceFile(fixture);
  fixture.metadata.appAsarSha256 = "0".repeat(64);

  expectCode(
    () =>
      runFastModePatch({
        check: true,
        assetBundles: [legacyFile],
        buildBundles: [],
        metadata: fixture.metadata,
        manifests: fixture.manifests,
        projectRoot: fixture.root,
      }),
    "attestation_hash_unreviewed",
  );
});

test("unknown valid upstream can still use legacy request evidence", async (t) => {
  const fixture = await createFixture(t);
  const legacyFile = createLegacyEvidenceFile(fixture);
  fixture.metadata.upstreamVersion = "99.1.1";

  const result = runFastModePatch({
    check: true,
    assetBundles: [legacyFile],
    buildBundles: [],
    metadata: fixture.metadata,
    manifests: fixture.manifests,
    projectRoot: fixture.root,
  });

  assert.equal(result.attestation.required, false);
  assert.equal(result.request.nativeEvidence, 1);
});
