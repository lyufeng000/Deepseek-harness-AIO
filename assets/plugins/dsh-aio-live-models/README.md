# dsh-aio-live-models

DSHEAC AIO 内置主机插件：为内置 DeepSeek 官方 provider（`deepseek-official` /
设置命名空间 `llm-deepseek`）注册**实时模型发现**。

## 为什么需要

上游 `@deepseek-ai/dsh-llm-deepseek` 只携带静态 `DEFAULT_MODELS`，且没有调用
`ctx.llm.registerModelDiscovery`。因此 Web UI「设置 → 模型 → 获取可用模型」对
DeepSeek 无法向 provider 查询，列表始终是内置的三个模型。其它 provider 走
`@deepseek-ai/dsh-llm-pi-ai` 路由，已具备发现能力。

本插件补齐该缺口：注册 `llm-deepseek` 命名空间的发现处理器，始终请求
`GET {baseURL}/models`，不使用静态回退。

## 行为

- baseURL：发现请求传入 → `llm-deepseek` 设置 `baseURL` → 默认 `https://api.deepseek.com`。
- 鉴权：发现请求传入的 `apiKey` → 否则按 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）
  经 `ctx.get('credentials').resolve()` 读取。
- 返回：按 `data[].id` 去重，每项带 `contextWindow: 262144`（256k）；`name` 与
  `max_tokens` 存在时一并带上。
- 失败不静默：连接失败、HTTP 非 2xx、空列表都以可读中文错误上抛，由界面呈现。

发现协议本身只承载 `id/name/contextWindow/maxTokens`，无法携带 `inputModalities`；
DeepSeek 新模型的「原生识图默认开」由构建期的受控种子补丁
（`scripts/seed-kernel-patches.mjs`）把 `dsh-llm-deepseek` 的模型 `inputModalities`
默认值改为 `["text","image"]` 实现：图片交给当前选中的原生多模态模型直接理解，
不再经过 `dsh-webui` 辅助视觉把图片转写成文本。定价仍由用户在余额定价面板手动补充。

## 目录

```text
package.json
lib/index.js
LICENSE
README.md
```

由 `sidecar/src/desktop-core.ts` 的 `COMPANION_PLUGINS` 同步进 profile 并注册到
profile 的 `cordis.patch.yml`。
