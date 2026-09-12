# AIO 构建与打包规则

# 首要规则：
## 和用户对话永远使用中文，无论用户用什么语言询问
## 思考模式的语言也要求是中文

## 一键构建入口

本地打包统一使用仓库根目录的：

```bat
build-aio.cmd
```

该入口会调用：

```text
scripts/build-aio-package.ps1
```

默认使用工作区内的完整 profile seed：

```text
temp\build-inputs\aio-1.2.0-public-seed
```

如果该目录不存在，或需要使用其他审核后的 seed，必须显式传入：

```bat
build-aio.cmd -ProfileSeedDir "D:\reviewed\profile-seed"
```

需要指定 Node 工具链时：

```bat
build-aio.cmd -NodeHome "D:\node-v24.19.0-win-x64"
```

需要执行隔离安装、首启和卸载验收时：

```bat
build-aio.cmd -Verify
```

`-Verify` 会临时安装到系统临时目录，并在验收后静默卸载。默认打包不会安装到系统。

需要忽略项目构建缓存、完整重编译时：

```bat
build-aio.cmd -Clean
```

`-Clean` 设置 `AIO_CLEAN_BUILD=1`，跳过全部缓存、重建原生模块并 `cargo clean --release`。与 `-Verify` 可组合。

## 构建脚本执行顺序

`scripts/build-aio-package.ps1` 按以下顺序执行：

1. 检查 Node/npm，并优先使用 `temp\toolchain\node-v24.19.0-win-x64`。
2. 根依赖、Tauri 依赖、内置 Node/npm 或 `fs-ext` 缺失时自动补齐。
3. 统一校验 `package.json`、`tauri-app/package.json`、`tauri-app/tauri.conf.json`、`tauri-app/Cargo.toml` 版本一致。
4. `-Clean` 时对 release 目标执行 `cargo clean`。
5. `-FullTest` 时先 `prepare-test-fixtures.mjs`，再编译 sidecar、跑全量 JS 测试与 `cargo test --locked`。
6. 调用 `npm --prefix tauri-app run bundle`；其 `beforeBuildCommand` 触发唯一准备入口 `scripts/prepare-aio.mjs`（icon → inject → sidecar → seed-review → native → staging → 受控种子补丁，逐阶段内容指纹缓存）。staging 后由 `scripts/seed-kernel-patches.mjs` 给打包副本打受控种子补丁：DeepSeek 模型原生识图默认开（模型条目同时接受 `input` 与 `inputModalities`，Flash 声明 `image`）、`dsh-webui` 辅助视觉自动降级默认关（图片交给原生模型解析，不再转写文本）。补丁作用于 `resources/profile-seed` 与 `resources/app`（安装闭包 `node_modules`）两处：实例按安装闭包解析 `@deepseek-ai/*`，只打种子副本会导致「补丁已打、实例未生效」；不改上游快照。
7. 执行 Tauri/NSIS 打包，生成单文件安装器。
8. 复制安装器到临时输出并生成便携 ZIP。
9. 计算顶层/便携包 SHA-256 与 `build-provenance.json`。
10. 原子地移动到 `dist`（失败不留下可误认为成功的新产物）。
11. 仅在传入 `-Verify` 时运行安装器 E2E。

`npm run dist`（`scripts/build-aio-release.ps1`）等价于 `-FullTest`。

## 输出产物

```text
dist\DSHEAC-AIO-v<version>-Setup-x64.exe
dist\portable\DSHEAC-AIO-v<version>-Portable-x64.zip
dist\SHA256SUMS.txt
dist\portable\SHA256SUMS.txt
dist\build-provenance.json
```

`Setup-x64.exe` 是可直接分发的单文件 NSIS 安装器。便携 ZIP 不是安装器的运行依赖。`build-provenance.json` 记录提交、源码内容指纹与产物哈希，供 `verify-dist-fresh.js` 做内容级新鲜度校验。

## 验证要求

打包后至少核对：

- `dist\DSHEAC-AIO-v<version>-Setup-x64.exe` 存在且哈希与 `dist\SHA256SUMS.txt` 一致。
- `dist\portable\DSHEAC-AIO-v<version>-Portable-x64.zip` 包含：
  - `DSHEAC AIO.exe`
  - `.dsh-portable`
  - `resources\node\node.exe`
  - `resources\profile-seed\profiles\web-desktop\package.json`
- 传入 `-Verify` 时，`verification\verification-*.json` 的 `result` 必须为 `PASS`。
- 安装器 E2E 必须确认：安装、首启、HTTP 健康检查、卸载、进程/端口/目录/注册表残留检查全部通过。

相关专项验证：

```powershell
npm --prefix tauri-app run sidecar:check
npm --prefix tauri-app run sidecar:build
node scripts\prepare-test-fixtures.mjs
node --test --test-concurrency=1 test\*.test.mjs
cargo test --locked --manifest-path tauri-app\Cargo.toml
node scripts\verify-dist-fresh.js
```

`prepare-test-fixtures.mjs` 需要 `DSH_PROFILE_SEED_DIR` 指向完整 seed，并会校验 `test\fixtures\manifest.json` 声明的摘要后物化 `temp\test-fixtures`。

## 构建输入发布

本地生成完整构建输入包（供其他机器或手动触发的 workflow 复用）：

```powershell
npm run build-inputs:package
```

默认输出到 `dist\build-inputs`：

- `DSHEAC-AIO-build-inputs-v<version>.zip`
- `DSHEAC-AIO-build-inputs-v<version>.zip.sha256`
- `build-inputs-manifest.json`

`.github/workflows/aio-build.yml` 已移除 `push: tags` 触发，只在手动 `workflow_dispatch` 时运行：按 Release 资产身份与 SHA-256 下载或复用构建输入、复用 Cargo 缓存，构建后执行 `verify-dist-fresh.js`，再上传安装器/便携包/哈希/provenance。常规发版走下面的本地流程。

## 发行发布（本地打包 + 手动上传）

发版不依赖 GitHub Actions：tag 只作版本标记，`.github/workflows/aio-build.yml` 不再由 tag 触发，
发行流程全部在本地完成。

1. 先落版，再构建（否则 `build-provenance.json` 的 `commit` 与产物对不上）。需要同步：
   - `package.json`、`package-lock.json`、`tauri-app/package.json`、`tauri-app/package-lock.json`、`tauri-app/tauri.conf.json`、`tauri-app/Cargo.toml`、`tauri-app/Cargo.lock`（只改本产品包对应的那一条，别碰依赖中的同名版本）；
   - `sidecar/src/lib/profile-seed-migration.ts`、`sidecar/src/lib/profile-upgrade.ts`、`sidecar/src/shell-host.ts`；
   - `test/lite-manifest.test.mjs`、`test/profile-upgrade.test.mjs`；
   - `README.md`、`docs/BUILDING.md`，以及 `CHANGELOG.md` 把 `[Unreleased]` 落成 `[<version>]`（Release 正文取自该中文段落）。
2. 提交落版改动，用 `build-aio.cmd -FullTest` 打包，再执行 `node scripts\verify-dist-fresh.js`。
3. 安装 E2E 单独在 AIO 之外执行（安装器会按进程名强杀正在运行的 `DSHEAC AIO.exe`，在 AIO 内运行会打断当前会话）：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-aio-installer.ps1 -ProjectRoot <仓库根>`。
4. 打 tag 并推送（只作标记，不再触发 CI），然后手动发布 Release（网页 Draft a new release，或 `gh release create`）。资产必须包含 `DSHEAC-AIO-v<version>-Setup-x64.exe`、`DSHEAC-AIO-v<version>-Portable-x64.zip`、`SHA256SUMS.txt`，可选 `build-provenance.json`。
5. 客户端应用内更新按资产名 + `SHA256SUMS.txt` 校验，与是否由 CI 构建无关；若使用手动触发的 workflow 发布，其正文取自 `CHANGELOG.md` 对应版本的中文段落。

## 已知边界

- 完整测试依赖审核夹具。夹具缺失时 `requireFixture` 会阻断，不能靠跳过获得“全绿”。
- `zod@4.4.3` 官方测试文件的审核哈希以版本、路径、字节明确的 alternate 形式声明在 `scripts/public-seed-reviewed-content.mjs`；不得为绕过失败放宽扫描或永久改写审核哈希。
- 更新事务对安装器 edition 只恢复程序文件与用户数据；NSIS 注册表/快捷方式副作用与 machine-scope 提权尚未做完整回滚，见 `docs/BUILDING.md` 与体检报告。
- 远程更新（应用内更新/覆盖安装）刷新 profile 依赖闭包时必须保留用户设置：`cordis.patch.yml` 等用户文件与用户自装包迁入新 profile，被替换的用户字节另存 `dsh_home\.aio-user-settings-backup\`（健康提交后保留最近一份）；引用已退场包的 patch 行/bundle 由 sidecar 在 dsh 启动前清理，明细留档 `.aio-profile-migration.json`。改动该行为需同步 `tauri-app/src/paths.rs`、`sidecar/src/desktop-core.ts`、`sidecar/src/lib/plugin-manager-patch.ts` 与 `test/patch-prune.test.mjs`。
- 上游 WebUI 代码包含 `D:\AI\Dsh` 相关默认路径文本；公开发布前应单独审计和清理。
- 当前 `setup.exe` 未进行代码签名，Windows SmartScreen 可能提示未知发布者。
- 未获得用户明确授权时，不执行 commit、push、创建 PR、打标签或发布。