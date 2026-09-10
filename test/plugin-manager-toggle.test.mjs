import test from 'node:test';
import assert from 'node:assert/strict';
import { togglePluginInPatch, ensurePluginDisabledInPatch, removePluginFromPatch, hasEntryId } from '../scripts/plugin-manager-patch.js';

// EAC 重写后的回归：上游正则版会吞掉目标条目之后的兄弟条目（数据丢失）。
test('禁用中位条目不吞兄弟条目（上游 bug 回归）', () => {
  const t = '- insert:\n    - id: first\n      name: a\n    - id: navbar\n      name: n\n    - id: last\n      name: c\n';
  const r = togglePluginInPatch(t, 'navbar', false, 'n');
  assert.ok(r.includes('- id: first'), 'first 必须保留');
  assert.ok(r.includes('- id: last'), 'last 必须保留');
  assert.ok(/- id: navbar\n  name: 'n'\n  disabled: true/.test(r), 'navbar 应有顶层禁用条目');
});

test('禁用首位/末位条目同样不吞兄弟条目', () => {
  const t = '- insert:\n    - id: first\n      name: a\n    - id: second\n      name: b\n';
  const r1 = togglePluginInPatch(t, 'first', false, 'a');
  assert.ok(r1.includes('- id: second'), 'second 必须保留');
  const r2 = togglePluginInPatch(t, 'second', false, 'b');
  assert.ok(r2.includes('- id: first'), 'first 必须保留');
});

test('切换 dsh-undo 不得误匹配并删除 dsh-undo-settings', () => {
  const t = '- insert:\n    - id: dsh-undo\n      name: dsh-undo\n    - id: dsh-undo-settings\n      name: dsh-undo-settings\n';
  const r = togglePluginInPatch(t, 'dsh-undo', false, 'dsh-undo');
  assert.ok(r.includes('- id: dsh-undo-settings'), 'dsh-undo-settings 必须保留');
  assert.ok(r.includes('name: dsh-undo-settings'), '设置插件包名必须保留');
  assert.ok(/- id: dsh-undo\n  name: 'dsh-undo'\n  disabled: true/.test(r), 'dsh-undo 应被单独关闭');
});

test('hasEntryId：短 id 不得误命中长 id 兄弟（前缀 bug 回归）', () => {
  const onlyLong = '- insert:\n    - id: dsh-undo-settings\n      name: dsh-undo-settings\n';
  assert.equal(hasEntryId(onlyLong, 'dsh-undo'), false, 'dsh-undo 不得命中 dsh-undo-settings 行');
  assert.equal(hasEntryId(onlyLong, 'dsh-undo-settings'), true, '完整 id 应命中 insert 内层行');
  assert.equal(hasEntryId('- id: dsh-undo\n  name: dsh-undo\n', 'dsh-undo'), true, '顶层行命中');
  assert.equal(hasEntryId('    - id: dsh-undo\n', 'dsh-undo'), true, 'insert 内层行命中');
  assert.equal(hasEntryId('', 'dsh-undo'), false, '空文本不命中');
  assert.equal(hasEntryId('- id: dsh-undo-settings\n', 'dsh-undo-settings'), true);
});

test('默认禁用配套插件的完整生命周期（dsh-skin-switch 场景）', () => {
  // syncCompanionPlugins 写入的 insert 行（disabled: true 注册）
  let t = '- insert:\n    - id: dsh-skin-switch\n      name: \'dsh-skin-switch\'\n      disabled: true\n    - id: navbar\n      name: \'n\'\n';
  // 用户启用：insert 内层 disabled 行移除，兄弟条目不动。
  const r1 = togglePluginInPatch(t, 'dsh-skin-switch', true, 'dsh-skin-switch');
  assert.ok(!r1.includes('disabled'), '启用后不应再有 disabled 行');
  assert.ok(r1.includes('- id: navbar'), 'navbar 必须保留');
  // 用户再禁用：移到顶层带 disabled。
  const r2 = togglePluginInPatch(r1, 'dsh-skin-switch', false, 'dsh-skin-switch');
  assert.ok(/- id: dsh-skin-switch\n  name: 'dsh-skin-switch'\n  disabled: true/.test(r2));
  // 再启用：保留顶层裸条目（防 sync 重新插回 disabled 行）。
  const r3 = togglePluginInPatch(r2, 'dsh-skin-switch', true, 'dsh-skin-switch');
  assert.ok(/- id: dsh-skin-switch\n  name: 'dsh-skin-switch'/.test(r3));
  assert.ok(!r3.includes('disabled'));
});

test('带 config 的顶层条目（llm-deepseek 场景）：开关不丢 config', () => {
  let t = '- id: llm-deepseek\n  name: \'@deepseek-ai/dsh-llm-deepseek\'\n  config:\n    apiKey: abc\n';
  const r1 = togglePluginInPatch(t, 'llm-deepseek', false, '@deepseek-ai/dsh-llm-deepseek');
  assert.ok(r1.includes('apiKey: abc'), 'config 必须保留');
  assert.ok(r1.includes('disabled: true'));
  const r2 = togglePluginInPatch(r1, 'llm-deepseek', true, '@deepseek-ai/dsh-llm-deepseek');
  assert.ok(r2.includes('apiKey: abc'), 'config 必须保留');
  assert.ok(!r2.includes('disabled'));
});

test('id 白名单：非法字符拒绝（防注入）', () => {
  assert.throws(() => togglePluginInPatch('- insert:\n', 'a b', false), /非法字符/);
  assert.throws(() => togglePluginInPatch('', '../evil', false), /非法字符/);
});

test('禁用后留下空 insert 块会被清理', () => {
  const t = '- insert:\n    - id: solo\n      name: s\n';
  const r = togglePluginInPatch(t, 'solo', false, 's');
  assert.ok(!r.includes('- insert:'), '空块应清理');
  assert.ok(r.includes('- id: solo'));
});

test('移除：清掉 insert 内层条目且不伤兄弟条目', () => {
  const t = '- insert:\n    - id: dsh-skin-switch\n      name: \'dsh-skin-switch\'\n      disabled: true\n    - id: navbar\n      name: n\n    - id: last\n      name: c\n';
  const r = removePluginFromPatch(t, 'dsh-skin-switch');
  assert.ok(!r.includes('dsh-skin-switch'), '目标 id 不应再出现');
  assert.ok(r.includes('- id: navbar'), 'navbar 必须保留');
  assert.ok(r.includes('- id: last'), 'last 必须保留');
});

test('移除：顶层条目 + 关闭标记注释一并清除', () => {
  const t = '# 插件管理（设置页「插件」栏）：关闭 dsh-skin-switch\n- id: dsh-skin-switch\n  name: \'dsh-skin-switch\'\n  disabled: true\n';
  const r = removePluginFromPatch(t, 'dsh-skin-switch');
  assert.ok(!r.includes('dsh-skin-switch'), '顶层条目与注释都应清除');
});

test('移除：最后一个条目清空后留下空 insert 块会被清理', () => {
  const t = '- insert:\n    - id: solo\n      name: s\n';
  const r = removePluginFromPatch(t, 'solo');
  assert.ok(!r.includes('- insert:'), '空块应清理');
  assert.ok(!r.includes('solo'));
});

test('移除：id 白名单校验（防注入）', () => {
  assert.throws(() => removePluginFromPatch('- insert:\n', 'a b'), /非法字符/);
  assert.throws(() => removePluginFromPatch('', '../evil'), /非法字符/);
});

test('默认关闭迁移保留 insert 位置与 config，且重复执行不变化', () => {
  const t = "- insert:\n    - id: composer-dynamic-island\n      name: 'dsh-composer-dynamic-island'\n      config: {}\n    - id: sibling\n      name: 'sibling'\n";
  const once = ensurePluginDisabledInPatch(t, 'composer-dynamic-island', 'dsh-composer-dynamic-island');
  assert.match(once, /- id: composer-dynamic-island\n      name: 'dsh-composer-dynamic-island'\n      config: {}\n      disabled: true/);
  assert.ok(once.includes('- id: sibling'), '兄弟条目必须保留');
  assert.equal(ensurePluginDisabledInPatch(once, 'composer-dynamic-island', 'dsh-composer-dynamic-island'), once, '已禁用时保持幂等');
});

test('默认关闭迁移可修正 disabled: false，也可补写缺失条目', () => {
  const t = "- id: composer-dynamic-island\n  name: 'dsh-composer-dynamic-island'\n  disabled: false\n";
  const fixed = ensurePluginDisabledInPatch(t, 'composer-dynamic-island', 'dsh-composer-dynamic-island');
  assert.match(fixed, /disabled: true/);
  const appended = ensurePluginDisabledInPatch('- insert:\n', 'composer-dynamic-island', 'dsh-composer-dynamic-island');
  assert.match(appended, /- id: composer-dynamic-island\n  name: 'dsh-composer-dynamic-island'\n  disabled: true/);
});
