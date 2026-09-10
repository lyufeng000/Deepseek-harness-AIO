# AIO 插件布局修复

## 动态岛

毛玻璃输入框的 `backdrop-filter` 会建立固定定位包含块。插件原来直接把视口坐标写给仍留在 React 原树中的控件，造成菜单及按钮偏移到右下方。

修复在每个控件自身的包含块中换算坐标，保留 React 节点归属、皮肤和原生模型选择器。完成入场动画留下的单位矩阵也按包含块处理。菜单在打开、滚动和尺寸变化时重新定位，卸载时释放监听器。

测量包括被收缩容器包裹的按钮宽度，横向定位限制在输入框所在列内，避免伸入右侧面板。

## 顶部完成胶囊

受控脚本 `scripts/patch-done-pill.cjs` 针对 `@dsh-external/dsh-webui@0.5.1` 的 `DonePill` 源码区段。它校验版本、源码指纹及替换次数；重复执行会验证已应用内容，未知构建不会被盲目改写。

定位避让顶部会话工具栏，处理默认位置、历史锚点、拖动、缩放和窗口变化。空间不足时隐藏胶囊，避免覆盖操作按钮；恢复空间后自动显示。不写回自动避让产生的临时坐标。

`tauri-app/scripts/stage.ts` 在复制离线 seed 后只修改 staging 副本，失败会中止打包。原始 seed 保持不变。

## 会话区入场动画残留变换（session-motion）

`@dsh-external/dsh-webui@0.5.1` 的 `session-motion` 给消息区根盒与空白会话 Hero 注入入场动画，填充方式是 `both`（含 `forwards`），而关键帧收尾写成 `transform: translateY(0)` 而不是 `none`。动画播完后单位矩阵会永久留在元素上：该盒因此成为 fixed/absolute 后代的包含块，并在滚动容器里单独成层，切换会话后滚动消息区会抽动一下；入场 400ms 内行与滚动端口不再同处一个坐标系，锚点读取最多偏 10px。

受控脚本 `scripts/patch-session-motion.cjs` 只针对 `@dsh-external/dsh-webui@0.5.1` 的 `session-motion` 源码区段，校验版本、源码指纹与替换次数；重复执行只验证已应用内容，未知构建不会被盲目改写：

- 两条入场动画 `both` 改为 `backwards`：动画结束即回到常态样式；
- 关键帧收尾 `translateY(0)` 改为 `none`：不再留下变换、包含块或合成层。

入场观感不变（仍是淡入 + 10px 上浮），`prefers-reduced-motion: reduce` 行为不变。动态岛一节里按包含块处理单位矩阵的补偿照旧保留（防御其它来源的变换），但本补丁消除了这个来源。`tauri-app/scripts/stage.ts` 在复制离线 seed 后依次重放两个补丁，失败会中止打包；原始 seed 保持不变。

## 已安装用户

离线 seed 只在首次启动时复制，因此已有 profile 不会因替换 seed 自动获得顶部补丁与会话区补丁。应先退出 AIO 并备份目标插件的 `lib/client.js`，然后从仓库执行：

```powershell
$plugin = Join-Path $env:APPDATA 'com.deepseek.dsh.desktop.aio\dsh-home\profiles\web-desktop\node_modules\@dsh-external\dsh-webui'
node scripts/patch-done-pill.cjs $plugin
node scripts/patch-session-motion.cjs $plugin
node scripts/patch-done-pill.cjs --write $plugin
node scripts/patch-session-motion.cjs --write $plugin
```

便携版请改用实际 profile 路径。再次启动 AIO 后验收；不要在运行中的插件加载过程中替换文件。回退时退出 AIO，再恢复所备份的单个文件。

动态岛使用仓库内置包分发及现有 companion 同步机制。本文不要求修改 `settings.yaml`、模型、密钥、会话或插件启停选择。

## 验证

```powershell
node --test test/composer-island-position.test.mjs test/composer-dynamic-island-builtin.test.mjs test/done-pill-layout.test.mjs test/session-motion-no-residual.test.mjs
```

真实 WebUI 区段测试会从本机安装目录读取只读样本；CI 可设置 `DSH_DONE_PILL_TEST_PACKAGE` 指向审核后的包。`session-motion` 用例另在真实内核里验证「动画播完后没有残留变换、fixed 控件不再随滚动位移」，样本可用 `DSH_SESSION_MOTION_TEST_PACKAGE` 指定。没有样本或没有 Playwright 时该项明确跳过，不能解释成真实插件验证通过。

手工验收应覆盖毛玻璃皮肤、原生皮肤、长会话、历史胶囊拖拽位置、右侧面板、窄窗口、缩放，动态岛按钮点击、滚动后定位、关闭与卸载，以及切换会话后滚动消息区不抽动、面板类浮层不随滚动位移。
