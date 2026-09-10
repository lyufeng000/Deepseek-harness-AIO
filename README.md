# DSHEAC AIO v1

`DSHEAC AIO`（**All-in-One**）是基于 DSH-Desktop-EAC `v4.5-lite` 源码基线重构的 Windows x64 一体化桌面发行版。AIO 指安装包整合 Tauri 原生壳、Node.js、npm、`@deepseek-ai/dsh`、当前配套插件和经脱敏的首次运行 profile，目标机器无需预装 Node.js。

> **版型：AIO（All-in-One）**
>
> **用户可见版本：v1**
>
> 机器内部 SemVer：`1.2.3`
>
> 上游 DSH 基线：`0.1.3-alpha.2`，commit `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`

AIO 不表示包含上游项目所有历史功能；实际功能以本仓库打包的运行时、插件和 profile 清单为准。

## 状态

本仓库面向可审计、可重建和隔离验证，不宣称由 DeepSeek 官方发布或背书。`DeepSeek`、`DSH` 及相关名称和标识归其权利人所有。

发布前必须同时通过：

1. 全部 AIO JavaScript 测试；
2. sidecar TypeScript 类型检查；
3. Rust `cargo test --locked`；
4. Tauri/NSIS 构建；
5. 安装、首启、profile 脱敏、共存、卸载及残留验证。

## 功能边界

- Windows 10/11 x64；
- Tauri 2 / WRY / WebView2 原生窗口；
- 内置 Node.js、npm CLI 和 DSH 生产依赖闭包；
- 内置当前插件与技能 profile seed；
- 离线 WebView2 安装器；
- 独立产品标识 `com.deepseek.dsh.desktop.aio`；
- 独立应用数据和 DSH_HOME，不修改原 v4Lite、旧 EAC、5.x 或 CLI 数据；
- 旧版数据导入默认关闭，只有显式设置 `DSH_AIO_IMPORT_LEGACY=1` 才启用；
- 正式发布入口仅为 Tauri；Electron 命令保留在 `legacy:electron:*` 命名空间，不用于 AIO Release。

## 安装

发布产物：

- `dist/DSHEAC-AIO-v1.2.3-Setup-x64.exe`
- `dist/portable/DSHEAC-AIO-v1.2.3-Portable-x64.zip`
- `dist/SHA256SUMS.txt`、`dist/portable/SHA256SUMS.txt`
- `dist/build-provenance.json`

安装包目前未签名。Windows SmartScreen 可能提示未知发布者；运行前请核对 SHA-256。

## 客户端更新

- 更新源固定为 `lyufeng000/Deepseek-harness-AIO` 的 GitHub Releases，仅接受正式的 `vX.Y.Z` 应用版本，排除草稿、预发布和 `build-inputs-*`。
- 启动就绪后延迟检查一次，最多自动提示一次；弹窗提供「更新 / 取消 / 不再通知」。「不再通知」永久关闭自动检查，但手动「检查更新」始终可用。
- 安装版下载 `Setup-x64.exe`；便携版下载 `Portable-x64.zip` 并在同盘替换。下载到系统下载目录的 `DSHEAC-AIO\<版本>` 子目录，展示进度，支持取消、重试与 `.part` Range 续传。
- 固定 HTTPS 来源与合法跳转，核对资源大小、SHA-256 与 GitHub digest；摘要缺失或不匹配、版本/架构不符都停止安装。
- 安装使用独立原生更新助手，主程序在助手接管后才退出；安装前备份程序与用户数据，失败按事务日志回滚。配置迁移可恢复，用户会话、凭据、自建插件和配置不被覆盖。

## 从源码构建

详见 [BUILDING.md](docs/BUILDING.md)。标准命令：

```powershell
build-aio.cmd                 # 复用有效缓存
build-aio.cmd -Clean          # 完整重建
build-aio.cmd -Verify         # 构建后执行安装/首启/卸载验收
npm run dist                  # 全量测试 + 构建
```

## 安装验证

```powershell
powershell -NoProfile -File .\scripts\verify-aio-installer.ps1
```

验证会安装到包含中文和空格的独立目录，使用隔离数据启动，确认服务端口属于本轮应用进程树，检查插件/技能 seed 与隐私排除，然后静默卸载并检查进程、端口和安装目录残留。

## 隐私边界

发行 seed 明确排除凭据、会话、记忆、附件、浏览器 profile、日志、usage 数据，以及原用户模型/provider/权限和个人 preset 选择。个人化状态文案已替换为中性公共默认值；构建时 `sanitize-public-seed.mjs` 会删除含本机绝对路径的包管理器状态文件，并全树扫描原工作区、用户目录、`.dsh-v4lite` 与 pnpm store 痕迹。上传前仍需人工复核。

## 本轮工程改进

- 产品名统一为 `DSHEAC AIO`，用户版本统一为 `v1`，当前内部 SemVer 为 `1.2.3`；
- 新增客户端整包更新（版本发现、通知偏好、下载校验、事务安装与回滚），与插件/内核更新源独立；
- 安装脚本不再按映像名强杀进程，改为比对实际 `ExecutablePath` 与目标安装目录并按进程树结束；
- 构建统一到 `build-aio.cmd`，sidecar 编译/原生模块/seed 审核/资源装配每轮只执行一次并带内容指纹缓存；
- 构建输入按 Release 资产身份与 SHA-256 校验复用；发布产物带 `build-provenance.json`，新鲜度按内容指纹校验；
- 测试夹具脱离历史盘符，统一声明来源、版本与摘要，落在 `temp/test-fixtures` 并由脚本/CI 准备；
- 修复 Node `fs.cpSync` 在当前中文长路径工作区中以 `0xC0000409` 崩溃；
- staging 仅对发布树裁剪 `.map`、`.pdb` 和 ARM64 预编译件；
- 停用可读取任意绝对路径、且无调用方的壳层预览端口；
- DSH Web UI 只在刚启动子进程输出 ready URL 后建立可信 origin；
- Tauri IPC 统一执行“main 窗口 + 运行时受信 origin”校验；
- 外链不再拼接 PowerShell 命令；
- 发布构建不再排除关键测试，并加入产物新鲜度与哈希复核；
- 安装验证增加 Unicode 路径、耗时、进程树端口归属、卸载与残留检查。

## 性能说明

AIO profile seed 包含大量小文件，安装时仍会受到磁盘和杀毒软件逐文件扫描影响。热构建准备（sidecar、seed 审核、原生模块、staging 全部缓存命中）本地实测约 40 秒，主要成本是内容指纹校验；冷 staging 首次装配约 419 秒。便携 ZIP 在 `Fastest`（163 MB / 10.7s）与 `Optimal`（147 MB / 14.4s）之间选择了发布总耗时更短的 `Fastest`。最终安装速度仍以本机正式安装包 E2E 计时为准。

## 文档

- [BUILDING.md](docs/BUILDING.md)
- [SECURITY.md](SECURITY.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [AUDIT.md](docs/AUDIT.md)

## 许可证

项目基线沿用 MIT License，见 [LICENSE](LICENSE)。第三方运行时、依赖、插件、皮肤和资源各自适用其原许可证；MIT 不自动覆盖第三方内容。
