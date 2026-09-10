'use strict';

// 受控种子补丁的幂等性与边界测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchSeedKernel } from '../scripts/seed-kernel-patches.mjs';

const MODULE = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'];
const FROM = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),';
const TO = 'inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text","image"]),';

function seedWith(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (body !== undefined) {
    const file = path.join(root, ...MODULE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

test('补丁把 DeepSeek 模型默认 inputModalities 改为包含 image，且幂等', (t) => {
  const root = seedWith(t, `const catalogModel = z.object({\n  ${FROM}\n});\n`);
  const file = path.join(root, ...MODULE);
  const first = patchSeedKernel(root);
  assert.equal(first.applied, true);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(TO));
  assert.ok(!patched.includes(FROM));
  const second = patchSeedKernel(root);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
});

test('目标文件缺失或上游代码变化时安全跳过且不写文件', (t) => {
  const missing = seedWith(t, undefined);
  assert.deepEqual(patchSeedKernel(missing), { applied: false, reason: 'dsh-llm-deepseek module not present' });

  const changed = seedWith(t, 'const unrelated = true;\n');
  const before = fs.readFileSync(path.join(changed, ...MODULE), 'utf8');
  const result = patchSeedKernel(changed);
  assert.equal(result.applied, false);
  assert.match(result.reason, /target default not found/);
  assert.equal(fs.readFileSync(path.join(changed, ...MODULE), 'utf8'), before);
});
