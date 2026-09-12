'use strict';

// 受控种子补丁的幂等性与边界测试。
//
// 受控补丁必须精确命中审核种子，并保持幂等。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySeedPatches, mirroredFile, SEED_PATCHES } from '../scripts/seed-kernel-patches.mjs';

const DEEPSEEK_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const WEBUI_VISION_HELPER = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'vision-helper.js'];
const WORKSPACE_CLIENT = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'];

const VISION_FROM = 'textModelImageFallback: z.boolean().default(true),';
const VISION_TO = 'textModelImageFallback: z.boolean().default(false),';

function seedWith(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [segments, body] of Object.entries(files)) {
    const file = path.join(root, ...segments.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

const visionBody = (anchor = VISION_FROM) => `export const Config = z.object({\n    ${anchor}\n});\n`;

test('补丁清单覆盖本轮全部事实源，路径稳定', () => {
  const ids = new Set(SEED_PATCHES.map((p) => p.id));
  for (const id of [
    'deepseek-flash-model-id', 'deepseek-model-common-input-field',
    'deepseek-known-model-capabilities', 'deepseek-config-schema-wrapper',
    'deepseek-config-settings-path', 'deepseek-onboarding-nested-path',
    'agent-instructions-init-refresh',
    'provider-deepseek-official-icon', 'webui-markdown-stable-layout',
    'webui-markdown-no-node-virtualization', 'custom-motion-transcript-fade-only',
    'custom-marketplace-default-url', 'webui-vision-fallback-off',
    'workspace-blank-session-skip-engaged',
  ]) assert.ok(ids.has(id), `missing ${id}`);
  assert.deepEqual(SEED_PATCHES[0].file, DEEPSEEK_MODULE);
  assert.deepEqual(SEED_PATCHES.find((p) => p.id === 'webui-vision-fallback-off').file, WEBUI_VISION_HELPER);
  assert.deepEqual(SEED_PATCHES.find((p) => p.id === 'workspace-blank-session-skip-engaged').file, WORKSPACE_CLIENT);
});

test('打包编排对 staging 副本执行全部受控补丁', () => {
  const source = fs.readFileSync(new URL('../scripts/prepare-aio.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ applySeedPatches \} from '\.\/seed-kernel-patches\.mjs';/);
  assert.match(source, /applySeedPatches\(resolve\('tauri-app\/resources\/profile-seed'\), \{ strict: true \}\)/);
  assert.ok(!source.includes('patchSeedKernel('), 'staging 必须执行全部受控补丁，不能只跑 DeepSeek 补丁');
  assert.match(source, /applySeedPatches\(resolve\('tauri-app\/resources\/app'\), \{ planes: \['app'\], strict: true \}\)/);
});

test('DeepSeek 补丁统一配置路径和 input 字段，并精确声明 Flash 图片能力', (t) => {
  const patches = SEED_PATCHES.filter((p) => p.file === DEEPSEEK_MODULE || JSON.stringify(p.file) === JSON.stringify(DEEPSEEK_MODULE));
  const body = patches.map((p) => p.count === 2 ? `${p.from}\n${p.from}` : p.from).join('\n');
  const root = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: body });
  const file = path.join(root, ...DEEPSEEK_MODULE);
  const first = applySeedPatches(root);
  for (const patch of patches) assert.equal(first.find((row) => row.id === patch.id).applied, true, patch.id);
  const patched = fs.readFileSync(file, 'utf8');
  assert.match(patched, /id: "deepseek-flash"[\s\S]*?input: \["text", "image"\]/);
  assert.match(patched, /const Config = z\.object\(\{ providers: z\.dict\(ProviderConfig\)/);
  assert.match(patched, /settingsPath: \["providers", PROVIDER\]/);
  assert.match(patched, /const declared = model\.input\?\.length/);
  assert.match(patched, /inputModalities: z\.array\(z\.union\(MODEL_MODALITIES\)\)/);
  // input 不能是必填：缺少该字段的模型条目（例如设置 UI 写回 inputModalities）会让整份设置解析抛错。
  assert.ok(!patched.includes('input: z.array(z.union(MODEL_MODALITIES)).min(1),'), 'input 必须是可选字段');
  const second = applySeedPatches(root);
  for (const patch of patches) assert.equal(second.find((row) => row.id === patch.id).reason, 'already patched', patch.id);
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
});

test('普通检查可报告缺失；打包严格模式会阻断关键补丁漂移', (t) => {
  const missing = seedWith(t);
  assert.deepEqual(applySeedPatches(missing)[0], { id: 'deepseek-flash-model-id', applied: false, reason: 'dsh-llm-deepseek module not present' });
  assert.throws(() => applySeedPatches(missing, { strict: true }), /Required seed patches did not match/);

  const changed = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: 'const unrelated = true;\n' });
  const before = fs.readFileSync(path.join(changed, ...DEEPSEEK_MODULE), 'utf8');
  const result = applySeedPatches(changed)[0];
  assert.equal(result.applied, false);
  assert.match(result.reason, /target default not found/);
  assert.equal(fs.readFileSync(path.join(changed, ...DEEPSEEK_MODULE), 'utf8'), before);
});

test('补丁关闭 dsh-webui 辅助视觉自动降级，且幂等', (t) => {
  const root = seedWith(t, { [WEBUI_VISION_HELPER.join('/')]: visionBody() });
  const file = path.join(root, ...WEBUI_VISION_HELPER);
  const results = applySeedPatches(root);
  const vision = results.find((row) => row.id === 'webui-vision-fallback-off');
  assert.equal(vision.id, 'webui-vision-fallback-off');
  assert.equal(vision.applied, true);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(VISION_TO));
  assert.ok(!patched.includes(VISION_FROM));
  const second = applySeedPatches(root).find((row) => row.id === 'webui-vision-fallback-off');
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
});

test('dsh-webui 目标缺失或上游改写时只跳过该补丁，不影响 DeepSeek 补丁', (t) => {
  const root = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: 'upstream reworded\n', [WEBUI_VISION_HELPER.join('/')]: 'unrelated\n' });
  const results = applySeedPatches(root);
  const vision = results.find((row) => row.id === 'webui-vision-fallback-off');
  assert.equal(vision.applied, false);
  assert.match(vision.reason, /target default not found/);
  assert.equal(fs.readFileSync(path.join(root, ...WEBUI_VISION_HELPER), 'utf8'), 'unrelated\n');

  const missing = seedWith(t);
  const missingResults = applySeedPatches(missing);
  assert.ok(missingResults.some((r) => r.id === 'custom-marketplace-default-url'));
  assert.ok(missingResults.every((r) => r.applied === false));
  assert.equal(missingResults.find((r) => r.id === 'webui-vision-fallback-off').reason, 'dsh-webui vision-helper module not present');
});

test('补丁关闭 status-rotator Pill 默认值并改 inject，且幂等', (t) => {
  const clientFile = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'lib', 'client.js'];
  const hostFile = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'lib', 'index.js'];
  const exampleFile = ['profiles', 'web-desktop', 'node_modules', 'dsh-status-rotator', 'config.example.json'];
  const pill = SEED_PATCHES.find((p) => p.id === 'status-rotator-pill-default-off');
  const example = SEED_PATCHES.find((p) => p.id === 'status-rotator-example-pill-off');
  const inject = SEED_PATCHES.find((p) => p.id === 'status-rotator-settings-inject');
  const root = seedWith(t, {
    [clientFile.join('/')]: `prefix\n${pill.from}\nsuffix\n`,
    [hostFile.join('/')]: `prefix\n${inject.from}\nsuffix\n`,
    [exampleFile.join('/')]: `prefix\n${example.from}\nsuffix\n`,
  });
  const results = applySeedPatches(root);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['status-rotator-pill-default-off'].applied, true);
  assert.equal(byId['status-rotator-example-pill-off'].applied, true);
  assert.equal(byId['status-rotator-settings-inject'].applied, true);
  assert.ok(fs.readFileSync(path.join(root, ...clientFile), 'utf8').includes(pill.to));
  assert.ok(fs.readFileSync(path.join(root, ...exampleFile), 'utf8').includes(example.to));
  assert.ok(fs.readFileSync(path.join(root, ...hostFile), 'utf8').includes(inject.to));
  const second = applySeedPatches(root);
  assert.equal(second.find((r) => r.id === 'status-rotator-pill-default-off').reason, 'already patched');
  assert.equal(second.find((r) => r.id === 'status-rotator-example-pill-off').reason, 'already patched');
  assert.equal(second.find((r) => r.id === 'status-rotator-settings-inject').reason, 'already patched');
});

test('补丁移除 dsh-webui 旧提示音设置行与客户端上报，且幂等', (t) => {
  const webuiClientFile = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'client.js'];
  const row = SEED_PATCHES.find((p) => p.id === 'webui-done-sound-row-remove');
  const reporting = SEED_PATCHES.find((p) => p.id === 'webui-done-sound-reporting-remove');
  const root = seedWith(t, {
    [webuiClientFile.join('/')]: `prefix
${row.from}
${reporting.from}
suffix
`,
  });
  const results = applySeedPatches(root);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['webui-done-sound-row-remove'].applied, true);
  assert.equal(byId['webui-done-sound-reporting-remove'].applied, true);
  const patched = fs.readFileSync(path.join(root, ...webuiClientFile), 'utf8');
  assert.ok(patched.includes(row.to));
  assert.ok(patched.includes(reporting.to));
  assert.ok(!patched.includes(row.from));
  assert.ok(!patched.includes(reporting.from));
  const second = applySeedPatches(root);
  assert.equal(second.find((r) => r.id === 'webui-done-sound-row-remove').reason, 'already patched');
  assert.equal(second.find((r) => r.id === 'webui-done-sound-reporting-remove').reason, 'already patched');
});

test('内核包补丁必须同时命中安装闭包副本（app 布局）', (t) => {
  // 运行时的 @deepseek-ai/* 来自 resources/app/node_modules（stage.ts 铺设的安装闭包）；
  // 只打 profile seed 会让补丁在真实实例上失效（1.3.2 的 DeepSeek 原生识图即为此）。
  const mirrored = SEED_PATCHES.filter((p) => mirroredFile(p.file) !== null);
  assert.ok(mirrored.length >= 10, '应覆盖全部内核包补丁');
  for (const p of mirrored) assert.deepEqual(mirroredFile(p.file).slice(0, 2), ['node_modules', '@deepseek-ai']);
  for (const id of ['webui-vision-fallback-off', 'status-rotator-pill-default-off', 'custom-marketplace-default-url']) {
    assert.equal(mirroredFile(SEED_PATCHES.find((p) => p.id === id).file), null, `${id} 只存在于 profile，不应镜像`);
  }

  // 双布局 fixture：每个补丁目标在 profile 与安装闭包各放一份上游原文。
  const files = {};
  for (const p of SEED_PATCHES) {
    const body = p.count === 2 ? `${p.from}\n${p.from}\n` : `${p.from}\n`;
    const keys = [p.file.join('/')];
    const rel = mirroredFile(p.file);
    if (rel !== null) keys.push(rel.join('/'));
    for (const key of keys) files[key] = (files[key] ?? '') + body;
  }
  const root = seedWith(t, files);
  const appAdapter = path.join(root, ...mirroredFile(DEEPSEEK_MODULE));
  const profileAdapter = path.join(root, ...DEEPSEEK_MODULE);
  const profileBefore = fs.readFileSync(profileAdapter, 'utf8');

  const appResults = applySeedPatches(root, { planes: ['app'], strict: true });
  assert.equal(appResults.length, mirrored.length, 'app 面只处理内核包补丁');
  assert.ok(appResults.every((row) => row.applied === true), 'app 面补丁应全部命中');
  assert.equal(fs.readFileSync(profileAdapter, 'utf8'), profileBefore, 'app 面不得改动 profile 副本');
  const patchedAdapter = fs.readFileSync(appAdapter, 'utf8');
  assert.match(patchedAdapter, /id: "deepseek-flash"[\s\S]*?input: \["text", "image"\]/);
  assert.match(patchedAdapter, /const declared = model\.input\?\.length/);

  const second = applySeedPatches(root, { planes: ['app'], strict: true });
  assert.ok(second.every((row) => row.applied === false && row.reason === 'already patched'));

  // 安装闭包缺包时，app 面严格模式必须阻断构建，而不是静默跳过。
  const bare = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: `${SEED_PATCHES[0].from}\n` });
  assert.equal(applySeedPatches(bare, { planes: ['app'] })[0].reason, 'dsh-llm-deepseek module not present');
  assert.throws(() => applySeedPatches(bare, { planes: ['app'], strict: true }), /Required seed patches did not match/);
});
