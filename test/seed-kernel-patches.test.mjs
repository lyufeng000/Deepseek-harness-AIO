'use strict';

// 受控种子补丁的幂等性与边界测试。
//
// 补丁 1：dsh-llm-deepseek 模型默认 inputModalities 含 image（原生多模态）。
// 补丁 2：dsh-webui 辅助视觉自动降级默认关闭（图片交给原生模型解析）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySeedPatches, SEED_PATCHES } from '../scripts/seed-kernel-patches.mjs';

const DEEPSEEK_MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const WEBUI_VISION_HELPER = ['profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui', 'lib', 'vision-helper.js'];

const FROM = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),';
const TO = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text","image"]),';
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

const deepseekBody = (anchor = FROM) => `const catalogModel = z.object({\n  ${anchor}\n});\n`;
const visionBody = (anchor = VISION_FROM) => `export const Config = z.object({\n    ${anchor}\n});\n`;

test('补丁清单声明七个受控目标，路径与文件名稳定', () => {
  assert.deepEqual(SEED_PATCHES.map((p) => p.id), ['deepseek-native-image', 'webui-vision-fallback-off', 'status-rotator-pill-default-off', 'status-rotator-example-pill-off', 'status-rotator-settings-inject', 'webui-done-sound-row-remove', 'webui-done-sound-reporting-remove']);
  assert.deepEqual(SEED_PATCHES[0].file, DEEPSEEK_MODULE);
  assert.deepEqual(SEED_PATCHES[1].file, WEBUI_VISION_HELPER);
});

test('打包编排对 staging 副本执行全部受控补丁', () => {
  const source = fs.readFileSync(new URL('../scripts/prepare-aio.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ applySeedPatches \} from '\.\/seed-kernel-patches\.mjs';/);
  assert.match(source, /applySeedPatches\(resolve\('tauri-app\/resources\/profile-seed'\)\)/);
  assert.ok(!source.includes('patchSeedKernel('), 'staging 必须执行全部受控补丁，不能只跑 DeepSeek 补丁');
});

test('补丁把 DeepSeek 模型默认 inputModalities 改为包含 image，且幂等', (t) => {
  const root = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: deepseekBody() });
  const file = path.join(root, ...DEEPSEEK_MODULE);
  const first = applySeedPatches(root)[0];
  assert.equal(first.applied, true);
  assert.equal(first.id, 'deepseek-native-image');
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(TO));
  assert.ok(!patched.includes(FROM));
  const second = applySeedPatches(root)[0];
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
});

test('DeepSeek 目标文件缺失或上游代码变化时安全跳过且不写文件', (t) => {
  const missing = seedWith(t);
  assert.deepEqual(applySeedPatches(missing)[0], { id: 'deepseek-native-image', applied: false, reason: 'dsh-llm-deepseek module not present' });

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
  const [deepseek, vision] = applySeedPatches(root);
  assert.equal(deepseek.applied, false);
  assert.equal(deepseek.reason, 'dsh-llm-deepseek module not present');
  assert.equal(vision.id, 'webui-vision-fallback-off');
  assert.equal(vision.applied, true);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(VISION_TO));
  assert.ok(!patched.includes(VISION_FROM));
  const second = applySeedPatches(root)[1];
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
});

test('dsh-webui 目标缺失或上游改写时只跳过该补丁，不影响 DeepSeek 补丁', (t) => {
  const root = seedWith(t, { [DEEPSEEK_MODULE.join('/')]: deepseekBody('upstream reworded'), [WEBUI_VISION_HELPER.join('/')]: 'unrelated\n' });
  const [deepseek, vision] = applySeedPatches(root);
  assert.equal(deepseek.applied, false);
  assert.match(deepseek.reason, /target default not found/);
  assert.equal(vision.applied, false);
  assert.match(vision.reason, /target default not found/);
  assert.equal(fs.readFileSync(path.join(root, ...WEBUI_VISION_HELPER), 'utf8'), 'unrelated\n');

  const missing = seedWith(t);
  const results = applySeedPatches(missing);
  assert.deepEqual(results.map((r) => r.id), ['deepseek-native-image', 'webui-vision-fallback-off', 'status-rotator-pill-default-off', 'status-rotator-example-pill-off', 'status-rotator-settings-inject', 'webui-done-sound-row-remove', 'webui-done-sound-reporting-remove']);
  assert.ok(results.every((r) => r.applied === false));
  assert.deepEqual(results[1].reason, 'dsh-webui vision-helper module not present');
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
