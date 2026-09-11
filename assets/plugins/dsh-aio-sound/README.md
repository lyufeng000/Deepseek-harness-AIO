# dsh-aio-sound

DSHEAC AIO 内置插件：**会话完成提示音** + 设置页「音效」栏。

## 为什么需要

上游 `@dsh-external/dsh-webui` 的提示音由客户端的 `conversation.chat.turnTail`
槽位触发，而该槽位只渲染**当前被选中的会话**——切到别的会话后，后台会话跑完
不出声。本插件把播放搬到 host 端，监听所有会话的 `session/event`：只要有任何
回合结束就出声，与前端选中状态无关。

## 行为

- **任何会话完成都出声**：host 端 `ctx.on('session/event')` 监听 `turn/end`；
  不过滤子代理（`subagent`）回合、用户中断（`aborted`）与空回合，逐次播放。
- **审批/提问等待也出声**：额外监听 `approval/asked` 与 `user-questions/request`
  （plan 询问 / AskUserQuestion 属于后者），提醒用户有东西在等回应。
- **host 端播放**：PowerShell + WPF `MediaPlayer`，绕开浏览器自动播放拦截；
  `Volume` 只作用于这次播放（0–100），不改系统音量。媒体栈起不来时回退
  `System.Media.SoundPlayer`（满音量）。
- **设置页「音效」栏**（`settings.section` id `aio-sound`）：会话完成是否播放、
  音量、播放内容（默认沿用现有 `task-done.wav`）、自定义音效目录。

## 配置

设置命名空间 `aio-sound`（写入 `$DSH_HOME/settings.yaml`，随 profile 保留）：

```yaml
aio-sound:
  enabled: true        # 会话完成是否播放音效
  volume: 100          # 0..100，只作用于提示音
  sound: task-done.wav # 播放内容（内置文件名或自定义目录里的文件名）
  customDir: ''        # 留空 = $DSH_HOME/sounds
```

`settings` 服务不可用时退化为进程内配置，插件仍可加载（界面照常读写）。

## HTTP 路由（回环，`Cache-Control: no-store`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/aio-sound/state` | 配置 + 音效清单（内置 + 自定义目录扫描） |
| POST | `/api/aio-sound/config` | 校验并写入 `{ enabled, volume, sound, customDir }` |
| POST | `/api/aio-sound/preview` | 按当前音量试听一个音效（用户点「试听」） |

音效名走白名单 `^[A-Za-z0-9._-]+\.wav$`，不接受路径分隔符；自定义目录解析后
仍校验不越出目录边界。

## 内置音效

`assets/sounds/`：`task-done.wav`（默认，原样沿用上游现有提示音）、
`chime-soft.wav`、`chime-bright.wav`、`bell.wav`、`drop.wav`、`pulse.wav`。

自定义音效：把 `*.wav` 放进 `$DSH_HOME/sounds/`（或设置页里指定的目录），
下拉里会以「自定义目录」分组出现。

## 与上游旧开关的关系

上游「基础设置」里的「插件任务完成提示音」行已由打包期的受控种子补丁移除，
它的 localStorage 开关同步失效（客户端不再上报播放请求），避免与新「音效」栏
出现两个开关。桌面右下角完成卡片在本发行版始终关闭，只有提示音。

## 开发

无构建步骤：`lib/index.js`（host）与 `lib/client.js`（浏览器半身，手写
`window.__ModuleLoader__` bundle）直接随包分发。`assets/play-sound.ps1` 用
`-STA` 调用（MediaPlayer 需要 STA）。
