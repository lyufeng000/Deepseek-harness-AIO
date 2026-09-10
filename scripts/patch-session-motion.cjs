'use strict';

/**
 * session-motion 残留变换补丁（@dsh-external/dsh-webui@0.5.1）。
 *
 * 现状：插件 `src/client/session-motion.ts` 给会话内容区注入
 *
 *   [data-conversation-scroll] :is([class*="viewArea"], [class*="composerHero"]) {
 *     animation: dsh-webui-swap-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
 *   }
 *
 * 关键帧收尾是 `transform: translateY(0)`。fill-mode `both` 让这条「单位矩阵」
 * 在动画结束后永久留在消息区根盒（ConversationRoot 的 .viewArea）上，该盒
 * 因此成为 fixed/absolute 后代的包含块，并在滚动容器里单独成层。这同时破坏
 * 两条上游不变量：
 *  - ui-conversation 的 .composerHero 注释明令该盒不得出现 transform（否则
 *    pickers/modals 这类 position:fixed 后代改以它为包含块，位置/尺寸缩水）；
 *  - ui-chat 的阅读几何要求行与滚动端口同处一个坐标系
 *    （flowTop(row, scrollport) = row.top - scrollport.top）。祖先带变换期间行
 *    rect 被位移而滚动端口 rect 不变，量出的锚点最多偏 10px，切换会话后的
 *    定位/回底会把偏差写进滚动账本 —— 症状就是滚动消息区时抽动一下。
 *
 * 本补丁把两处入场动画的 fill 改为 backwards（动画结束即回到常态样式），并把
 * 关键帧收尾从 translateY(0) 改成 none：入场观感不变（仍是淡入 + 10px 上浮），
 * 但播完不再留下变换、包含块或合成层。
 *
 * 只作用于 staging 的 seed 副本或用户 profile 副本；版本/指纹不符时 fail
 * closed，重复执行只验证已应用内容，不产生额外改写。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.5.1';
const NAME = '@dsh-external/dsh-webui';
const REGION = '//#region src/client/session-motion.ts';
const END = '//#endregion';
const MARKER = '/* EAC_SESSION_MOTION_NO_RESIDUAL_V1 */';
const SOURCE_HASH = 'dd92c2d9addae33f84ebdd191a985ee0385a949e99d17525761900e967c87b94';

// 三条替换全部落在 session-motion 源码区段内，且在该区段里各只出现一次。
const EDITS = [
  [
    '  animation: dsh-webui-swap-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;\n}',
    '  animation: dsh-webui-swap-in 400ms cubic-bezier(0.16, 1, 0.3, 1) backwards;\n}\n'
      + MARKER,
    1,
  ],
  [
    '  to { opacity: 1; transform: translateY(0); }',
    '  to { opacity: 1; transform: none; }',
    1,
  ],
  [
    '  animation: dsh-webui-swap-fade 300ms ease-out both;',
    '  animation: dsh-webui-swap-fade 300ms ease-out backwards;',
    1,
  ],
];

function replaceStrict(source, before, after, expected = 1) {
  const parts = source.split(before);
  if (parts.length !== expected + 1) {
    throw new Error(`session-motion patch anchor mismatch: expected ${expected}, got ${parts.length - 1}: ${before.slice(0, 100)}`);
  }
  return parts.join(after);
}

function hash(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

/**
 * 把已验证的 0.5.1 客户端包改成「入场动画不残留变换」；已打过补丁时只校验。
 * @param source - lib/client.js 文本。
 * @param metadata - 该包 package.json 内容。
 * @returns {{ source: string, changed: boolean }} 新文本与是否需要写盘。
 */
function transform(source, metadata) {
  if (metadata?.name !== NAME || metadata?.version !== VERSION) {
    throw new Error(`Unsupported session-motion package: ${metadata?.name}@${metadata?.version}; expected ${NAME}@${VERSION}`);
  }
  if (typeof source !== 'string') throw new TypeError('client source must be a string');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.split(REGION).length !== 2) throw new Error('Expected exactly one session-motion source region');
  const start = normalized.indexOf(REGION);
  const end = normalized.indexOf(END, start);
  if (end < 0) throw new Error('Missing session-motion region terminator');
  const region = normalized.slice(start, end);
  if (region.includes('EAC_SESSION_MOTION_NO_RESIDUAL_V') && !region.includes(MARKER)) {
    throw new Error('Unsupported older session-motion patch; restore the verified original client.js before applying V1');
  }
  let original = region;
  const alreadyPatched = region.includes(MARKER);
  if (alreadyPatched) {
    for (const [before, after, count] of [...EDITS].reverse()) {
      original = replaceStrict(original, after, before, count);
    }
  }
  if (hash(original) !== SOURCE_HASH) {
    throw new Error('Unsupported session-motion source fingerprint (modified or unknown build)');
  }
  if (alreadyPatched) return { source, changed: false };
  let patched = original;
  for (const [before, after, count] of EDITS) {
    patched = replaceStrict(patched, before, after, count);
  }
  const result = normalized.slice(0, start) + patched + normalized.slice(end);
  return { source: eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result, changed: true };
}

// A dry run by default. The caller must explicitly authorize a filesystem write.
function apply(packageDir, { write = false } = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const clientPath = path.join(packageDir, 'lib', 'client.js');
  const result = transform(fs.readFileSync(clientPath, 'utf8'), metadata);
  if (write && result.changed) {
    const temp = `${clientPath}.eac-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, result.source, { flag: 'wx' });
      fs.renameSync(temp, clientPath);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  return { ...result, clientPath };
}

module.exports = { transform, apply, EDITS, VERSION, NAME, REGION, END, MARKER, SOURCE_HASH };

if (require.main === module) {
  const args = process.argv.slice(2);
  const write = args[0] === '--write';
  const packageDir = args[write ? 1 : 0];
  if (!packageDir || args.length !== (write ? 2 : 1)) {
    console.error('Usage: node patch-session-motion.cjs [--write] <dsh-webui-package-directory>');
    process.exitCode = 1;
  } else {
    try {
      const result = apply(path.resolve(packageDir), { write });
      console.log(result.changed
        ? (write ? 'session-motion patched' : 'session-motion patch validated (dry run)')
        : 'session-motion already patched and verified');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
