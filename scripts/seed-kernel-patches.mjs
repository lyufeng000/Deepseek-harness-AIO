// 受控种子补丁：只作用于打包进应用的 profile seed 副本，不改上游审核快照。
//
// 补丁 1：DeepSeek 官方 provider 的模型目录默认 `inputModalities` 由 ["text"]
// 改为 ["text","image"]，让实时发现采纳的新模型默认具备识图能力。定价仍由用户
// 在余额定价面板手动补充；上下文窗口由发现结果按 256k 给出。
import fs from 'node:fs';
import path from 'node:path';

const DEEPSEEK_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const FROM = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),';
const TO = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text","image"]),';

/**
 * Apply the reviewed kernel patch to a profile seed root.
 * Idempotent: a second call reports `applied: false`.
 * @param {string} seedRoot - path to the packaged profile seed (…/profile-seed).
 * @returns {{applied: boolean, reason?: string, file?: string}}
 */
export function patchSeedKernel(seedRoot) {
  const file = path.join(seedRoot, ...DEEPSEEK_MODULE);
  if (!fs.existsSync(file)) return { applied: false, reason: 'dsh-llm-deepseek module not present' };
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(TO)) return { applied: false, reason: 'already patched', file };
  if (!source.includes(FROM)) return { applied: false, reason: 'target default not found (upstream changed?)', file };
  source = source.replace(FROM, TO);
  fs.writeFileSync(file, source);
  return { applied: true, file };
}
