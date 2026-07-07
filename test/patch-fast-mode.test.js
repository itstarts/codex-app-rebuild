const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectFastGatePatches,
  collectFastRequestPatches,
  collectFastRequestEvidence,
} = require("../scripts/patch-fast-mode");
const { applyTextPatches } = require("../scripts/patch-util");

const CONFIG_DERIVED_HELPERS =
  'function gu(value){return value==null||typeof value==="symbol"||typeof value==="boolean"?null:typeof value==="function"?value:String(value)} async function EKe(host,model){let response=await eu("list-models-for-host",{hostId:host});return response.models.find(item=>item.model===model)} ';

test("fast gate patch removes chatgpt authMethod block", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures", "fast-mode-gate.js"),
    "utf8",
  );
  const output = applyTextPatches(source, collectFastGatePatches(source));
  assert.match(output, /return !1&&/);
});

test("fast gate patch rewrites ternary chatgpt equality inside fast mode function", () => {
  const source =
    "async function Vje(e,t){let n=await Rje(e,t);return n===`chatgpt`?(await e.query.fetch(Us,{authMethod:n,hostId:t})).requirements?.featureRequirements?.fast_mode!==!1:!1}";
  const output = applyTextPatches(source, collectFastGatePatches(source));
  assert.match(output, /return !0\?/);
});

test("fast gate patch rewrites authMethod equality assignment inside fast mode function", () => {
  const source =
    "function ZMt(e){let i=OK(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1;return d}";
  const output = applyTextPatches(source, collectFastGatePatches(source));
  assert.match(output, /a=!0/);
});

test("fast gate patch does not rewrite unrelated chatgpt comparison in same fast mode function", () => {
  const source =
    "function gate(e){let auth=e.authMethod===`chatgpt`,source=e.source===`chatgpt`;return auth&&source&&e.requirements.featureRequirements.fast_mode!==!1}";
  const output = applyTextPatches(source, collectFastGatePatches(source));
  assert.match(output, /let auth=!0/);
  assert.match(output, /source=e\.source===`chatgpt`/);
});

test("fast gate patch respects block-scoped auth alias shadowing", () => {
  const source =
    'function gate(e){let auth=e.authMethod;if(e.requirements.featureRequirements.fast_mode!==!1){let auth=e.source;return auth==="chatgpt"}return auth==="chatgpt"}';
  const patches = collectFastGatePatches(source);
  const output = applyTextPatches(source, patches);
  assert.equal(patches.length, 1);
  assert.match(output, /return auth==="chatgpt"}return !0}/);
});

test("fast gate patch ignores nested function authMethod comparison", () => {
  const source =
    "function outer(req){function inner(e){return e.authMethod===`chatgpt`} return req.requirements.featureRequirements.fast_mode!==!1}";
  assert.equal(collectFastGatePatches(source).length, 0);
});

test("fast request patch makes fast UI state send fast tier", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures", "fast-mode-request.js"),
    "utf8",
  );
  const output = applyTextPatches(source, collectFastRequestPatches(source));
  assert.match(output, /state\.speed==="fast"\?"fast":"standard"/);
});

test("fast request patch preserves branch direction for inverted fast selector", () => {
  const source =
    'function payload(state){return Hs("start-conversation",{serviceTier:state.speed!=="fast"?"standard":"standard"})}';
  const output = applyTextPatches(source, collectFastRequestPatches(source));
  assert.match(output, /state\.speed!=="fast"\?"standard":"fast"/);
});

test("fast request patch respects block-scoped speed shadowing", () => {
  const source =
    'function send(input,state){let speed=input;if(state.flag){let speed=state.speed}return Hs("start-conversation",{serviceTier:speed==="fast"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch ignores local conditional outside request payload path", () => {
  const source =
    'function cfg(state){return {service_tier: state.speed==="fast"?"standard":"standard"}}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch rewrites start-turn-for-host params serviceTier", () => {
  const source =
    'function turn(state){return Ts("start-turn-for-host",{params:{serviceTier:state.speed==="fast"?"standard":"standard"}})}';
  const output = applyTextPatches(source, collectFastRequestPatches(source));
  assert.match(output, /state\.speed==="fast"\?"fast":"standard"/);
});

test("fast request patch accepts renamed IPC request wrapper", () => {
  const source =
    'function turn(state){return eu("start-turn-for-host",{params:{serviceTier:state.speed==="fast"?"standard":"standard"}})}';
  const output = applyTextPatches(source, collectFastRequestPatches(source));
  assert.match(output, /state\.speed==="fast"\?"fast":"standard"/);
});

test("fast request patch rejects non-IPC calls with matching action string", () => {
  const source =
    'function track(action,payload){return payload} function turn(state){return track("start-conversation",{serviceTier:state.speed==="fast"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch rejects shadowed trusted IPC wrapper name", () => {
  const source =
    'function eu(action,payload){return payload} function turn(state){return eu("start-conversation",{serviceTier:state.speed==="fast"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch rejects req.speed conditional outside UI state", () => {
  const source =
    'function start(req){return Hs("start-conversation",{serviceTier:req.speed==="fast"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch rejects cfg.speed conditional outside UI state", () => {
  const source =
    'function start(cfg){return Hs("start-conversation",{serviceTier:cfg.speed==="fast"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch accepts alias traced from state.speed", () => {
  const source =
    'function start(state){const speed=state.speed;return Hs("start-conversation",{serviceTier:speed==="fast"?"standard":"standard"})}';
  const output = applyTextPatches(source, collectFastRequestPatches(source));
  assert.match(output, /speed==="fast"\?"fast":"standard"/);
});

test("fast request patch rejects unrelated pro tier conditional", () => {
  const source =
    'function start(state){return Hs("start-conversation",{serviceTier:state.tier==="pro"?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request patch rejects unrelated null service tier conditional", () => {
  const source =
    'function start(cfg){return Hs("start-conversation",{serviceTier:cfg.service_tier==null?"standard":"standard"})}';
  assert.equal(collectFastRequestPatches(source).length, 0);
});

test("fast request evidence accepts native fast and standard mapping", () => {
  const source =
    'function payload(state){return Hs("start-conversation",{serviceTier:state.speed==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence rejects req.speed conditional outside UI state", () => {
  const source =
    'function payload(req){return Hs("start-conversation",{serviceTier:req.speed==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects cfg.speed conditional outside UI state", () => {
  const source =
    'function payload(cfg){return Hs("start-conversation",{serviceTier:cfg.speed==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence accepts alias traced from state.speed", () => {
  const source =
    'function payload(state){const speed=state.speed;return Hs("start-conversation",{serviceTier:speed==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence rejects bare mode fast check outside UI speed selector", () => {
  const source =
    'function payload(mode){return Hs("start-conversation",{serviceTier:mode==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects non-speed state fast check", () => {
  const source =
    'function payload(state){return Hs("start-conversation",{serviceTier:state.tier==="fast"?"fast":"standard"})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence accepts inverted fast check with matching branch direction", () => {
  const source =
    'function payload(state){return Hs("start-conversation",{serviceTier:state.speed!=="fast"?"standard":"fast"})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence rejects reversed fast and standard mapping", () => {
  const source =
    'function payload(state){return Hs("start-conversation",{serviceTier:state.speed==="fast"?"standard":"fast"})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence accepts PE serviceTier chain", () => {
  const source =
    'async function PE(scope,host,model){let o=Qp({service_tier:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,true):Cf(null,o.service_tier,true)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("request evidence rejects req.service_tier native Cf chain", () => {
  const source =
    'async function start(req,host,model){return Hs("start-conversation",{serviceTier:Cf(await Hje(host,model),req.service_tier,true)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("request evidence rejects cfg.service_tier native Cf chain", () => {
  const source =
    'async function start(cfg,host,model){return Hs("start-conversation",{serviceTier:Cf(await Hje(host,model),cfg.service_tier,true)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence accepts upstream PE chain with boolean fast-mode flag", () => {
  const source =
    'async function Vje(scope,host){return host==="chatgpt"} async function Hje(host,model){return {host,model}} async function PE(scope,host,model){let r=await Vje(scope,host),i={type:"fromConfig"},o=Qp({service_tier:null});if(i.type!=="fromConfig")return Cf(null,Tne(i,null),r);return o.service_tier==null?Cf(await Hje(host,model??o.model),o.service_tier,r):Cf(null,o.service_tier,r)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence accepts config-derived service tier helper from current bundle", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){try{let enabled=await TKe(scope,host),state=scope.get(So,host);if(state.type!=="fromConfig")return gu(null,kl(state,null),enabled);let{config}=await eu("read-config-for-host",{hostId:host,includeLayers:false,cwd:null}),parsed=Mo(config);return parsed.service_tier==null?gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled):gu(null,parsed.service_tier,enabled)}catch(error){return null}} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence accepts current bundle Bt string normalizer", () => {
  const source =
    'function Bt(value){return value} function gu(value){return value==null||typeof value==="symbol"||typeof value==="boolean"?null:typeof value==="function"?value:Bt(""+value)} async function EKe(host,model){let response=await eu("list-models-for-host",{hostId:host});return response.models.find(item=>item.model===model)} ' +
    'async function pk(scope,host,model){try{let enabled=await TKe(scope,host),state=scope.get(So,host);if(state.type!=="fromConfig")return gu(null,kl(state,null),enabled);let{config}=await eu("read-config-for-host",{hostId:host,includeLayers:false,cwd:null}),parsed=Mo(config);return parsed.service_tier==null?gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled):gu(null,parsed.service_tier,enabled)}catch(error){return null}} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence rejects config helper that returns an external tier", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host){await eu("read-config-for-host",{hostId:host});let parsed={service_tier:null};return externalTier} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external tier wrappers that mention service_tier", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return wrapExternal(externalTier,parsed.service_tier)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects mixed helper return with external tier call", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);if(parsed.service_tier==null)return gu(await EKe(host,model),parsed.service_tier,enabled);return gu(externalTier)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external service_tier member in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),external.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external async model lookup in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await externalLookup(),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external neutral call in mixed config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);if(parsed.service_tier==null)return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled);return gu(null,externalTier(),enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects false flag alias in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let disabled=false,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,disabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external store state in neutral config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,state=externalStore.get(host),{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);if(parsed.service_tier==null)return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled);return gu(null,kl(state,null),enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external wrapper with parsed model lookup", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return wrapExternal(await externalLookup(parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects false flag parameter passed to config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model,enabled){let{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null,false)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects minified false flag in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let disabled=!1,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,disabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects reassigned false flag in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true;enabled=false;let{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects mismatched parsed object in config helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config),other=Mo(config);return gu(await EKe(host,model??parsed.model),other.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects fake normalizer in config helper", () => {
  const source =
    'function gu(value){return typeof value==="symbol"||typeof value==="boolean"?externalTier:typeof value==="function"?externalTier:String(value)} async function EKe(host,model){let response=await eu("list-models-for-host",{hostId:host});return response.models.find(item=>item.model===model)} async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects fake normalizer with null shape and external return", () => {
  const source =
    'function gu(value){return value==null?externalTier:typeof value==="symbol"||typeof value==="boolean"?null:typeof value==="function"?value:String(value)} async function EKe(host,model){let response=await eu("list-models-for-host",{hostId:host});return response.models.find(item=>item.model===model)} async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects external neutral state normalizer", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,state=scope.get(So,host),{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);if(parsed.service_tier==null)return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled);return gu(null,externalTier(state,null),enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects shadowed neutral normalizer after native return", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,state=scope.get(So,host),{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);if(parsed.service_tier==null)return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled);{let gu=externalNormalizer;return gu(null,kl(state,null),enabled)}} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects shadowed config normalizer parameter", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model,gu){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null,externalNormalizer)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects shadowed config normalizer variable", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let gu=externalNormalizer,enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects shadowed config model lookup parameter", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model,EKe){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null,externalLookup)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects config read from non-IPC helper", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=true,{config}=localRead("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects model lookup from non-IPC helper", () => {
  const source =
    'function gu(value){return value==null||typeof value==="symbol"||typeof value==="boolean"?null:typeof value==="function"?value:String(value)} async function EKe(host,model){let response=localRead("list-models-for-host",{hostId:host});return response.models.find(item=>item.model===model)} ' +
    'async function pk(scope,host,model){let enabled=true,{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects flags that can remain false before a true assignment", () => {
  const source =
    CONFIG_DERIVED_HELPERS +
    'async function pk(scope,host,model){let enabled=false;if(scope.flag)enabled=true;let{config}=await eu("read-config-for-host",{hostId:host}),parsed=Mo(config);return gu(await EKe(host,model??parsed.model),parsed.service_tier,enabled)} async function start(scope,host){return eu("start-conversation",{hostId:host,serviceTier:await pk(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local Vje shadowing inside PE chain", () => {
  const source =
    'async function Hje(host,model){return {host,model}} async function PE(scope,host,model){function Vje(){return true} let r=await Vje(scope,host),o=Qp({service_tier:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,r):Cf(null,o.service_tier,r)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects PE parameter shadowing Vje", () => {
  const source =
    'async function Hje(host,model){return {host,model}} async function PE(Vje,scope,host,model){let r=await Vje(scope,host),o=Qp({service_tier:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,r):Cf(null,o.service_tier,r)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE((...args)=>true,scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local variable shadowing Vje", () => {
  const source =
    'async function Hje(host,model){return {host,model}} async function PE(scope,host,model){let Vje=(...args)=>true;let r=await Vje(scope,host),o=Qp({service_tier:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,r):Cf(null,o.service_tier,r)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects unrelated helper that only co-occurs with native config symbols", () => {
  const source =
    'function PE(){ Qp({service_tier:null}); return externalTier } function start(){ return Hs("start-conversation", { serviceTier: PE() }) }';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence accepts X_ serviceTier handoff", () => {
  const source =
    'async function PE(scope,host,model){let o=Qp({service_tier:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,true):Cf(null,o.service_tier,true)} async function X_(scope,host,model){return PE(scope,host,model)} async function turn(){let tier=await X_(scope,host,null);return Ts("start-turn-for-host",{params:{serviceTier:tier}})}';
  assert.equal(collectFastRequestEvidence(source).length, 1);
});

test("fast request evidence respects block-scoped tier shadowing", () => {
  const source =
    'async function PE(scope,host,model){let o={service_tier:null};return Cf(await Hje(host,model),o.service_tier,true)} async function X_(scope,host,model){return PE(scope,host,model)} async function turn(input,scope,host){let tier=input;if(input.flag){let tier=await X_(scope,host,null)}return Ts("start-turn-for-host",{params:{serviceTier:tier}})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects shadowed local Cf in request payload path", () => {
  const source =
    'function Cf(){return externalTier} function start(){return Hs("start-conversation",{serviceTier:Cf()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local zero-arg Cf helper inside PE chain", () => {
  const source =
    'function Cf(){return externalTier} async function Hje(){return hostTier} async function PE(){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local one-arg Cf helper inside PE chain", () => {
  const source =
    'function Cf(a){return externalTier} async function Hje(){return hostTier} async function PE(){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local two-arg Cf helper inside PE chain", () => {
  const source =
    'function Cf(a,b){return externalTier} async function Hje(){return hostTier} async function PE(){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects PE parameter shadowing Cf", () => {
  const source =
    'async function Hje(){return hostTier} async function PE(Cf){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE((a,b,c)=>externalTier)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local PE shadowing top-level PE helper", () => {
  const source =
    'function start(){function PE(){return externalTier} return Hs("start-conversation",{serviceTier:PE()})} async function Hje(){return hostTier} async function PE(scope,host,model){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local X_ shadowing top-level X_ helper", () => {
  const source =
    'function turn(){function X_(){return externalTier} return Ts("start-turn-for-host",{params:{serviceTier:X_()}})} async function Hje(){return hostTier} async function PE(scope,host,model){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function X_(scope,host,model){return PE(scope,host,model)}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local three-arg Cf helper inside PE chain", () => {
  const source =
    'function Cf(a,b,c){return externalTier} async function Hje(){return hostTier} async function PE(){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local rest-arg Cf helper inside PE chain", () => {
  const source =
    'const Cf=(...args)=>externalTier; async function Hje(){return hostTier} async function PE(){let o={service_tier:null};return Cf(await Hje(),o.service_tier,true)} async function start(){return Hs("start-conversation",{serviceTier:await PE()})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects Qp(otherConfig) as native service tier source", () => {
  const source =
    'async function PE(scope,host,model){let o=Qp(otherConfig);return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,true):Cf(null,o.service_tier,true)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects Qp({mode:null}) as native service tier source", () => {
  const source =
    'async function PE(scope,host,model){let o=Qp({mode:null});return o.service_tier==null?Cf(await Hje(host,model),o.service_tier,true):Cf(null,o.service_tier,true)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects mixed-return helper with external tier branch", () => {
  const source =
    'async function PE(flag,host,model){if(flag)return externalTier;let o=Qp({service_tier:null});return Cf(await Hje(host,model),o.service_tier,true)} async function start(host){return Hs("start-conversation",{serviceTier:PE(true,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects local fast/standard conditional outside request payload path", () => {
  const source =
    'function cfg(state){return {service_tier: state.speed==="fast"?"fast":"standard"}}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects start-turn host passthrough from external input", () => {
  const source =
    'function turn(input){return Ts("start-turn-for-host",{params:{serviceTier:input}})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects start-conversation without fast or standard config chain", () => {
  const source =
    'async function start(serviceTier){return Hs("start-conversation",{serviceTier})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});

test("fast request evidence rejects hard-coded false fast-mode flag", () => {
  const source =
    'async function PE(scope,host,model){let o={service_tier:null};return Cf(await Hje(host,model),o.service_tier,false)} async function start(scope,host){return Hs("start-conversation",{serviceTier:await PE(scope,host,null)})}';
  assert.equal(collectFastRequestEvidence(source).length, 0);
});
