function pluginAuthGate(authMethod){const context=`plugin marketplace install requiredApp`;return authMethod!==`chatgpt`}
function avail(){return {featureName:`browser_use`,allowed:false,available:false,isLoading:false}}
function gate(){return {featureName:`computer_use`,enabled:G(`1234567`)}}
function goalSlash(){const slash=`/goal`;return get(`goal_enabled`,false)}
const defaults={browserPane:!1,inAppBrowserUse:!1,inAppBrowserUseAllowed:!1,externalBrowserUse:!1,externalBrowserUseAllowed:!1,computerUse:!1,computerUseNodeRepl:!1,control:!1,multiWindow:!1,"features.js_repl":!1,js_repl:!1};
var Xo=[{autoInstallOptOutKey:t.ms(t.fs),installWhenMissing:!0,name:t.fs,isAvailable:({features:e})=>e.sites},{autoInstallOptOutKey:t.ms(t.ss),installWhenMissing:!0,name:t.ss,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:oo},{name:ot,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:n})=>eo(e,t)&&n.externalBrowserUseAllowed},{autoInstallOptOutKey:t.ms(t.ls),installWhenMissing:!0,name:t.ls,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse},{name:t.ds,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.recordAndReplay},...[]];
function peerAuth(p){const bundleIdentifier=`browser-use-native-pipe`;const owner=`OpenAI Team ID`;return p.teamId===`TC3A3QVN3A`}
