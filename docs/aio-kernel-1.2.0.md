# AIO 1.2.0 Kernel Qualification

Status: 本机验收完成（2026-09-09），待 PR 合入后发布。

## Final Acceptance (2026-09-09)

- 最终发布流水线（`scripts/build-aio-release.ps1`，seed=`aio-1.2.0-public-seed-20260909-r7`）全绿：图标同步、seed 隐私校验、sidecar 编译、JS 全量、Rust 全量、staging、NSIS、便携包、SHA256SUMS。
- 产物：`DSHEAC-AIO-v1.2.0-Setup-x64.exe`（312.6 MB）与 `DSHEAC-AIO-v1.2.0-Portable-x64.zip`（147.2 MB），哈希见 `dist/SHA256SUMS.txt`。
- 安装器 E2E 全绿（`verification/verification-20260909-203021-781-48204-c2b094fa.json`）：静默安装（中文+空格路径）、payload 32372 文件、隔离首启 49.5s 至 HTTP 200、隐私扫描零发现、静默卸载零残留（含注册表）。
- 最终全量 Node 测试：715 项，714 通过、0 失败、1 条件跳过。
- 收尾期修复的四个问题：
  1. r7 seed 的 `cordis.patch.yml` 残留已删除插件注册（dsh-skin-switch、@sanqi-normal/dsh-webui-market-plugin），首启 ERR_MODULE_NOT_FOUND；已从 seed 移除，且 seed 生成新增「patch 注册必须是 npm 依赖或内置 companion」拒收校验。
  2. 发布脚本读 package.json 缺 UTF8 编码，PS 5.1 下中文描述导致 JSON 解析失败；已修。
  3. staging 目录残留的备份目录（app-old/profile-seed-old）混入 NSIS 清单使 makensis 中止；stage.ts 现在清扫未知顶层目录。
  4. E2E 卸载注册表检查竞态：NSIS 自拷贝的 DeleteRegKey 晚于目录删除，单次立即检查误报；改为有界轮询。
- 图标：WhaleGirl ICO 为唯一源，`build:icon` 一次同步六处产物（build/、assets/、tauri-app/icons、frontend 启动图）。

## Upstream Reference

- Official desktop source: `deepseek-ai/deepseek-harness`, commit `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`, inspected September 8, 2026.
- Official desktop and published kernel version: `0.1.3-alpha.2` (prerelease).
- AIO retains its Tauri shell. The official Electron private host and framed-pipe transport are not drop-in replacements for the AIO bridge.
- Qualification must bind the shell, kernel, profile dependency graph, and plugin assets together. Updating only the application dependency manifest is insufficient.

## Changes

- Align root first-party kernel dependencies and profile UI dependencies with `0.1.3-alpha.2`.
- Rebuild the sidecar before Node tests, including on a clean checkout.
- Normalize generated DonePill helper source before validating patched bundles, independent of checkout line endings.
- Require public-seed privacy validation and fresh staging for Tauri bundles.
- Use the full application version in installer and portable archive names.
- Compile and load the approved `fs-ext` native dependency; remap compiler source paths and retain only a relative PDB reference.

## Current Evidence

- Earlier completed `npm test`: 538 passed, zero failed/skipped. New migration, native build, and offline agent tests were added afterward; this is not final-suite acceptance.
- Subsequent full run: 590 tests, 589 passed, one Router offline agent failure. Rust's 16 tests, sidecar type checking, and production dependency closure passed again. The failed suite is not release approval.
- After preset repair, a full run passed 611/611. Later user-reported UI fixes and approved plugin removal require another full run.
- `cargo test --locked --manifest-path tauri-app/Cargo.toml`: 16 passed, zero failed/ignored.
- `npm ls --omit=dev --all --parseable`: passed after adding required peers and aligning `cordis-plugin-group` with 1.0.2.
- Isolated official `web` profile: started with the new kernel; onboarding and the empty conversation screen rendered without a configured API key. Browser warnings/errors were empty. The temporary server was stopped.
- A provenance-bound UI compatibility plugin supplies retired gallery, plain-text, and surface-event exports from reviewed source. Eight reviewed plugin archives are migrated in isolated staging; complete AIO activation remains unverified.
- Public seed preparation and a separate sanitizer invocation passed. Packaging drops source maps and PDB files before scanning, consistent with desktop staging. Reviewed false positives are bound to exact dependency file paths and full SHA-256 hashes; the public registry archives were independently fetched and integrity-checked. The legacy usage README was checked against its reviewed archive. Unknown/modified content and secret-bearing config keys remain rejected.
- Three focused packaging regression tests passed for debug artifact pruning, example-key handling, and exact-content binding.
- The upgrade preflight recognizes validated official module fallback junctions; 25 targeted tests passed. This is a read-only startup gate and offline staging primitive, not a completed old-profile installer.
- Actual profile boot exposed retired host settings helpers. Migrated plugins now use a local namespace validator and the current scoped `settings.installSection` method. Host named imports are checked against actual installed exports, not internal source identifiers.
- Browser boot exposed balance registration before the composer slot existed, and WebUI's retired `conversationEvents` service. Balance now waits for slot declarations; WebUI uses `uiConversation.events`.
- After companion synchronization and those fixes, isolated browser onboarding, the empty conversation screen, settings, and plugin pages rendered. No API key was entered. Desktop-bridge-dependent management, session interactions, responsive layout, and final clean runtime logs remain unqualified. The test server and tab were stopped/closed.
- Native qualification exposed an authentication handoff failure. The shell now navigates through the WebView API instead of JavaScript from the loading origin. A fresh isolated native launch reached the application; its version badge reports 1.2.0.
- The qualification executable and staged resources passed build-path auditing after Rust path remapping and a staging fix that excludes native compiler intermediates. This does not yet qualify an installer or portable archive.
- Native testing paused when user input was detected. That candidate's data is private and is not a seed or packaging input.
- New keyless local-provider testing passed an Anchored session/tool/result round-trip but exposed a Router preset failure on the removed `session.events` API. Repair and rerun remain required.
- The preset event API and Router tool execution ownership were repaired. All three shipped presets and nested Router Spec passed keyless tool-turn and persistence tests.

## User-Reported UI Regressions

- Provider settings: reviewed WebUI still used retired `connection.api`; a scoped Remote adapter is under qualification.
- Settings scrolling: reproduce and verify both navigation and content overflow in the final application.
- Prompt optimization: intended-enabled WebUI module, not an unused plugin. Its button consumed removed `input` props; migration now uses the current `useInput` contract.
- Reasoning/tool capsules: the reviewed renderers consumed chat data from the retired session snapshot. Migration now reads the current `useChat` projection, including legacy timing data.
- Plugin controls: BOM/CRLF parsing caused enable/remove operations to fail. Newline-preserving patch operations passed isolated real desktop bridge toggle/remove/restore checks.
- User confirmed removal of the proposed disabled/uncomposed source plugins and nine unused skins. Source, registry, dependencies, packaging, and old-profile migration must be reconciled before approval. Required compatibility dependencies and prompt optimization remain.

## Candidate Inputs

- The successful public seed revision `r4` includes the host settings and WebUI conversation-event migrations. Companion assets are staged separately; offline profile migration needs a separately validated complete seed.
- The isolated profile used for the last browser smoke received the reviewed generated WebUI candidate and current companion assets. This incremental smoke is not a clean final-payload acceptance run.
- The currently installed AIO and its private data have not been replaced.

## Required Acceptance

### R6 Evidence Update (2026-09-09)

- Latest full Node run: 706 tests, 705 passed, zero failed, one opt-in migration rehearsal skipped (`aio-kernel-node-tests-r6.log`). The real r6 migration rehearsal separately passed all eight tests.
- The bottom balance/turn-cost/off-peak hint component, subscription, timer, styles, and dock registration were removed. Pricing settings and native balance APIs remain. Focused balance and portable-staging tests passed 4/4.
- The reviewed WebUI continue enhancer now adapts current `useSession`, `useChat`, and `useInput` hooks; stats read legacy nodes through `useChat`. Continue and migration tests passed 27/27, including CRLF inputs.
- Approved unused plugin and skin source removal is complete. Public seed inputs contain six retained reviewed archives; historical eight-archive migration fixtures remain for compatibility testing.
- Production-identity r6 NSIS build completed successfully in the fresh `tauri-app/target/qualified-r6` output tree. The executable and staged resources passed the build-path audit. Old additive release-cache resources were not used.
- The public r6 full migration seed passed privacy and reference checks. Its profile digest is `1853fbe80c1c43e843316d76949ecdf2b85e687aa073407cefbe6251b8eb64f5`. Synthetic legacy-profile activation, approved retirement, byte preservation, rollback, changed-source rejection, and recovery passed; no native health commit was made.
- Native UI automation remains paused after user Esc. Prompt optimizer visibility, final capsule interactions, final native logs, and the original installation upgrade are still unverified. Existing candidate homes are private, never distribution inputs.
- Build completion is not installer payload inspection or UI acceptance. The original installed application has not been replaced.
- R6 portable ZIP was generated from fresh staged resources and inspected directly: 34,392 entries, retired package paths absent, balance dock code absent, pricing settings retained, executable and portable marker present. ZIP SHA-256: `cd9a9f209c346e71cac4352c1885703eb6372656e5e6338a50500ff9b5beb5f6`.
- The production NSIS artifact was copied without execution to the same `H:\CODEX\artifacts\aio-1.2.0-r6` artifact directory. SHA-256: `12ea18ce09054997ba455b3f13003a8a7f48e5bec30ba6f6c0bb1449a832e1b8`. Actual NSIS extraction/install verification is still required.
- Subsequent NSIS extraction completed without running the installer. All 32,357 resource files match fresh staging byte-for-byte in both directions. The executable differs only in the three-byte `__TAURI_BUNDLE_TYPE_VAR_NSS` versus `UNK` marker, verified against the installed Tauri Utils source. The extracted tree's 32,366 files passed the explicit local workspace/user-path audit with zero findings. Retired plugin paths and balance dock code were absent. Installer execution, native UI qualification, and local replacement remain pending.
- Native qualification resumed with explicit user permission. The actual r6 extracted executable rendered the provider list, and both settings navigation and content panes scrolled independently through mouse-wheel input. These narrow UI checks passed. In a regular session with a visible model selector, the prompt optimizer was absent from both the composer and expanded input menu; this is a confirmed remaining failure, not qualified by the isolated component tests. Existing r6 candidate data must now be treated as private following user interaction.
- After the native windows closed, the flushed r6 host log exposed `applyUsageHost failed: Cannot find package 'dsh-usage-skill'`. WebUI's `usage-host.js` dynamically imports that retired package even though its standalone plugin was disabled. R6 therefore fails host dependency acceptance; lean package absence alone was insufficient evidence. Repair must preserve usage/balance and skill-management behavior while reconciling the approved retirement. No production replacement has been performed.
- Full WebUI apply tests reproduced collisions with official ui-skill's locale namespace and keyed tool row; scoped namespace/priority repairs allow optimizer registration in those tests. Native provisional qualification then exposed an additional `remote.session` injection failure in the optimizer's `directoryFor` call. BrowserSeat still reads removed `input.draft`, UserRewindNodeView reads the old session chat shape, and ToolEntry accesses the old tool-card shape. These actual DevTools failures remain release blockers.
- The public JSONL fixture requires `compression: none` in its isolated persistence configuration; the first provisional fixture launch was correctly rejected by the default Zstandard backend. A separate test-only home (`aio-native-r7-prompt2-home`) uses the matching encoding. This does not change shipped defaults or user sessions. The r6 executable plus provisional profile is a diagnostic candidate, not a newly qualified distribution.
- R7 migrations now include the optimizer's explicit `remote.session` capability and BrowserSeat/UserRewindNodeView/tool record adaptations. The real sibling-owned ModelDirectoryResolver regression reproduces the old permission error and passes with the declaration. Combined interface and input/chat/tool tests passed 32/32.
- The WebUI-owned usage host replaces the retired standalone package import while retaining usage/account/balance/skill-management endpoints. Seed construction installs it after dependency closure verification and binds its helper and asset integrity manifest into the build fingerprint. Targeted seed/host tests passed 26/26; real external account services remain unverified.
- The user-marked skin and duplicate rightmost market tabs have no client manifests, exports, or client source files remaining. Their host compatibility code remains; frontend-only market peers were removed. Focused removal/inventory/host tests passed 25/25.
- Public seed `H:\CODEX\build-inputs\aio-1.2.0-public-seed-20260909-r7` completed successfully. Latest full Node run (`aio-kernel-node-tests-r7.log`): 738 tests, 737 passed, zero failed, one conditional skip. R7 final payload/native qualification and local installation are still pending.

- Complete Node and Rust tests, sidecar type checking, and dependency consistency checks.
- Build the offline profile from public manifests and reviewed plugin artifacts, never from live user settings or sessions.
- Verify each bundled preset and third-party host/client plugin against the new kernel.
- Verify a clean profile and an existing-profile upgrade, including disabled/config preservation and recovery from failed activation.
- Exercise the installed application UI and plugin controls; inspect rendered output and runtime errors.
- Inspect final installer and portable payloads for privacy and integrity.
- Install the verified update locally, confirm the effective kernel and application versions, and verify shutdown without orphan processes.

Existing private user data is not a distribution input and must not be deleted merely to obtain a clean build.
