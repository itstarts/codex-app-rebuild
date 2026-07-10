# Codex App Rebuild

[English](README.md) | 简体中文

面向个人 `Codex-rebuild.app` 发布渠道的非官方 macOS arm64 重构建工具链。

本仓库包含脚本、测试和文档，用于对本地下载的 Codex Desktop App 进行重构建，并应用一组范围明确的补丁：

- 将应用标识修改为 `Codex-rebuild.app` / `io.github.itstarts.codex-rebuild`
- 将 Sparkle 更新源指向本仓库的 GitHub Releases
- 调整“关于”面板中的版权字符串
- 修补 Fast 模式和内置能力的部分客户端功能门控
- API Key 主机使用内置模型目录且不受 ChatGPT `available_models` 允许列表限制，因此内置的 GPT-5.6 模型元数据仍可选择

## 重要边界

本项目与 OpenAI 没有关联，也未获得 OpenAI 的认可或支持。`OpenAI`、`Codex` 及相关名称均为其各自所有者的商标或标识。

本仓库仅用于保存重构建自动化，不包含上游 Codex 应用程序包、解压后的 ASAR 内容、生成的 App、发布 zip、私钥、令牌或运行时验证捕获文件。

发布产物基于上游软件生成。在公开发布或向个人许可范围之外共享产物之前，请先审查上游条款、许可证和分发权利。

## 最新版本

从 [GitHub Releases](https://github.com/itstarts/codex-app-rebuild/releases/latest) 下载当前重构建版本。现有安装也通过同一 latest release 中的 `appcast-darwin-arm64.xml` 检查更新。

## API Key 模型选择

使用 API Key 连接时，模型选择器读取 Codex App Server 的内置模型目录。它不会渲染第三方服务商的 `/models` 响应，因此该响应中的 `display_name` 等字段不会控制 App 界面。

本重构建版本会让 API Key 主机继续显示并可选内置的 GPT-5.6 条目，包括 `gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna`，同时保留 App 内置的名称、描述和推理等级元数据。配置的 API 端点仍需接受所选模型 ID；这个客户端模型目录补丁不会为服务端添加模型支持。

补丁边界和数据流请参阅 [doc/design.md](doc/design.md)。

## 环境要求

- Node.js 24+
- 本地构建 App 和代码签名步骤需要 macOS arm64
- 自动签名发布需要配置 GitHub 仓库 secret `SPARKLE_PRIVATE_KEY`
- 本地生成 appcast 需要 Sparkle `sign_update`

## 常用命令

```bash
npm ci
npm test
npm run sync:mac
npm run patch:check
npm run patch
npm run build:mac-arm64
npm run appcast
npm run verify
```

`npm run sync:mac`、`npm run build:mac-arm64` 和 `npm run appcast` 会下载、生成或签名发布材料。仅在确实需要刷新构建时运行这些命令。

## 自动发布流程

`.github/workflows/release-candidate.yml` 每天北京时间 07:00 运行一次。它会检查官方 macOS arm64 appcast；如果当前重构建渠道缺少新的官方更新，workflow 会自动构建、签名、上传并发布 latest GitHub Release。

手动触发支持以下模式：

- `latest-release`：构建并发布为 latest
- `draft-release`：构建并上传到 draft release
- `artifact-only`：仅生成 workflow artifacts，不写入 GitHub Release

## 仓库卫生规则

请勿提交：

- `src/`、`out/`、`.cache/`、`node_modules/`
- `.DS_Store`、日志、截图、运行时请求捕获文件
- `config/sparkle/private-*`、`*.p8`、`*.pem`、`.env*`
- 生成的 `.app`、`.zip` 或 `.dmg` 产物

后续自动化工作的项目级规则请参阅 [AGENTS.md](AGENTS.md)。
