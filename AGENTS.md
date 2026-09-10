# AIO 构建与打包规则

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

## 构建脚本执行顺序

`scripts/build-aio-package.ps1` 按以下顺序执行：

1. 检查 Node/npm，并优先使用 `temp\toolchain\node-v24.19.0-win-x64`。
2. 根依赖、Tauri 依赖、内置 Node/npm 或 `fs-ext` 缺失时自动补齐。
3. 校验 profile seed 必须包含：
   `profiles\web-desktop\node_modules`。
4. 设置 `DSH_PROFILE_SEED_DIR`。
5. 同步应用图标。
6. 执行 seed 隐私校验。
7. 执行 sidecar TypeScript 类型检查和编译。
8. 执行 Tauri 资源 staging。
9. 执行 Tauri/NSIS 打包，生成单文件安装器。
10. 复制安装器到 `dist`。
11. 从同一 release/staging 目录生成便携 ZIP。
12. 生成顶层和便携包 SHA-256 清单。
13. 仅在传入 `-Verify` 时运行安装器 E2E。

## 输出产物

```text
dist\DSHEAC-AIO-v1.2.0-Setup-x64.exe
dist\portable\DSHEAC-AIO-v1.2.0-Portable-x64.zip
dist\SHA256SUMS.txt
dist\portable\SHA256SUMS.txt
```

`Setup-x64.exe` 是可直接分发的单文件 NSIS 安装器。便携 ZIP 不是安装器的运行依赖。

## 验证要求

打包后至少核对：

- `dist\DSHEAC-AIO-v1.2.0-Setup-x64.exe` 存在且哈希与 `dist\SHA256SUMS.txt` 一致。
- `dist\portable\DSHEAC-AIO-v1.2.0-Portable-x64.zip` 包含：
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
node --test --test-concurrency=1 test\composer-dynamic-island-builtin.test.mjs test\composer-island-position.test.mjs test\plugin-manager-toggle.test.mjs test\sidecar-rpc.test.mjs
cargo test --locked --manifest-path tauri-app\Cargo.toml
```

## 已知边界

- 完整 `npm test` 依赖历史外部夹具；夹具缺失时不能把全量测试结果标记为通过。
- 当前构建脚本会临时登记 `zod@4.4.3` 官方测试文件的审核哈希，并保证在 `finally` 中恢复原文件。不要永久修改审核哈希来绕过失败。
- 上游 WebUI 代码包含 `D:\AI\Dsh` 相关默认路径文本；公开发布前应单独审计和清理。
- 当前 `setup.exe` 未进行代码签名，Windows SmartScreen 可能提示未知发布者。
- 未获得用户明确授权时，不执行 commit、push、创建 PR、打标签或发布。