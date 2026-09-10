# DSHEAC AIO 体检与验收报告

本报告记录本轮「客户端更新、全面体检、构建提速、文档统一」的基线、发现、修复与验收结果。所有结论以仓库内实测为准；未验证项单独列出。

环境：Windows x64、项目自带 Node v24.19.0、Rust 1.98.0、完整 seed `temp\build-inputs\aio-1.2.0-public-seed`。

## 一、测试基线

| 检查 | 修改前 | 修改后 |
| --- | --- | --- |
| 全量 JS 测试 | 697 项，655 通过，15 失败，27 跳过 | 751 项，750 通过，0 失败，1 跳过 |
| Rust `cargo test --locked` | 20 通过 | 20 通过 |
| sidecar TypeScript | 通过 | 通过 |
| Skill 校验 | warning | `scriptTests/officialValidator/ciPathCoverage` 全部通过，0 error |
| 根 `npm audit` | 1 high（`js-yaml` 4.0.0–4.3.1） | 0 漏洞 |
| Tauri `npm audit` | 0 | 0 |
| `cargo audit` | 0 vulnerability，存在 unmaintained 警告 | 同上（见残余项） |

唯一跳过项为 `prepare-public-migration-seed.test.mjs` 的离线迁移演练，由 `PUBLIC_MIGRATION_*` 环境变量显式触发，属设计内的 opt-in 验收。

## 二、高优先级发现与修复

### 1. 审核归档指纹过时（安全相关）

- 证据：`scripts/migrate-plugin-interfaces.mjs` 中 `@dsh-external/dsh-webui`、`@ha-na-bi/dsh-client-ui-custom`、`dsh-drag-and-drop` 的审核指纹与 `temp/build-inputs/packages-clean`（即已发布 v1.2.0 seed 的构建输入）不一致，迁移因 “Unreviewed package content” 拒绝写入。
- 判定依据：三个归档的 SHA-256 与已发布 seed 的 `.public-seed-build.json` 完全一致；用真实迁移链产出其 `lib/client.js` 与已发布 seed 逐字节相同。
- 修复：仅更新这三个指纹，并在脚本内注明依据；未放宽任何扫描，未替换归档。
- 验收：`settings-provider-compat`、`migrate-plugin-interfaces` 全部通过。

### 2. 历史测试夹具不可复现

- 证据：多个测试硬编码 `H:/CODEX/...r4|r5|r6` 与工作区外兄弟目录；缺失时以 skip 收场。
- 修复：
  - 新增 `test/fixture-paths.mjs`、`test/fixtures/manifest.json` 与 `scripts/prepare-test-fixtures.mjs`，统一物化到 `temp/test-fixtures`，声明来源/版本/摘要。
  - 7 个审核归档纳入 `test/fixtures/reviewed-plugins/`，WebUI 归档为 `test/fixtures/webui-0.5.1.tgz`。
  - `legacy-seed` 由完整 seed + 归档原始 WebUI 重建，并补回旧架构 `@deepseek-ai/dsh-client-runtime` 兼容模块；`r6` 中间态（已迁移服务、未迁移 prompt-optimize）由真实迁移链反推生成。
- 验收：`migrate-plugin-interfaces` 22/22、`webui-prompt-full-apply` 4/4、`webui-optimizer-visibility` 2/2。

### 3. 构建链路与测试期望脱节

- 证据：`aio-validation-compat` 断言旧的 `taskkill /IM`、`prepare:bundle` 字符串与 PowerShell 哈希实现，与新统一入口不符。
- 修复：断言改为校验新安全属性（按 `ExecutablePath` 定位、失败中止、统一 `prepare-aio.mjs` 顺序、node 侧 SHA-256/provenance）。

### 4. NSIS 安装脚本编译失败

- 证据：`File "${__FILEDIR__}\..\..\assets\..."` 在宏展开时 `__FILEDIR__` 指向 Tauri 生成的 `target/release/nsis/x64`，导致 `no files found`。
- 修复：在 hooks 顶层用 `!define` 于 `!include` 时固化相对路径 `${__FILEDIR__}\..\resources\app\assets\update\stop-installed.ps1`。
- 验收：完整 `build-aio-package.ps1` 成功产出安装器。

### 5. PowerShell 严格模式缺陷

- 证据：`Assert-Child` 使用 ETS 属性 `PSIsContainer`，在 `Set-StrictMode -Latest` 下抛 `PropertyNotFoundStrict`。
- 修复：改用 `-is [IO.DirectoryInfo]` 并加入访问路径集合防止环路。

### 6. 更新事务正确性

- 数据/DSH_HOME 重叠：`DSH_HOME` 默认位于 `userData` 内，原实现会重复备份并在恢复时竞争。现仅在 `DSH_HOME` 不在 `userData` 内时单独备份/恢复。
- 链接策略：程序树仍拒绝链接；用户数据备份新增 `links: 'preserve'`，合法 junction/符号链接按原样保留，`boundedRemove` 只校验祖先为普通路径。
- 接管失败恢复：新增 `ClientUpdater.reset()` 与 `clientUpdate.reset` RPC，Rust 交接失败时调用，避免卡在 `installing`，保留已验证下载可重试。
- 恢复终态保护：修正恢复分支可能被 `launch()` 同步异常改写为 `aborted` 的问题；终态不再被降级。
- 验收：新增 `test/client-update.test.mjs` 与 `test/update-transaction.test.mjs` 共 25 项，含续传、摘要、取消、恢复、路径越界与链接策略。

### 7. 依赖公告

- `js-yaml` 固定在 4.3.1，根 `npm audit` high。加入 override `4.3.2`，`npm audit` 归零，锁文件与 `lite-manifest` 期望同步更新。
- `cargo audit`（cargo-audit v0.22.2，advisory-db 1243 条，2026-09-09）：`tauri-app/Cargo.lock`（528 依赖）**vulnerability = 0**。信息性告警 7 条，逐条判定：

| crate | 类型 | 是否进入 Windows x64 构建图 | 判定 |
| --- | --- | --- | --- |
| `glib` 0.18.5（RUSTSEC-2024-0429） | unsound | 否（`cargo tree --target x86_64-pc-windows-msvc -i glib` 为空） | Linux/GTK 链，不适用 Windows |
| `proc-macro-error` 1.0.4（RUSTSEC-2024-0370） | unmaintained | 否 | 构建期宏依赖，不适用 |
| `unic-char-property` / `unic-char-range` / `unic-common` / `unic-ucd-ident` / `unic-ucd-version` 0.9.0 | unmaintained | 是（`tauri-utils → urlpattern → unic-ucid-ident`） | 仅维护性告警，无 CVE；需上游 `urlpattern`/`tauri-utils` 迁移到 `unicode-ident`/`icu_properties` |

未添加 `.cargo/audit.toml` 忽略项，避免掩盖后续真实告警；这些项以「上游修复依赖」形式保留跟踪。

### 8. PowerShell 5.1 脚本编码缺陷（-Verify 实跑发现）

- 证据：`scripts/verify-aio-installer.ps1` 为 UTF-8 无 BOM，含中文注释；PowerShell 5.1 在本机 ANSI(GBK) 代码页下解码时，注释末尾字节序列吞掉了换行，使 `$version = ...` 被并入注释，`Set-StrictMode` 报 `VariableIsUndefined`，`-Verify` 首次失败。
- 修复：为 `verify-aio-installer.ps1`、`build-icon.ps1` 添加 UTF-8 BOM（其余 `.ps1` 为纯 ASCII，无需处理）。
- 验收：`build-aio.cmd -Verify` 完整通过，报告 `result=PASS`。

## 二·五、`-Verify` 实测结果

`build-aio.cmd -Verify` 于本机通过：

| 阶段 | 结果 |
| --- | --- |
| 安装（Unicode 路径） | exit 0，约 51s |
| 首启 HTTP 健康 | status 200，约 118s（首启植入 3.2 万文件） |
| payload | 32305 文件 / 443.5 MB，无 reparse point |
| 卸载 | exit 0，约 39s；安装目录/进程/端口/注册表零残留 |
| 用户数据 | 隔离目录保留 |
| 报告 | `verification/verification-20260910-173839-702-52812-ab933bc7.json`，`result=PASS` |

## 三、构建与交付

- 统一入口 `build-aio.cmd` → `scripts/build-aio-package.ps1`，参数 `-Verify` / `-Clean` / `-FullTest` / `-ProfileSeedDir` / `-NodeHome`。
- 准备编排 `scripts/prepare-aio.mjs`（Tauri `beforeBuildCommand`）：icon → inject → sidecar → seed-review → native → staging，逐阶段内容指纹缓存（`scripts/build-cache.mjs`），不依赖存在性或时间戳。
- 构建输入按 Release 资产身份与 SHA-256 复用。
- 发布产物带 `build-provenance.json`（提交、源码内容指纹、staging 指纹、产物哈希）；`verify-dist-fresh.js` 接入内容级新鲜度校验，缺失 provenance 才退回 mtime。
- 实测：冷 staging 约 419s；热准备约 40s（seed-review 约 9s、staging 约 31s）；完整打包成功。便携 ZIP `Fastest` 163 MB/10.7s，`Optimal` 147 MB/14.4s，选择 `Fastest`。
- CI：`aio-build.yml` 增加 `concurrency` 串行化、`Swatinem/rust-cache`、构建输入摘要复用、provenance 上传；`aio-validate.yml` 缓存并校验构建输入后准备夹具。
- Skill `change-rules.psd1` 中三个不存在的测试路径已修正，Skill 校验通过。

## 四、残余与未验证项

以下项目**尚未**完成实测验收，不应标记为已解决：

1. **真实 A→B / B→A 升级**：需要已发布的更高版本与真实安装树。当前只完成事务单元与恢复测试。
2. **安装器 edition 回滚边界**：仅恢复程序文件与用户数据；NSIS 注册表/快捷方式副作用未做完整回滚。当前发行版 `installMode=currentUser`，machine-scope 提权不适用。
3. **更新助手 Job 存活**：助手以独立进程启动，未在真实 Shell 关闭/看门狗场景下实测其不被回收。
4. **CI 实跑**：两个 workflow 的改动未在自托管 runner 上执行。
5. **`-Clean` 端到端**：未重跑完整干净构建计时。
6. **依赖维护性告警**：`glib`/`proc-macro-error`/`unic-*` 信息性告警需上游 `tauri`/`urlpattern` 修复；本仓库不擅自覆盖 vendored 依赖。
7. **NSIS 压缩方案对比**：仅比较了便携 ZIP 的 Fastest/Optimal；NSIS 使用 Tauri 默认压缩，未做多方案实测。
8. **离线迁移演练**：`prepare-public-migration-seed.test.mjs` 仍为 opt-in，需要合成运行时才能执行。

## 四·五、复现命令（本轮实测）

```powershell
# 安装/首启/卸载 E2E（已 PASS）
build-aio.cmd -Verify -ProfileSeedDir temp\build-inputs\aio-1.2.0-public-seed

# 依赖安全扫描（已执行）
cargo install cargo-audit --locked
cargo audit --file tauri-app/Cargo.lock --json
```


## 五、复现命令

```powershell
$env:Path = "$PWD\resources\runtime\node;$env:Path"
npm --prefix tauri-app run sidecar:check
npm --prefix tauri-app run sidecar:build
node scripts\prepare-test-fixtures.mjs
node --test --test-concurrency=1 .\test\*.test.mjs
cargo test --locked --manifest-path tauri-app\Cargo.toml
build-aio.cmd
build-aio.cmd -Verify
```

## 七、后续修复（用户实测反馈）

### 启动无窗口

- 现象：安装后双击无窗口，疑似未启动。
- 根因：`lib.rs` 在 `create_main_window()` 之前执行 `seed_distribution_profile()`（首次约 3 万文件 / 1-2 分钟），期间无任何窗口。实测进程 17:50:45 启动、17:52:20 才写首条日志。
- 修复：把 seed 调用移入 `boot.rs::boot_chain` 后台线程（建窗之后、sidecar 之前）。双击即出 loading 窗；植入期间再次双击由单实例聚焦已有窗口。

### DeepSeek 模型列表不可获取且为静态

- 现象：Google/OpenAI「获取可用模型」正常，DeepSeek 只有内置三个且点取无弹窗。
- 根因：内置 `deepseek-official`（`@deepseek-ai/dsh-llm-deepseek`）只带静态 `DEFAULT_MODELS`，不注册 `ctx.llm.registerModelDiscovery`；pi-ai 路由才有发现能力。
- 修复：
  - 新增内置主机插件 `assets/plugins/dsh-aio-live-models`，注册 `llm-deepseek` 发现，始终 `GET {baseURL}/models`，无静态回退；`contextWindow` 默认 256k，失败以可读错误上抛。
  - `desktop-core` 的 `COMPANION_PLUGINS` 纳入该插件，首启同步进 profile。
  - 受控种子补丁 `scripts/seed-kernel-patches.mjs` 把模型默认 `inputModalities` 改为 `["text","image"]`（识图默认开），只在 staging 副本执行。定价仍手动补。
- 验证：新增 `test/aio-live-models.test.mjs`（5）与 `test/seed-kernel-patches.test.mjs`（2）；全量 758 项 757 通过（1 项 opt-in 跳过）；`cargo test` 通过；`build-aio.cmd -Verify` PASS，E2E 日志确认插件已同步且 DSH web 正常启动。

## 八、仍未验证

- DeepSeek 真实 `/models` 联调（需用户的 API Key 在应用内点「获取可用模型」实测）。
- 用户既有 profile 在新版首启时的重植入与插件同步（E2E 用全新隔离数据验证，未覆盖长期已有 profile）。
