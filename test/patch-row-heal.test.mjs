import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { configLinesFor, normalizeRowConfigIndent, removeBundledRowDuplicates, bundlePatchEntryIds, collectBundleEntryIds } = require(join(root, 'legacy/electron/patch-row-heal.js'));

test('configLinesFor 生成合法 patch YAML', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }), '      config:\n        path: "soul.md"\n');
});

// 向导/插件管理写的是顶层行（`- id:` 在列 0），config 缩进必须跟着行走：
// 顶层行用 2/4，insert 块内行用 6/8，混用会让 dsh-app-boot 解析 patch 直接
// 报 YAMLException（bad indentation of a mapping entry）→ dsh web 退出 1。
test('configLinesFor 顶层行缩进（baseIndent=0 → 2/4）', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }, 0), '  config:\n    path: "soul.md"\n');
});

// 存量坏行自愈：旧 build 把 6 空格 config 贴到顶层行上，YAML 直接解析失败。
test('normalizeRowConfigIndent 修复顶层行的缩进错位 config（存量坏行）', () => {
  const bad = "- id: dsh-undo\n  name: 'dsh-undo-savepoint'\n      config:\n        path: \"undo.json\"\n  disabled: true\n";
  const out = normalizeRowConfigIndent(bad, 'dsh-undo');
  assert.equal(out, "- id: dsh-undo\n  name: 'dsh-undo-savepoint'\n  config:\n    path: \"undo.json\"\n  disabled: true\n");
});

test('normalizeRowConfigIndent 幂等且不碰 insert 块内合法行', () => {
  const ok = '- insert:\n    - id: dsh-undo\n      name: \'dsh-undo-savepoint\'\n      config:\n        path: "undo.json"\n';
  assert.equal(normalizeRowConfigIndent(ok, 'dsh-undo'), ok, 'insert 块内 6/8 缩进合法，不动');
  const topOk = "- id: dsh-undo\n  name: 'dsh-undo-savepoint'\n  config:\n    path: \"undo.json\"\n";
  assert.equal(normalizeRowConfigIndent(topOk, 'dsh-undo'), topOk, '顶层 2/4 缩进合法，不动');
});

test('normalizeRowConfigIndent 不把长 id 兄弟误当目标行（前缀 bug 回归）', () => {
  // 传短 id dsh-undo 时不得碰 dsh-undo-savepoint 行（旧 \b 词边界会误命中）。
  const bad = "- id: dsh-undo-savepoint\n  name: 'dsh-undo-savepoint'\n    config:\n      x: 1\n";
  assert.equal(normalizeRowConfigIndent(bad, 'dsh-undo'), bad, '短 id 不得误改长 id 兄弟的 config 缩进');
  const fixed = normalizeRowConfigIndent(bad, 'dsh-undo-savepoint');
  assert.ok(fixed.includes('  config:\n    x: 1\n'), '正确 id 应修复错位缩进');
});

// 市场安装（dsh plugin add 登记 bundles）与 overlay 写行双挂载 →
// "duplicate loader entry id" 拖垮插件树。overlay 重复行必须被移除。
test('removeBundledRowDuplicates: 删 bundle 已登记的 overlay 行', () => {
  const patch = [
    '- insert:',
    '    - id: skin-switch',
    "      name: '@deepseek-ai/dsh-skin-switch'",
    '      config:',
    '        path: "skin.json"',
    '- insert:',
    '    - id: better-sidebar',
    "      name: 'dsh-better-sidebar'",
    '- insert:',
    '    - id: plugin-shield',
    "      name: 'dsh-plugin-shield'",
    '',
  ].join('\n');
  const rowIds = { 'skin-switch': '@deepseek-ai/dsh-skin-switch', 'better-sidebar': 'dsh-better-sidebar', 'plugin-shield': 'dsh-plugin-shield' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-better-sidebar']);
  assert.deepEqual(removed, ['better-sidebar']);
  assert.doesNotMatch(out, /better-sidebar/);
  assert.match(out, /- id: skin-switch[\s\S]*path: "skin\.json"/, '相邻块的 config 完整保留');
  assert.match(out, /- id: plugin-shield/);
});

test('removeBundledRowDuplicates: 无 bundle 登记时不动任何行', () => {
  const patch = '- insert:\n    - id: better-sidebar\n      name: \'dsh-better-sidebar\'\n';
  const rowIds = { 'better-sidebar': 'dsh-better-sidebar' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, []);
  assert.deepEqual(removed, []);
  assert.equal(out, patch);
});

test('removeBundledRowDuplicates: 非 uninstall 目标插件（tts 等）不受影响', () => {
  const patch = '- insert:\n    - id: tts\n      name: \'@dsh-external/dsh-plugin-tts\'\n';
  const rowIds = { 'better-sidebar': 'dsh-better-sidebar' };
  const { removed } = removeBundledRowDuplicates(patch, rowIds, ['@dsh-external/dsh-plugin-tts']);
  assert.deepEqual(removed, [], 'rowIds 不含 tts，即使 bundle 里有也不动');
});

// issue #16：git/fork/link 安装的 bundle 包名与 overlay 行包名不一致，
// 但 entry id 相同 —— 旧「按包名匹配」删不掉，必须按 id 去重。
test('removeBundledRowDuplicates: 按 bundle 声明的 entry id 去重（跨包名，issue #16）', () => {
  const patch = [
    '- insert:',
    '    - id: skin-switch',
    "      name: '@deepseek-ai/dsh-skin-switch'",
    '- insert:',
    '    - id: better-sidebar',
    "      name: 'dsh-better-sidebar'",
    '',
  ].join('\n');
  const rowIds = { 'skin-switch': '@deepseek-ai/dsh-skin-switch', 'better-sidebar': 'dsh-better-sidebar' };
  // bundle 是 git fork：包名 skin-switch-local，但包内 patch 声明 id: skin-switch。
  const bundleEntryIds = new Set(['skin-switch']);
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['skin-switch-local'], bundleEntryIds);
  assert.deepEqual(removed, ['skin-switch']);
  assert.doesNotMatch(out, /skin-switch/);
  assert.match(out, /- id: better-sidebar/, '无关行保留');
});

test('removeBundledRowDuplicates: bundleEntryIds 为空时退化为原有按包名行为', () => {
  const patch = '- insert:\n    - id: better-sidebar\n      name: \'dsh-better-sidebar\'\n';
  const rowIds = { 'better-sidebar': 'dsh-better-sidebar' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-better-sidebar'], new Set());
  assert.deepEqual(removed, ['better-sidebar']);
  assert.doesNotMatch(out, /better-sidebar/);
});

// 收集函数：从 bundle 包目录解析 patch 声明的 entry id（含 dsh.bundle.patch 指向）。
test('bundlePatchEntryIds / collectBundleEntryIds: 解析包内 patch 的 entry id', () => {
  const dir = join(root, 'tmp-test-patch-heal', 'node_modules');
  const pkgDir = join(dir, 'skin-switch-local');
  const fs = require('node:fs');
  fs.mkdirSync(pkgDir, { recursive: true });
  try {
    fs.writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'skin-switch-local',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }));
    fs.writeFileSync(join(pkgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: skin-switch\n      name: \'skin-switch-local\'\n');
    const ids = collectBundleEntryIds(['skin-switch-local'], dir);
    assert.deepEqual([...ids], ['skin-switch']);
    assert.equal(bundlePatchEntryIds(pkgDir).has('skin-switch'), true);
  } finally {
    fs.rmSync(join(root, 'tmp-test-patch-heal'), { recursive: true, force: true, maxRetries: 5 });
  }
});