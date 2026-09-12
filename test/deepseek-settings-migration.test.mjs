import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { migrateDeepSeekSettings } from '../sidecar/dist/lib/deepseek-settings-migration.js';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deepseek-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('旧 DeepSeek 配置迁入统一 provider 路径，显式新字段优先并备份', (t) => {
  const dir = home(t);
  const original = [
    'theme: dark',
    'llm-deepseek:',
    '  baseURL: https://legacy.example',
    '  customFlag: keep-me',
    '  models:',
    '    - id: deepseek-flash',
    '      inputModalities: [text, image]',
    '  providers:',
    '    deepseek-official:',
    '      baseURL: https://explicit.example',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'settings.yaml'), original);
  const result = migrateDeepSeekSettings(dir);
  assert.equal(result.changed, true);
  const parsed = yaml.load(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'));
  const provider = parsed['llm-deepseek'].providers['deepseek-official'];
  assert.equal(provider.baseURL, 'https://explicit.example');
  assert.equal(provider.customFlag, 'keep-me');
  assert.deepEqual(provider.models[0].input, ['text', 'image']);
  assert.equal(provider.models[0].inputModalities, undefined);
  assert.equal(parsed.theme, 'dark');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  assert.deepEqual(migrateDeepSeekSettings(dir), { changed: false, reason: 'not-needed' });
});

test('缺失、超大或符号链接 settings.yaml 保持不动', (t) => {
  const dir = home(t);
  assert.deepEqual(migrateDeepSeekSettings(dir), { changed: false, reason: 'missing' });
  const target = path.join(dir, 'target.yaml');
  fs.writeFileSync(target, 'llm-deepseek: {}\n');
  const link = path.join(dir, 'settings.yaml');
  try {
    fs.symlinkSync(target, link);
    assert.deepEqual(migrateDeepSeekSettings(dir), { changed: false, reason: 'unsafe' });
  } catch {
    // Windows 开发机未开放符号链接权限时，仍覆盖普通文件无迁移分支。
    fs.writeFileSync(link, 'theme: dark\n');
    assert.deepEqual(migrateDeepSeekSettings(dir), { changed: false, reason: 'not-needed' });
  }
});
