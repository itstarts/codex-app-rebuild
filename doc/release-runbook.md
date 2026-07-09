# Release Runbook

本文档记录 release 的端到端命令顺序。GitHub Actions 会根据官方 appcast 定时生成产物，并在发现新官方版本时自动发布为 latest release；本地旧版 `Codex-rebuild.app` 读取 `releases/latest/download/appcast-darwin-arm64.xml` 后即可检测到可安装更新。手工命令用于本地复核、回滚和人工补发。

## 前置条件

- 发布机为 macOS arm64，并安装 Node.js 24+、GitHub CLI、Sparkle `sign_update`、系统工具 `ditto`、`plutil`、`codesign`。
- 目标远程仓库为 `git@github.com:itstarts/codex-app-rebuild.git`；GitHub CLI 命令统一使用 `--repo itstarts/codex-app-rebuild`。
- `config/sparkle/public-ed-key.txt` 必须包含真实 Sparkle public EdDSA key。仓库中的 sentinel 值 `ed25519-test-public-key-change-before-release` 会阻断 `npm run patch:check`、`npm run patch`、`npm run build:mac-arm64` 和 `npm run appcast`；首次发布前必须替换该文件并提交 public key。
- Sparkle private key 只保存在 release machine，不写入仓库、日志或文档。通过 `SPARKLE_PRIVATE_KEY_FILE` 指向本机未跟踪文件，或通过 `SPARKLE_PRIVATE_KEY` 环境变量传入。
- `SPARKLE_SIGN_UPDATE` 指向 Sparkle 的 `sign_update` 可执行文件。
- `gh auth status --hostname github.com` 成功，账号对 `itstarts/codex-app-rebuild` 具备创建 release、上传资产和编辑 latest release 的权限。
- `REBUILD_BUILD_NUMBER` 使用固定格式 `YYYYMMDDHHMMSSNN`，例如 `2026070612003000`；时间部分为 UTC，`NN` 是同一秒内两位序号。
- 候选 `REBUILD_BUILD_NUMBER` 必须严格大于已发布最大 `sparkle:version`。脚本会从当前 latest appcast、GitHub Releases 中的 `appcast-darwin-arm64.xml`、以及人工传入的 `REBUILD_PREVIOUS_MAX_BUILD_NUMBER` 解析最大值。
- GitHub Release tag 格式固定为 `v${UPSTREAM_VERSION}-rebuild.${REBUILD_BUILD_NUMBER}`。
- 当前产物默认 ad-hoc codesign，也可用本机自签证书 `CODESIGN_IDENTITY`。产物未 notarize 时，首次打开、quarantine 解除、Keychain 访问、权限授予和 Sparkle 更新安装阶段可能出现 Gatekeeper 提示、确认框或密码输入。

## GitHub Actions 自动发布

`.github/workflows/release-candidate.yml` 提供基于官方 appcast 的自动发布。workflow 在北京时间每天 7:00 读取 OpenAI 官方 macOS arm64 appcast，并同时读取本项目 latest feed 与 GitHub Releases 中已发布的 appcast。只有 latest feed 已包含相同的官方 `shortVersionString + sparkle:version` 时才跳过构建；draft 或非 latest release 不会被直接提升为 latest。只要 latest feed 缺少该官方更新，workflow 就使用 GitHub-hosted macOS arm64 runner 重新下载上游、校验 Sparkle `2.9.4` 官方归档，并运行 `npm ci`、`npm test`、`npm run sync:mac`、`npm run patch:check`、`npm run patch`、`npm run build:mac-arm64`、`npm run appcast` 和 `npm run verify:static`。只有当前 workflow 生成的候选通过静态发布门禁后，才上传 zip、`appcast-darwin-arm64.xml` 和 `release-metadata.env` 作为 workflow artifact，并创建或更新同 tag 的 latest release。生成的 appcast 会记录 `codexRebuild:upstreamBuild`，用于区分相同 short version 下的官方 build 变化。

GitHub `schedule` 事件只在默认分支的最新提交上运行。该 workflow 合入默认分支后，自动检测与自动发布才会按计划执行。

首次使用前，在 GitHub 仓库的 Actions secrets 中配置：

- `SPARKLE_PRIVATE_KEY`：Sparkle EdDSA private key 文本。该 secret 只在 workflow 内写入 `$RUNNER_TEMP/sparkle-private-ed-key.txt`，不进入 artifact。

workflow 输入：

- `release_mode=latest-release`：默认模式，生成 workflow artifact，并创建或更新 latest GitHub Release。本地旧版 app 会通过 latest appcast 检测到更新。
- `release_mode=artifact-only`：只生成 workflow artifact，不写 GitHub Release。
- `release_mode=draft-release`：创建或更新同 tag 的 draft GitHub Release，并上传候选 zip 与 appcast。若同 tag 已经是已发布 release，workflow 会失败并拒绝覆盖。
- `rebuild_build_number`：可选固定构建号，必须为 16 位 `YYYYMMDDHHMMSSNN`。
- `rebuild_previous_max_build_number`：可选人工指定的已发布最大构建号。
- `allow_no_previous_release`：首次发布且没有可读取历史 appcast 时才设为 true。
- `force_build`：手动触发时即使官方版本已存在 rebuild appcast，也生成新的候选构建。

schedule 触发会在发现 latest feed 缺少当前官方更新时重新构建并自动发布 latest release，不复用或直接推广历史 draft/非 latest 候选。发布完成后，本地旧版 app 通过 latest appcast 检测到更新。自动发布路径包含单元测试、静态 patch 检查、三模块 updater 哈希门禁、构建验证、Sparkle 签名验证和 appcast 生成验证；本机交互运行时证据仍可按下方步骤在发布后复核。

首次自动发布时，如果检查阶段确认当前 rebuild channel 没有任何已知 appcast，workflow 会自动允许无历史构建号首发。后续发布仍会从 latest feed 和 GitHub Releases 读取已发布最大 `sparkle:version`，并要求候选 `REBUILD_BUILD_NUMBER` 严格递增。

## 发布命令

```bash
set -euo pipefail

cd /path/to/codex-app-rebuild

git remote get-url origin
test "$(git remote get-url origin)" = "git@github.com:itstarts/codex-app-rebuild.git"
git fetch origin
git pull --ff-only origin main

npm ci
npm test

gh auth status --hostname github.com
gh repo view itstarts/codex-app-rebuild --json nameWithOwner

: "${SPARKLE_SIGN_UPDATE:?set SPARKLE_SIGN_UPDATE to Sparkle sign_update}"
if [ -z "${SPARKLE_PRIVATE_KEY_FILE:-}" ] && [ -z "${SPARKLE_PRIVATE_KEY:-}" ]; then
  echo "set SPARKLE_PRIVATE_KEY_FILE or SPARKLE_PRIVATE_KEY on the release machine" >&2
  exit 1
fi

node -e 'const {readPublicKey}=require("./scripts/patch-update-channel"); readPublicKey(); console.log("Sparkle public key ok")'

npm run sync:mac
npm run patch:check
npm run patch

UPSTREAM_VERSION=$(node -p 'require("./src/mac-arm64/upstream-metadata.json").upstreamVersion')
UPSTREAM_BUILD=$(node -p 'require("./src/mac-arm64/upstream-metadata.json").upstreamBuild')
PREVIOUS_MAX=$(node -e 'const {resolvePreviousMaxBuildNumber}=require("./scripts/lib/github-release-utils"); resolvePreviousMaxBuildNumber().then(v=>process.stdout.write(v)).catch(e=>{console.error(e.message); process.exit(1);})')
REBUILD_BUILD_NUMBER=$(node -e 'const {generateBuildNumber}=require("./scripts/lib/version-utils"); console.log(generateBuildNumber(new Date(), 0))')
PREVIOUS_MAX="${PREVIOUS_MAX}" REBUILD_BUILD_NUMBER="${REBUILD_BUILD_NUMBER}" node -e 'const {assertBuildNumberGreater}=require("./scripts/lib/version-utils"); assertBuildNumberGreater(process.env.REBUILD_BUILD_NUMBER, process.env.PREVIOUS_MAX); console.log(`build number ok: ${process.env.REBUILD_BUILD_NUMBER} > ${process.env.PREVIOUS_MAX}`)'

RELEASE_TAG="v${UPSTREAM_VERSION}-rebuild.${REBUILD_BUILD_NUMBER}"
ZIP_NAME="Codex-rebuild-darwin-arm64-${UPSTREAM_VERSION}-${REBUILD_BUILD_NUMBER}.zip"
REBUILD_RELEASE_URL="https://github.com/itstarts/codex-app-rebuild/releases/download/${RELEASE_TAG}/${ZIP_NAME}"

REBUILD_BUILD_NUMBER="${REBUILD_BUILD_NUMBER}" npm run build:mac-arm64

SPARKLE_SIGN_UPDATE="${SPARKLE_SIGN_UPDATE}" \
SPARKLE_PRIVATE_KEY_FILE="${SPARKLE_PRIVATE_KEY_FILE:-}" \
SPARKLE_PRIVATE_KEY="${SPARKLE_PRIVATE_KEY:-}" \
REBUILD_BUILD_NUMBER="${REBUILD_BUILD_NUMBER}" \
REBUILD_SHORT_VERSION="${UPSTREAM_VERSION}" \
REBUILD_UPSTREAM_BUILD="${UPSTREAM_BUILD}" \
REBUILD_ZIP_PATH="out/release/${ZIP_NAME}" \
REBUILD_RELEASE_URL="${REBUILD_RELEASE_URL}" \
npm run appcast
test -s "out/release/appcast-darwin-arm64.xml"
npm run verify:static

mkdir -p out/verify
# 用发布产物 out/mac-arm64/Codex-rebuild.app 捕获 Fast 请求体并保存为 out/verify/fast-request.json
# 用发布产物 out/mac-arm64/Codex-rebuild.app 捕获 Standard 请求体并保存为 out/verify/standard-request.json
test -s out/verify/fast-request.json
test -s out/verify/standard-request.json
npm run verify

if gh release view "${RELEASE_TAG}" --repo itstarts/codex-app-rebuild >/dev/null 2>&1; then
  gh release upload "${RELEASE_TAG}" \
    "out/release/${ZIP_NAME}" \
    "out/release/appcast-darwin-arm64.xml" \
    --repo itstarts/codex-app-rebuild \
    --clobber
  gh release edit "${RELEASE_TAG}" \
    --repo itstarts/codex-app-rebuild \
    --draft=false \
    --latest
else
  gh release create "${RELEASE_TAG}" \
    "out/release/${ZIP_NAME}" \
    "out/release/appcast-darwin-arm64.xml" \
    --repo itstarts/codex-app-rebuild \
    --title "${RELEASE_TAG}" \
    --notes "Codex-rebuild ${UPSTREAM_VERSION} (${REBUILD_BUILD_NUMBER})" \
    --latest
fi

curl -fL "https://github.com/itstarts/codex-app-rebuild/releases/latest/download/appcast-darwin-arm64.xml" \
  -o /tmp/codex-rebuild-appcast.xml
grep "${REBUILD_BUILD_NUMBER}" /tmp/codex-rebuild-appcast.xml
grep "${ZIP_NAME}" /tmp/codex-rebuild-appcast.xml
```

如果 `PREVIOUS_MAX` 查询失败且这是首次个人发布，先人工确认不存在已发布的 rebuild 版本，再设置一个低于候选值的 `REBUILD_PREVIOUS_MAX_BUILD_NUMBER` 重新运行构建号解析与校验命令。若候选值不大于已发布最大值，等待下一秒重新生成，或显式设置更大的 `REBUILD_BUILD_NUMBER`。

## 运行时证据与验证

`npm run verify:static` 是自动发布上传前的强制静态门禁，不依赖请求抓包文件；它验证应用身份、ASAR、三模块 updater 组合哈希、Sparkle/appcast、codesign 和构建号。`npm run verify` 在相同静态检查之外，还要求运行时请求证据存在：

- `out/verify/fast-request.json`
- `out/verify/standard-request.json`

用发布产物 `out/mac-arm64/Codex-rebuild.app` 启动应用，通过本地 mock、代理日志或等价请求捕获方式分别触发 Fast 与 Standard 请求。保存给 verifier 的 JSON 顶层必须包含 `service_tier`、`serviceTier` 或 `tier` 字段；Fast 文件的值为 `fast` 或上游 Fast 等价值，Standard 文件的值为 `standard`，或保持上游 Standard 等价空值。当前上游 Fast 等价值为 `priority`。

```bash
set -euo pipefail

mkdir -p out/verify
# 将发布产物的 Fast 请求体保存为 out/verify/fast-request.json
# 将发布产物的 Standard 请求体保存为 out/verify/standard-request.json
test -s out/verify/fast-request.json
test -s out/verify/standard-request.json

npm run verify
```

## 旧版安装与 In-App Update 验证

1. 从 GitHub Releases 下载上一个已发布版本的 `Codex-rebuild-darwin-arm64-*.zip`，解压并安装到测试位置。
2. 启动旧版 `Codex-rebuild.app`，确认 About 面板和当前 build number 是旧版本。
3. 通过 app 内更新入口检查更新，确认读取 latest `appcast-darwin-arm64.xml` 后发现本次 `REBUILD_BUILD_NUMBER`。
4. 执行更新安装。ad-hoc 或自签产物可能触发 Gatekeeper、quarantine、权限确认或密码输入，按系统提示确认。
5. 重新启动后确认 bundle id 仍为 `io.github.itstarts.codex-rebuild`，app 名仍为 `Codex-rebuild`，feed URL 仍指向 GitHub latest appcast，`CFBundleVersion` 等于本次 `REBUILD_BUILD_NUMBER`。
