// 受控种子补丁：只作用于打包进应用的 profile seed 副本，不改上游审核快照。
//
// 前提：DeepSeek 已提供原生多模态。图片应当由当前选中的模型直接理解，
// 不再依赖「专门的图像解析模型」把图片转写成文本。据此打两个补丁：
//
// 补丁 1 deepseek-native-image：
//   DeepSeek 官方 provider 的模型目录默认 `inputModalities` 由 ["text"] 改为
//   ["text","image"]。静态默认模型与实时发现采纳的新模型都会声明图片输入，
//   使内核原生 ImageBlock → provider image_url/file_id 链路生效，read_image
//   工具与附件准入也按此模态放行。定价仍由用户在余额定价面板手动补充；
//   上下文窗口由发现结果按 256k 给出。
//
// 补丁 2 webui-vision-fallback-off：
//   `dsh-webui` 辅助视觉的自动降级 `textModelImageFallback` 默认由 true 改为
//   false。该降级会绕过主模型能力、把附件图片交给另一个视觉模型（默认
//   sensenova/sensenova-6.8-flash-lite）转写成文本，并包装 resolveModelInfo
//   掩盖真实模态——这正是「专门的图像解析模型」。关闭后图片一律交给原生模型；
//   模型确实不支持图片时由内核按原生规则拒绝，`vision_describe` 工具仍可按需
//   显式调用（浏览器截图等场景不受影响）。
import fs from 'node:fs';
import path from 'node:path';

const DEEPSEEK_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const WEBUI_VISION_HELPER = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'vision-helper.js'];

/** 受控补丁清单：稳定锚点、幂等替换，目标缺失或上游改写时安全跳过。 */
export const SEED_PATCHES = Object.freeze([
  Object.freeze({
    id: 'deepseek-native-image',
    file: DEEPSEEK_MODULE,
    label: 'dsh-llm-deepseek module',
    from: 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),',
    to: 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text","image"]),',
  }),
  Object.freeze({
    id: 'webui-vision-fallback-off',
    file: WEBUI_VISION_HELPER,
    label: 'dsh-webui vision-helper module',
    from: 'textModelImageFallback: z.boolean().default(true),',
    to: 'textModelImageFallback: z.boolean().default(false),',
  }),
]);

/**
 * Apply one controlled patch to a packaged seed root.
 * Idempotent: a second call reports `applied: false`.
 * @param {string} seedRoot - path to the packaged profile seed (…/profile-seed).
 * @param {{id: string, file: string[], label: string, from: string, to: string}} patch - controlled patch descriptor.
 * @returns {{id: string, applied: boolean, reason?: string, file?: string}}
 */
function patchOnce(seedRoot, patch) {
  const file = path.join(seedRoot, ...patch.file);
  if (!fs.existsSync(file)) return { id: patch.id, applied: false, reason: `${patch.label} not present` };
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(patch.to)) return { id: patch.id, applied: false, reason: 'already patched', file };
  if (!source.includes(patch.from)) return { id: patch.id, applied: false, reason: 'target default not found (upstream changed?)', file };
  source = source.replace(patch.from, patch.to);
  fs.writeFileSync(file, source);
  return { id: patch.id, applied: true, file };
}

/**
 * Apply every controlled seed patch to a packaged seed root.
 * A missing or reworded target skips only its own patch.
 * @param {string} seedRoot - path to the packaged profile seed (…/profile-seed).
 * @returns {{id: string, applied: boolean, reason?: string, file?: string}[]} one result per patch, in patch order.
 */
export function applySeedPatches(seedRoot) {
  return SEED_PATCHES.map((patch) => patchOnce(seedRoot, patch));
}
