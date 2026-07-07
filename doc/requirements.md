# Codex Rebuild 个人可用版需求文档

## 目标

构建一个仅面向个人使用的 macOS 版 `Codex-rebuild.app`。实现方式参考 `Haleclipse/CodexDesktop-Rebuild` 的官方包下载、ASAR 解包、AST/结构化 patch、ASAR 重包、完整性 hash 更新和重新签名流程，但当前阶段只保留用户明确需要的功能改动。

产物必须满足：

- 固定 app 名：`Codex-rebuild.app`
- 固定 bundle id：`io.github.itstarts.codex-rebuild`
- 当前阶段只支持 macOS arm64
- 保留 Codex app 内部更新入口，点击更新时下载并安装本项目发布的重构版本
- 不依赖 Apple Developer ID；默认使用 ad-hoc codesign，允许配置本机自签证书
- 支持每次更新时由 macOS 提示用户输入密码或确认权限

## 范围

### 必须实现

1. About 面板版权文字修改
   - 将 About 面板中的版权文字改为：`© OpenAI · itstarts Rebuild`
   - 修改必须仅影响展示文字，不改变关于面板其他行为。

2. Fast mode 门控修改
   - 解除客户端对 `fast_mode` 的认证方式限制。
   - 目标行为：当 UI 选择 Fast 时，后台请求发送 Fast；当 UI 选择 Standard 时，后台请求发送 Standard。
   - patch 必须覆盖 UI 可见性门控和请求参数传递路径。
   - 不要求保证服务端接受 Fast；服务端返回错误时由原 Codex 错误处理逻辑展示。

3. 插件和能力门控修改
   - 参考 `CodexDesktop-Rebuild` 的 `patch-plugin-auth.js`。
   - 目标功能包括：
     - 插件 auth gate
     - browser use
     - computer use
     - `/goal` slash command
     - 相关 Statsig feature gate
   - 允许修改上述能力直接依赖的默认 feature values、bundled plugin availability filter、`features.js_repl` 和 browser-use native peer authorization。
   - 不允许修改 i18n、DevTools、archive delete、sunset gate、GPU、updater disable 等未列功能。

4. 自有更新通道
   - 保留 Codex 内部更新按钮和更新流程。
   - 将官方更新 feed 改为本项目 mac-arm64 固定 feed：
     `https://github.com/itstarts/codex-app-rebuild/releases/latest/download/appcast-darwin-arm64.xml`
   - 将官方 Sparkle public key 改为本项目固定 public key。
   - Sparkle public key 的唯一可信来源为仓库内跟踪文件 `config/sparkle/public-ed-key.txt`。
   - `config/sparkle/public-ed-key.txt` 必须在首次发布前生成并提交；构建时该文件不存在或为空必须失败。
   - 每次发布更新包时用同一 Sparkle private key 对更新包签名。
   - Sparkle private key 不得提交到仓库。
   - 更新包可以使用 `.zip` 或 `.dmg`；优先 `.zip`，因为 Sparkle 对 app zip 更新路径更直接。

5. macOS 打包和签名
   - 从官方 macOS Codex 包同步资源。
   - 解包并 patch `app.asar`。
   - 重包后更新 `Info.plist` 中的 `ElectronAsarIntegrity.Resources/app.asar.hash`。
   - 修改 `CFBundleIdentifier` 为 `io.github.itstarts.codex-rebuild`。
   - app bundle 目录名必须为 `Codex-rebuild.app`。
   - `CFBundleName` 和 `CFBundleDisplayName` 必须为 `Codex-rebuild`。
   - 当前阶段保留 `CFBundleExecutable` 为上游值 `Codex`，不重命名 `Contents/MacOS/Codex`。
   - 嵌套 helper app 的 bundle id 必须改到 `io.github.itstarts.codex-rebuild` 命名空间下，避免和官方 Codex helper 冲突。
   - 默认使用 `codesign --sign - --force --deep` 进行 ad-hoc 签名。
   - 允许通过环境变量指定本机自签证书身份。

6. 版本发布
   - 能检测 OpenAI 官方 macOS Codex 最新版本。
   - 能基于官方最新版本生成本项目版本产物。
   - `CFBundleShortVersionString` 必须等于上游 Codex 版本，例如 `26.623.101652`。
   - `CFBundleVersion` 必须等于本项目单调递增构建号 `REBUILD_BUILD_NUMBER`。
   - `sparkle:version` 必须等于 `CFBundleVersion`。
   - `REBUILD_BUILD_NUMBER` 使用固定宽度 UTC 时间序列 `YYYYMMDDHHMMSSNN`，其中 `NN` 为同一秒内的两位递增序号，普通构建使用 `00`。
   - 后续构建号必须按数值比较严格大于已发布最大构建号；如果当前时间生成的候选值不大于已发布最大值，构建必须失败并提示等待下一秒或显式指定更大的 `REBUILD_BUILD_NUMBER`。
   - 已发布最大构建号的来源优先级为：当前发布 feed 中最大的 `sparkle:version`、GitHub Releases 中已发布 appcast 的最大 `sparkle:version`、人工传入的 `REBUILD_PREVIOUS_MAX_BUILD_NUMBER`。
   - `sparkle:shortVersionString` 必须等于 `CFBundleShortVersionString`。
   - 生成 appcast 时必须包含：
     - 版本号
     - 短版本号
     - 下载 URL
     - 文件大小
     - Sparkle EdDSA 签名
     - 最低系统版本字段，如官方 appcast 可获取则沿用官方值
     - `sparkle:hardwareRequirements`，值必须约束为 arm64 可用硬件

### 不在当前阶段实现

- Windows 和 Linux 构建
- macOS x64 构建
- universal app 构建
- Apple Developer ID 签名
- notarization
- 自动静默安装
- 修改 i18n 门控
- 强制开启 DevTools
- 归档会话删除按钮
- 替换官方 CLI 为 `@cometix/codex`
- 公开分发支持

## 功能需求

### R1. 官方资源同步

- 系统必须从官方 macOS arm64 appcast 获取版本信息。
- 系统必须下载官方 `Codex.app` 包并提取 `Contents/Resources/app.asar`。
- 系统必须保留官方 `app.asar.unpacked` 和必要资源文件。
- 下载失败时必须停止构建并输出失败原因。

### R2. Patch 执行

- Patch 必须作用于解包后的 ASAR 内容，而不是直接对原始 `app.asar` 做二进制替换。
- Patch 必须支持 dry-run/check 模式，输出匹配位置和替换摘要。
- Patch 必须尽量使用 AST 或结构化匹配。
- Patch 找不到目标时必须失败，除非该 patch 明确支持“上游已移除该门控”的可验证判定。
- Patch 执行后必须重新 pack `app.asar`。

### R3. Fast mode 行为

- 构建后的 app 必须在非 ChatGPT authMethod 下显示 Fast/Standard 速度选项。
- UI 当前选择为 Fast 时，请求层必须发送 `service_tier` 或上游当前等价字段为 `fast`，或保持上游 Fast 等价值；当前上游 Fast 等价值为 `priority`。
- UI 当前选择为 Standard 时，请求层必须发送 `service_tier` 或上游当前等价字段为 `standard`，或保持官方 Standard 等价行为。
- 如果上游字段名变化，patch 必须失败并提示人工复核。
- 验证必须包含一次可观察请求检查：通过本地 mock API、代理日志或等价请求捕获机制分别证明 Fast 和 Standard 两种选择产生不同的请求 tier。

### R4. 插件和能力门控行为

- 构建后的 app 必须解除插件 auth gate 对非 ChatGPT 认证方式的阻断。
- 构建后的 app 必须使 browser use、computer use 的客户端可用性检查返回可用。
- 构建后的 app 必须使 `/goal` slash command 在本地模式下可用。
- 构建后的 app 必须绕过上述能力依赖的 Statsig gate。
- 构建后的 app 必须使上述能力依赖的默认 feature values 返回 true。
- 构建后的 app 必须保留 bundled plugin descriptor，但允许绕过 `isAvailable` 过滤以纳入 browser/computer 相关插件。
- 构建后的 app 在 ad-hoc 或自签签名下必须绕过 browser-use native peer authorization 对 OpenAI Team ID 的硬编码检查。
- 该功能不保证后端或账号权限支持；服务端拒绝时由原错误链路处理。

### R5. About 面板

- 构建后的 app About 面板必须显示 `© OpenAI · itstarts Rebuild`。
- 如果上游 About 面板结构变化导致找不到目标字段，构建必须失败。

### R6. 自有更新流程

- 构建后的 app 必须包含 Sparkle 更新器。
- 构建流程必须使用精简 patch manifest，只包含当前需求列出的 patch。
- 构建流程不得执行禁用 updater 的 patch。
- 构建后的 app 必须使用本项目 feed URL。
- 构建后的 app 必须使用 `config/sparkle/public-ed-key.txt` 中的 Sparkle public key 验证更新包。
- 发布流程必须使用固定 Sparkle private key 生成 appcast enclosure 的 `sparkle:edSignature`。
- 发布流程必须生成 `appcast-darwin-arm64.xml`。
- 用户点击更新按钮后，允许系统弹出权限确认或密码输入。
- 更新成功后，新 app 仍必须保持同一 bundle id、app 名、feed URL、Sparkle public key、`CFBundleVersion` 递增策略。
- 静态验证必须证明 `shouldIncludeSparkle` 和 `shouldIncludeUpdater` 没有被 patch 成固定 false。

### R7. 签名和安全边界

- 默认 ad-hoc 签名只承诺个人本机可用。
- 自签证书模式只承诺已信任该证书的本机可用。
- 构建脚本不得提交 Sparkle private key、证书私钥、Apple 账号信息或 GitHub token。
- 构建日志不得打印私钥内容。
- 产物未 notarize 时，文档必须说明首次打开和更新后可能出现 Gatekeeper、Keychain、quarantine 提示。
- `codesign --verify --deep --strict` 必须通过；Gatekeeper/quarantine 提示只作为运行时限制记录，不作为签名验证失败的替代说明。

## 非功能需求

- 最小变更：只引入当前功能需要的 patch。
- 可追踪：每个 patch 脚本必须输出命中的文件、规则名和替换数量。
- 可回滚：构建流程必须先复制官方 app 到输出目录，再修改复制件。
- 可复现：构建依赖必须固定在 lockfile 中；运行时动态下载的第三方工具必须固定版本或写入校验策略。
- 可验证：每次构建必须至少执行静态验证，包括 bundle id、app 名、可执行文件名、helper bundle id、About 文案、feed URL、Sparkle public key、ASAR integrity hash、codesign 状态、updater 未禁用状态。

## 验收标准

- `Codex-rebuild.app` 可以从输出目录启动。
- `test -d out/mac-arm64/Codex-rebuild.app` 成立。
- `plutil` 检查 `CFBundleIdentifier` 为 `io.github.itstarts.codex-rebuild`。
- `plutil` 检查 `CFBundleName` 和 `CFBundleDisplayName` 为 `Codex-rebuild`。
- `plutil` 检查 `CFBundleExecutable` 为 `Codex`，且 `Contents/MacOS/Codex` 存在并可执行。
- `plutil` 检查所有 helper app 的 bundle id 均以 `io.github.itstarts.codex-rebuild` 开头。
- `plutil` 检查更新 feed 指向 `https://github.com/itstarts/codex-app-rebuild/releases/latest/download/appcast-darwin-arm64.xml`。
- `plutil` 检查 `SUPublicEDKey` 等于 `config/sparkle/public-ed-key.txt` 的内容。
- `plutil` 检查 `CFBundleVersion` 等于本次 `REBUILD_BUILD_NUMBER`，且 `CFBundleShortVersionString` 等于上游 Codex 版本。
- `strings` 或 ASAR 解包检查可证明 About 文案为 `© OpenAI · itstarts Rebuild`。
- dry-run 能显示 Fast mode、插件能力和更新 feed patch 的命中摘要。
- 可观察请求检查能证明 Fast 请求发送 `fast` 或上游 Fast 等价值，Standard 请求发送 `standard` 或上游 Standard 等价值。
- 静态检查能证明 `shouldIncludeSparkle` 和 `shouldIncludeUpdater` 没有被替换为固定 false。
- `codesign --verify --deep --strict` 对 ad-hoc 或自签产物返回成功。
- 生成的 `appcast-darwin-arm64.xml` 包含更新包 URL、length、`sparkle:version`、`sparkle:shortVersionString`、`sparkle:edSignature` 和 arm64 `sparkle:hardwareRequirements`。
- 使用同一 Sparkle key 连续生成两个版本时，旧版 app 能发现新版更新。
- 使用构建号 `YYYYMMDDHHMMSS01` 发布后，后续构建号 `YYYYMMDDHHMMSS02` 或下一秒 `YYYYMMDDHHMMSS00` 必须被验证为更高版本。
- 当已发布最大构建号为 `YYYYMMDDHHMMSS01` 时，候选构建号 `YYYYMMDDHHMMSS01` 和更小值必须被验证为构建失败。

## 风险和限制

- 无 Apple Developer ID 时，Gatekeeper 和 Keychain 提示属于预期限制。
- ad-hoc 签名下 Sparkle 安装阶段可能受系统策略影响；必要时切换为本机自签证书。
- 上游 Codex 代码经过压缩和拆分，patch 规则可能随版本变化失效。
- 客户端门控解锁不代表服务端支持相关能力。
- 使用 GitHub Releases 的 `latest/download` URL 时，appcast 指向最新文件；旧版本回滚需要单独发布固定版本 feed。
- 当前阶段只支持 arm64；x64 或 universal app 需要新增架构选择、产物命名和 appcast 策略后再实施。

## 文档和评审要求

- 本需求文档、设计文档和发布流程文档均保存在仓库内 `doc/` 目录。
- 影响发布链路、密钥处理、更新通道或 patch 行为的文档变更需要经过独立评审。
- 评审关注正确性、最小变更、更新链路、签名边界、密钥安全、上游版本漂移和验收可测性。
- 评审发现高风险问题时必须修订文档并复审。
- 仅当复审不存在 P0/P1/P2 问题时，该文档视为通过。
