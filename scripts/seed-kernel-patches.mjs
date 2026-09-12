// 受控种子补丁：只作用于打包进应用的 profile seed 副本，不改上游审核快照。
//
// 本文件集中维护不能直接改写审核上游快照的发行差异：DeepSeek 官方 Flash
// 型号能力和统一配置路径、供应商图标、原生视觉链路、会话滚动稳定性、旧提示音
// 移除，以及客制化插件市场来源和缓存。打包使用 strict 模式，任一锚点漂移即
// 阻断，避免“源码已修但 staging 未带上”。
import fs from 'node:fs';
import path from 'node:path';

const DEEPSEEK_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const AGENT_INSTRUCTIONS_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-agent-instructions', 'lib', 'index.js'];
const WEBUI_VISION_HELPER = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'vision-helper.js'];
const STATUS_ROTATOR_CLIENT = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'lib', 'client.js'];
const STATUS_ROTATOR_HOST = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'lib', 'index.js'];
const STATUS_ROTATOR_EXAMPLE = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'config.example.json'];
const WEBUI_CLIENT = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'];
const WORKSPACE_CLIENT = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'];
const MODELS_UI_CLIENT = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js'];
const CUSTOM_CLIENT = ['profiles', 'web-desktop', 'node_modules', '@ha-na-bi', 'dsh-client-ui-custom', 'lib', 'client.js'];

// ------------------------------------------------------------ 运行时副本镜像 --
//
// 内置内核包（@deepseek-ai/*）在打包产物里有两份副本：
//   1) resources/profile-seed/profiles/web-desktop/node_modules/@deepseek-ai/…
//   2) resources/app/node_modules/@deepseek-ai/…（stage.ts 从仓库根 node_modules
//      铺设的安装闭包）
// 真实实例按第 2 份解析：$DSH_HOME/profiles/node_modules/@deepseek-ai/* 是指向
// 安装闭包的链接，而 sidecar 的 healProfileModuleShadowing 会清掉 profile 里
// 遮蔽该闭包的包拷贝。因此只打 profile seed 的补丁在用户机器上不生效
// （1.3.2 实例上 DeepSeek 原生识图即因此失效）。
//
// 不另列镜像清单：以 profile 布局里作用域为 @deepseek-ai/* 为判据，新增的内核包
// 补丁自动纳入，避免再次出现“源码改了但实例没变”。
const PROFILE_MODULES_PREFIX = ['profiles', 'web-desktop', 'node_modules'];
const APP_MODULES_PREFIX = ['node_modules'];
const MIRRORED_SCOPE = ['@deepseek-ai'];

/**
 * 同一补丁在安装闭包（app）布局下的路径。
 * @param {string[]} file - profile seed 布局下的补丁路径。
 * @returns {string[] | null} app 布局路径；非 @deepseek-ai 目标（只存在于 profile）返回 null。
 */
export function mirroredFile(file) {
  const head = [...PROFILE_MODULES_PREFIX, ...MIRRORED_SCOPE];
  if (file.length <= head.length) return null;
  if (JSON.stringify(file.slice(0, head.length)) !== JSON.stringify(head)) return null;
  return [...APP_MODULES_PREFIX, ...file.slice(PROFILE_MODULES_PREFIX.length)];
}

/** 受控补丁清单：稳定锚点、幂等替换；打包阶段要求全部命中。 */
export const SEED_PATCHES = Object.freeze([
  Object.freeze({
    id: 'deepseek-flash-model-id',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: 'id: "deepseek-v4-flash",\n\t\tname: "DeepSeek-V4-Flash",',
    to: 'id: "deepseek-flash",\n\t\tname: "DeepSeek-Flash",\n\t\tinput: ["text", "image"],\n\t\timagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,\n\t\timageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,',
  }),
  Object.freeze({
    id: 'deepseek-flash-legacy-alias',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: 'id: "deepseek-v4-flash-vision-exp",',
    to: 'id: "deepseek-v4-flash",\n\t\tname: "DeepSeek-V4-Flash (Legacy alias)",\n\t\tcontextWindow: DEFAULT_CONTEXT_WINDOW,\n\t\tinput: ["text", "image"],\n\t\timagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,\n\t\timageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES\n\t},\n\t{\n\t\tid: "deepseek-v4-flash-vision-exp",',
  }),
  Object.freeze({
    id: 'deepseek-model-common-input-field',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: '\tinputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),',
    to: '\tinput: z.array(z.union(MODEL_MODALITIES)),\n\tinputModalities: z.array(z.union(MODEL_MODALITIES)),',
  }),
  Object.freeze({
    id: 'deepseek-legacy-vision-common-input',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: '\t\tinputModalities: ["text", "image"],',
    to: '\t\tinput: ["text", "image"], // EAC_DEEPSEEK_LEGACY_VISION_INPUT_V1',
  }),
  Object.freeze({
    id: 'deepseek-known-model-capabilities',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: '\t\tconst inputModalities = model.inputModalities ?? ["text"];',
    to: '\t\tconst declared = model.input?.length ? model.input : model.inputModalities?.length ? model.inputModalities : undefined;\n\t\tconst inputModalities = declared ?? (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model.id) ? ["text", "image"] : ["text"]);',
  }),
  Object.freeze({
    id: 'deepseek-config-schema-nested',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: 'const Config = z.object({\n\tapiKeyEnv:',
    to: 'const ProviderConfig = z.object({\n\tapiKeyEnv:',
  }),
  Object.freeze({
    id: 'deepseek-config-schema-wrapper',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: '\tretryPolicy: RetryPolicySchema\n});\n/** Public API default;',
    to: '\tretryPolicy: RetryPolicySchema\n});\nconst Config = z.object({ providers: z.dict(ProviderConfig).default({}) });\n/** Public API default;',
  }),
  Object.freeze({
    id: 'deepseek-config-read-nested',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: 'function resolveAdapterOptions(config, environment) {\n\tif (config.thinking',
    to: 'function resolveAdapterOptions(config, environment) {\n\tconfig = config?.providers?.[PROVIDER] ?? config ?? {};\n\tif (config.thinking',
  }),
  Object.freeze({
    id: 'deepseek-config-settings-path',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: '\t\tsettingsNs: NS,\n\t\tsettingsPath: []',
    to: '\t\tsettingsNs: NS,\n\t\tsettingsPath: ["providers", PROVIDER]',
  }),
  Object.freeze({
    id: 'webui-vision-fallback-off',
    file: WEBUI_VISION_HELPER,
    label: 'dsh-webui vision-helper module',
    from: 'textModelImageFallback: z.boolean().default(true),',
    to: 'textModelImageFallback: z.boolean().default(false),',
  }),
  Object.freeze({
    id: 'status-rotator-pill-default-off',
    file: STATUS_ROTATOR_CLIENT,
    label: 'dsh-status-rotator client',
    from: "/** 实时状态 Pill:false 关闭;或 { enabled, template, position, opacity } */\n\t\t\tpill: {\n\t\t\t\tenabled: true,",
    to: "/** 实时状态 Pill:false 关闭;或 { enabled, template, position, opacity } */\n\t\t\tpill: {\n\t\t\t\tenabled: false,",
  }),
  Object.freeze({
    id: 'status-rotator-example-pill-off',
    file: STATUS_ROTATOR_EXAMPLE,
    label: 'dsh-status-rotator config.example.json',
    from: "\"pill\": {\n            \"enabled\": true,\n            \"template\": \"{model} · {phaseLabel} · {elapsed} · ⚡{tps} tok/s\",",
    to: "\"pill\": {\n            \"enabled\": false,\n            \"template\": \"{model} · {phaseLabel} · {elapsed} · ⚡{tps} tok/s\",",
  }),
  Object.freeze({
    id: 'status-rotator-settings-inject',
    file: STATUS_ROTATOR_HOST,
    label: 'dsh-status-rotator host',
    from: "const name = \"status-rotator\";\n/**\n * 不硬依赖任何服务:webServer 缺失的宿主(如 headless/测试 profile)也要能激活,\n * 只是不注册配置路由(对应 testkit 生命周期检查发现的问题)。\n */\nconst inject = [];",
    to: "const name = \"status-rotator\";\n/**\n * 不硬依赖任何服务:webServer 缺失的宿主(如 headless/测试 profile)也要能激活,\n * 只是不注册配置路由(对应 testkit 生命周期检查发现的问题)。\n */\nconst inject = [\"settings\"];",
  }),
  Object.freeze({
    id: 'webui-done-sound-row-remove',
    file: WEBUI_CLIENT,
    label: 'dsh-webui client task-done settings row',
    from: "\t\t\tctx.slots.inject(\"settings.general.item\", () => ctx.slots.register({\r\n\t\t\t\tname: \"settings.general.item\",\r\n\t\t\t\tid: \"task-done-sound\",\r\n\t\t\t\torder: 30,\r\n\t\t\t\tlabel: \"插件任务完成提示音\"\r\n\t\t\t}, TaskDoneRow));",
    to: "\t\t\t// EAC_AIO_SOUND_OWNER_V1: 「插件任务完成提示音」行已迁到 dsh-aio-sound 的「音效」栏。",
  }),
  Object.freeze({
    id: 'webui-done-sound-reporting-remove',
    file: WEBUI_CLIENT,
    label: 'dsh-webui client turnTail reporting',
    from: "\t\t\tctx.slots.inject(\"conversation.chat.turnTail\", () => ctx.slots.register({\r\n\t\t\t\tname: \"conversation.chat.turnTail\",\r\n\t\t\t\tselect: (owner) => ({\r\n\t\t\t\t\tturn: owner.turn.turn,\r\n\t\t\t\t\tendedAt: owner.turn.end === void 0 ? 0 : owner.turn.end.time\r\n\t\t\t\t})\r\n\t\t\t}, TurnDoneSound));",
    to: "\t\t\t// EAC_AIO_SOUND_OWNER_V1: 会话完成提示音改由 dsh-aio-sound 在 host 端统一播放（含后台会话）。",
  }),
  Object.freeze({
    id: 'provider-deepseek-official-icon',
    file: WEBUI_CLIENT,
    label: 'dsh-webui provider icon map',
    from: '"deepseek": "deepseek",',
    to: '"deepseek": "deepseek",\n\t\t\t"deepseek-official": "deepseek",',
  }),
  Object.freeze({
    id: 'deepseek-onboarding-nested-path',
    file: MODELS_UI_CLIENT,
    label: 'dsh-client-ui-settings-models DeepSeek onboarding',
    from: 'candidate.entry.provider === "deepseek-official" && candidate.entry.settingsNs === "llm-deepseek" && candidate.entry.settingsPath.length === 0',
    to: 'candidate.entry.provider === "deepseek-official" && candidate.entry.settingsNs === "llm-deepseek" && candidate.entry.settingsPath.join(".") === "providers.deepseek-official"',
    all: true,
    count: 2,
  }),
  Object.freeze({
    id: 'agent-instructions-init-refresh',
    file: AGENT_INSTRUCTIONS_MODULE,
    label: 'dsh-agent-instructions /init refresh bridge',
    from: '\tctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {\n\t\tconst decision = await next();',
    to: '\tctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {\n\t\tconst refreshSessions = globalThis[Symbol.for("dsh.eac.agent-instructions.refresh.v1")];\n\t\tif (refreshSessions instanceof WeakSet && refreshSessions.delete(agent.session)) {\n\t\t\tbaselinePreparations.delete(agent.session);\n\t\t\tinstructionVersions.delete(agent.session);\n\t\t}\n\t\tconst decision = await next();',
  }),
  // 首轮 prompt 被拒（例如模型不支持图片）后，Host 仍把该会话视为空白日志；
  // 若「新对话」复用它，界面会停在空对话不动（点新对话无反应）。
  // 只复用真正没有发送过任何内容的空白会话。
  Object.freeze({
    id: 'workspace-blank-session-skip-engaged',
    file: WORKSPACE_CLIENT,
    label: 'dsh-client-ui-workspace connectWorkspace',
    from: '\t\t\t\t\tif (summary !== void 0 && summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(summary.id) && !archived.includes(summary.id)) return summary.id;',
    to: '\t\t\t\t\tif (summary !== void 0 && summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(summary.id) && !archived.includes(summary.id)) {\n\t\t\t\t\t\tconst engaged = this.sessions.binding(summary.id)?.session?.promptAttempted === true;\n\t\t\t\t\t\tif (!engaged) return summary.id;\n\t\t\t\t\t}',
  }),
  Object.freeze({
    id: 'webui-markdown-stable-layout',
    file: WEBUI_CLIENT,
    label: 'dsh-webui markdown renderer',
    from: ':where(.markstream-react).markdown-renderer{position:relative;contain:layout;content-visibility:auto;contain-intrinsic-size:800px 600px}',
    to: ':where(.markstream-react).markdown-renderer{position:relative;contain:layout;content-visibility:visible;contain-intrinsic-size:auto}',
  }),
  Object.freeze({
    id: 'webui-markdown-no-node-virtualization',
    file: WEBUI_CLIENT,
    label: 'dsh-webui markdown renderer',
    from: 'deferNodesUntilVisible: !0,\n\t\t\tmaxLiveNodes: 320,',
    to: 'deferNodesUntilVisible: false,\n\t\t\tmaxLiveNodes: 0,',
  }),
  Object.freeze({
    id: 'custom-motion-transcript-fade-only',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom motion',
    from: 'const styleCls = styleClass(ordered[0] !== void 0 && isTreeItem(ordered[0]) ? state.sidebarStyle : state.style);',
    to: 'const styleCls = styleClass(ordered[0] !== void 0 && isTreeItem(ordered[0]) ? state.sidebarStyle : "fade");',
  }),
  Object.freeze({
    id: 'custom-motion-panel-fade-only',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom motion',
    from: '@keyframes xO0q6W_dsu-motion-panel{0%{opacity:.4;transform:translateY(6px)}to{opacity:1;transform:none}}',
    to: '@keyframes xO0q6W_dsu-motion-panel{0%{opacity:.4}to{opacity:1}}',
  }),
  Object.freeze({
    id: 'custom-marketplace-default-url',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace',
    from: 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-custom/marketplace.json',
    to: 'https://raw.githubusercontent.com/Yoli-mi/dsh-client-ui-custom/main/marketplace.json',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-helpers',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace cache',
    from: '\t\t/** Bridges the catalog + inventory + clipboard onto the tab. */\n\t\tvar MarketplaceController = class {',
    to: '\t\tconst MARKETPLACE_CACHE_KEY = "dsh.marketplace.last-valid.v1";\n\t\tfunction readMarketplaceCache() {\n\t\t\ttry {\n\t\t\t\tconst value = JSON.parse(localStorage.getItem(MARKETPLACE_CACHE_KEY) ?? "null");\n\t\t\t\tif (value === null || !Array.isArray(value.entries) || typeof value.savedAt !== "string") return null;\n\t\t\t\tif (value.entries.some((entry) => entry === null || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.package !== "string" || typeof entry.repoUrl !== "string" || typeof entry.installYaml !== "string")) return null;\n\t\t\t\treturn value;\n\t\t\t} catch { return null; }\n\t\t}\n\t\tfunction writeMarketplaceCache(entries) {\n\t\t\ttry { localStorage.setItem(MARKETPLACE_CACHE_KEY, JSON.stringify({ savedAt: (/* @__PURE__ */ new Date()).toISOString(), entries })); } catch {}\n\t\t}\n\t\t/** Bridges the catalog + inventory + clipboard onto the tab. */\n\t\tvar MarketplaceController = class {',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-initial-state',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace cache',
    from: '\t\t\t\tthis.store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({\n\t\t\t\t\tentries: BUNDLED_MARKETPLACE,\n\t\t\t\t\tsource: "bundled",',
    to: '\t\t\t\tconst cached = readMarketplaceCache();\n\t\t\t\tthis.store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({\n\t\t\t\t\tentries: cached?.entries ?? BUNDLED_MARKETPLACE,\n\t\t\t\t\tsource: cached === null ? "bundled" : "remote",\n\t\t\t\t\tcacheTime: cached?.savedAt ?? null,',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-refresh',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace cache',
    from: '\t\t\t\tthis.store.update((state) => {\n\t\t\t\t\tstate.entries = merged.length > 0 ? merged : BUNDLED_MARKETPLACE;\n\t\t\t\t\tstate.source = merged.length > 0 ? "remote" : "bundled";\n\t\t\t\t\tstate.refreshing = false;',
    to: '\t\t\t\tif (merged.length > 0) writeMarketplaceCache(merged);\n\t\t\t\tconst cached = merged.length === 0 ? readMarketplaceCache() : null;\n\t\t\t\tthis.store.update((state) => {\n\t\t\t\t\tstate.entries = merged.length > 0 ? merged : cached?.entries ?? BUNDLED_MARKETPLACE;\n\t\t\t\t\tstate.source = merged.length > 0 || cached !== null ? "remote" : "bundled";\n\t\t\t\t\tstate.cacheTime = merged.length > 0 ? (/* @__PURE__ */ new Date()).toISOString() : cached?.savedAt ?? null;\n\t\t\t\t\tstate.refreshing = false;',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-label-zh',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace locale',
    from: '\t\t\t"source.remote": "GitHub",\n\t\t\topenOnGitHub: "GitHub 源码",',
    to: '\t\t\t"source.remote": "GitHub",\n\t\t\t"source.cache": "缓存时间",\n\t\t\topenOnGitHub: "GitHub 源码",',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-label-en',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace locale',
    from: '\t\t\t"source.remote": "GitHub",\n\t\t\topenOnGitHub: "Source on GitHub",',
    to: '\t\t\t"source.remote": "GitHub",\n\t\t\t"source.cache": "Cached at",\n\t\t\topenOnGitHub: "Source on GitHub",',
  }),
  Object.freeze({
    id: 'custom-marketplace-cache-time-ui',
    file: CUSTOM_CLIENT,
    label: 'dsh-client-ui-custom marketplace toolbar',
    from: '\t\t\t\t\t\t\t\ttranslator(state.source === "remote" ? "source.remote" : "source.bundled"),\n\t\t\t\t\t\t\t\tstate.discoveredTotal !== null && ` · ${translator("total")}：${state.discoveredTotal}`',
    to: '\t\t\t\t\t\t\t\ttranslator(state.source === "remote" ? "source.remote" : "source.bundled"),\n\t\t\t\t\t\t\t\tstate.discoveredTotal !== null && ` · ${translator("total")}：${state.discoveredTotal}`,\n\t\t\t\t\t\t\t\tstate.cacheTime !== null && ` · ${translator("source.cache")}：${new Date(state.cacheTime).toLocaleString()}`',
  }),
]);

/**
 * Apply one controlled patch to a packaged seed root.
 * Idempotent: a second call reports `applied: false`.
 * @param {string} seedRoot - root that holds the target file（profile seed 或 app 布局根）。
 * @param {{id: string, file: string[], label: string, from: string, to: string}} patch - controlled patch descriptor.
 * @param {string[]} [file] - 目标路径；省略时用补丁自带的 profile 布局路径。
 * @returns {{id: string, applied: boolean, reason?: string, file?: string}}
 */
function patchOnce(seedRoot, patch, file = patch.file) {
  const target = path.join(seedRoot, ...file);
  if (!fs.existsSync(target)) return { id: patch.id, applied: false, reason: `${patch.label} not present` };
  const raw = fs.readFileSync(target, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let source = raw.replace(/\r\n/g, '\n');
  const from = patch.from.replace(/\r\n/g, '\n');
  const to = patch.to.replace(/\r\n/g, '\n');
  const expectedCount = patch.count ?? 1;
  const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
  if (occurrences(source, to) === expectedCount) return { id: patch.id, applied: false, reason: 'already patched', file: target };
  if (occurrences(source, from) !== expectedCount) return { id: patch.id, applied: false, reason: 'target default not found (upstream changed?)', file: target };
  source = patch.all ? source.replaceAll(from, to) : source.replace(from, to);
  fs.writeFileSync(target, eol === '\r\n' ? source.replace(/\n/g, '\r\n') : source);
  return { id: patch.id, applied: true, file: target };
}

/**
 * Apply every controlled seed patch to a packaged seed root.
 * A missing or reworded target skips only its own patch.
 * @param {string} seedRoot - root that holds the targets（profile seed 或 app 布局根）。
 * @param {{strict?: boolean, planes?: ('profile' | 'app')[]}} [options] - planes 默认 ['profile']；
 *   含 'app' 时额外处理安装闭包布局下有镜像的 @deepseek-ai/* 补丁。
 * @returns {{id: string, applied: boolean, reason?: string, file?: string}[]} one result per patch, in patch order.
 */
export function applySeedPatches(seedRoot, options = {}) {
  const planes = options.planes ?? ['profile'];
  const results = [];
  for (const patch of SEED_PATCHES) {
    if (planes.includes('profile')) results.push(patchOnce(seedRoot, patch));
    if (planes.includes('app')) {
      const file = mirroredFile(patch.file);
      if (file !== null) results.push(patchOnce(seedRoot, patch, file));
    }
  }
  if (options.strict === true) {
    const failures = results.filter((result) => !result.applied && result.reason !== 'already patched');
    if (failures.length > 0) {
      throw new Error('Required seed patches did not match:\n' + failures.map((row) => `- ${row.id}: ${row.reason}`).join('\n'));
    }
  }
  return results;
}
