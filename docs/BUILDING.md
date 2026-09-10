# 构建 DSHEAC AIO

## 支持范围

- Windows 10/11 x64
- PowerShell 5.1+
- Node.js / npm（仅构建机，优先使用 `temp\toolchain\node-v24.19.0-win-x64`）
- Rust stable + MSVC x64 工具链
- Windows SDK 与 Visual Studio C++ Build Tools
- 可访问 npm、Cargo 与 Tauri/NSIS/WebView2 构建资源的网络环境；依赖已缓存时可部分离线

版型为 `AIO`（All-in-One）。当前内部 SemVer 为 `1.2.0`，与 `package.json`、`tauri-app/package.json`、`tauri-app/tauri.conf.json`、`tauri-app/Cargo.toml` 必须一致，`build-aio-package.ps1` 会在构建前校验。

## 统一构建入口

所有本地打包都走仓库根目录的 `build-aio.cmd`，它调用 `scripts/build-aio-package.ps1`：

| 命令 | 用途 |
| --- | --- |
| `build-aio.cmd` | 复用有效缓存，生成安装器、便携包和哈希 |
| `build-aio.cmd -Verify` | 构建后执行隔离安装、首启、卸载验收 |
| `build-aio.cmd -Clean` | 忽略项目构建缓存，完整重新构建 |
| `build-aio.cmd -Clean -Verify` | 干净构建与完整分发验收 |

可组合参数：

- `-ProfileSeedDir <dir>`：指定审核后的完整 profile seed；缺省为 `temp\build-inputs\aio-1.2.0-public-seed`。
- `-NodeHome <dir>`：指定构建用 Node 工具链目录。

npm 脚本与入口保持一致：

```powershell
npm run dist              # 等价 build-aio.cmd -FullTest（先全量测试再打包）
npm run build:native      # 单独构建原生模块（带缓存）
npm run seed:sanitize     # 对 DSH_PROFILE_SEED_DIR 做隐私扫描与脱敏
npm run build-inputs:package
npm run build-inputs:verify
```

## 准备流水线与缓存

Tauri 的 `beforeBuildCommand` 是 `npm run prepare:bundle`，它调用唯一的准备编排脚本 `scripts/prepare-aio.mjs`。每个阶段都由 `scripts/build-cache.mjs` 记录输入/输出内容指纹：

1. `icon`：同步应用图标。
2. `inject`：编译 `frontend/chrome.ts` → `src/inject/chrome.js`（内容不变则不重写）。
3. `sidecar`：`tsc -p sidecar/tsconfig.json` 编译 sidecar 运行时。
4. `seed-review`：`sanitize-public-seed.mjs` 对完整 seed 做隐私扫描与脱敏。
5. `native`：`build-native-runtime.mjs` 构建 `fs-ext`（自带 Node ABI、源码、补丁与编译选项指纹缓存）。
6. `staging`：`tauri-app/scripts/stage.ts` 装配 `tauri-app/resources`；随后对打包副本执行受控种子补丁 `scripts/seed-kernel-patches.mjs`（把 `dsh-llm-deepseek` 模型默认 `inputModalities` 改为 `["text","image"]`，使实时发现的新模型默认识图）。补丁只作用于 `tauri-app/resources/profile-seed`，不改上游审核快照，幂等且参与 staging 缓存指纹。

缓存命中判定基于内容指纹（含脚本自身、依赖锁文件、seed、原生模块源码与工具链元数据），命中后仍会校验输出内容；不依赖目录存在或时间戳。缓存状态写入 `temp/build-cache/*.json`，耗时写入 `temp/build-metrics/prepare.json`。

`-Clean` 会设置 `AIO_CLEAN_BUILD=1`：忽略全部缓存、重新构建原生模块，并对 release 目标执行 `cargo clean`。

构建输入按 Release 资产身份与 SHA-256 定位：CI 与本地都会核对归档摘要，命中后验证再用，不每次删除重下载。

## 构建输入

- 完整 profile seed：`temp\build-inputs\aio-1.2.0-public-seed`（或 `-ProfileSeedDir`）。
- 内置 Node/npm：`vendor\node`、`vendor\npm`（缺失时由 `npm run fetch-runtime` 补齐）。
- 审核归档与测试夹具：`test\fixtures\`（`scripts/prepare-test-fixtures.mjs` 物化到 `temp\test-fixtures`，需要 `DSH_PROFILE_SEED_DIR`）。

## 产物

```text
dist/
├── DSHEAC-AIO-v1.2.0-Setup-x64.exe          # NSIS 单文件安装器
├── SHA256SUMS.txt                            # 顶层哈希清单
├── build-provenance.json                     # 来源提交、输入摘要、产物哈希
└── portable/
    ├── DSHEAC-AIO-v1.2.0-Portable-x64.zip    # 便携包（非安装依赖）
    └── SHA256SUMS.txt
```

`build-provenance.json` 记录构建提交、`sourceFingerprint`（tracked + 未跟踪未忽略源码）、`resources` staging 指纹与每个产物的 SHA-256。`scripts/verify-dist-fresh.js` 优先按该内容指纹校验新鲜度，缺少 provenance 时才退回 mtime 判定。

## 验收

- 打包后核对 `dist\DSHEAC-AIO-v1.2.0-Setup-x64.exe` 存在且哈希与 `dist\SHA256SUMS.txt` 一致。
- 便携 ZIP 必须包含 `DSHEAC AIO.exe`、`.dsh-portable`、`resources\node\node.exe`、`resources\profile-seed\profiles\web-desktop\package.json`。
- `-Verify` 会调用 `scripts/verify-aio-installer.ps1`：安装到含中文/空格的独立目录，隔离数据首启，确认服务端口属于本轮进程树，检查 seed 隐私排除，静默卸载并检查进程/端口/目录/注册表残留。报告写入 `verification\verification-*.json`，`result` 必须为 `PASS`。
- `npm run dist`（`build-aio-release.ps1` → `build-aio-package.ps1 -FullTest`）在打包前运行全量 JS 与 Rust 测试，并先执行 `scripts/prepare-test-fixtures.mjs`。

## 性能基准（本地实测）

环境：Windows x64、项目自带 Node v24.19.0、完整 seed `aio-1.2.0-public-seed`。

| 场景 | 观测 |
| --- | --- |
| 冷准备（staging 首次装配） | staging 约 419s |
| 热准备（全部缓存命中） | 总计约 40s（seed-review 约 9s、staging 约 31s） |
| 完整打包（含 Tauri/NSIS，缓存热） | 成功产出安装器与便携包 |

热准备的剩余开销主要是对完整 seed 与 434MB staging 做内容指纹校验（保证缓存有效），而非重复编译或装配。

便携 ZIP 压缩对比（同一 staging，`scripts/package-portable.ps1`）：

| 级别 | 体积 | 耗时 |
| --- | --- | --- |
| `Fastest`（当前默认） | 163 MB | 10.7s |
| `Optimal` | 147 MB | 14.4s |

两者均满足“总体积不增长超过 15%”，`Fastest` 发布总耗时更短，因此保持默认。安装器使用 Tauri/NSIS 默认压缩，未做额外调整。

## 可复现性边界

依赖版本由 npm lockfile 与 `Cargo.lock` 约束，但以下输入仍可能导致字节级安装包不同：

- Rust/LLVM/MSVC/Windows SDK 版本；
- Tauri 下载的 NSIS 与 WebView2 离线安装器版本；
- PE/NSIS 时间戳；
- 未固定哈希的预置 Node/npm/profile seed 二进制树。

当前目标是“功能与 payload 可重建”，不是已证明的字节级 reproducible build。发布者应记录工具链版本，并在独立目录重复构建后比较 `build-provenance.json` 的 `resources` 指纹。

## CI

`.github/workflows/aio-build.yml`（自托管 Windows runner，`concurrency` 串行化）：

1. checkout（`clean: false`，工作树缓存持久）；
2. `Swatinem/rust-cache` 复用 Cargo 工具链与 target；
3. 按 Release 资产身份与 SHA-256 下载或复用构建输入，设置 `PROFILE_SEED_DIR` 并同步 `vendor`；
4. `npm ci` + `npm --prefix tauri-app ci`；
5. `build-aio-package.ps1 -ProfileSeedDir ...`，随后 `verify-dist-fresh.js`；
6. 上传安装器/便携包/哈希/provenance；仅在 `RELEASE_TAG` 非空时用 `softprops/action-gh-release` 发布。

`.github/workflows/aio-validate.yml` 在 PR 上缓存并校验构建输入，执行 `prepare-test-fixtures.mjs`、sidecar 检查/编译、全量 JS 测试、Rust 测试、Skill 校验与空白检查。
