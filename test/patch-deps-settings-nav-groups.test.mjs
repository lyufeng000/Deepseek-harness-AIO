import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/patch-deps.js 的「更多设置」三级分组补丁：把低频插件设置页从设置
// 弹窗左栏的平铺二级导航里收进一个可折叠父项，展开后以缩进子项呈现。
import { patchSettingsNavGroups } from '../scripts/patch-deps.js';

// 夹具必须逐字复刻上游 SettingsPanel 的两个锚点片段（Tab 缩进 / 引号风格），
// 否则 NAV_PANEL_HEAD_OLD / NAV_LIST_OLD 不命中，补丁会安静跳过。
const PANEL_OLD = [
  '\t\tfunction SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }) {',
  '\t\t\tconst active = rows.find((r) => r.id === activeId)?.id ?? rows[0]?.id;',
].join('\n');

const NAV_OLD = [
  '\t\t\t\t\t\t\tchildren: rows.map((row) => (0, react_jsx_runtime.jsxs)("button", {',
  '\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\tclassName: clsx(SettingsRoot_module_css_default.navCell, row.id === active && SettingsRoot_module_css_default.active),',
  '\t\t\t\t\t\t\t\t"aria-current": row.id === active ? "true" : void 0,',
  '\t\t\t\t\t\t\t\tonClick: () => {',
  '\t\t\t\t\t\t\t\t\tonSelect(row.id);',
  '\t\t\t\t\t\t\t\t},',
  '\t\t\t\t\t\t\t\tchildren: [navIcon(row.id), (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\t\t\t\t\tclassName: SettingsRoot_module_css_default.navLabel,',
  '\t\t\t\t\t\t\t\t\tchildren: row.label',
  '\t\t\t\t\t\t\t\t})]',
  '\t\t\t\t\t\t\t}, row.id))',
].join('\n');

const FIXTURE = [PANEL_OLD, '\t\t\treturn null;', '\t\t}', '/* nav */', NAV_OLD, '/* end */'].join('\n');

function makeRoot(source = FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), 'navgroups-'));
  const lib = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib');
  mkdirSync(lib, { recursive: true });
  const file = join(lib, 'client.js');
  writeFileSync(file, source, 'utf8');
  return { root, file };
}

test('低频设置项收进「更多设置」三级分组', () => {
  const { root, file } = makeRoot();
  const r = patchSettingsNavGroups(root);
  assert.equal(r.patched, true);
  const out = readFileSync(file, 'utf8');
  assert.ok(out.includes('EAC_SETTINGS_NAV_GROUPS_V1'));
  assert.ok(out.includes('AIO_NAV_GROUP_LABEL = "更多设置"'));
  assert.ok(out.includes('["pricing","plugin-shield","mood","memes","dsh-undo","motion","status-rotator"]'));
  assert.ok(out.includes('children: settingsNavRows({'));
  assert.ok(out.includes('paddingLeft: 34'));
  assert.ok(out.includes('const [aioNavGroupOpen, setAioNavGroupOpen] = (0, react.useState)(readAioNavGroupOpen);'));
  assert.ok(out.includes('localStorage.setItem(AIO_NAV_GROUP_KEY'));
  assert.ok(!out.includes('children: rows.map((row)'));
  // 子项点击仍走上游原生 onSelect，内容区渲染路径不变。
  assert.ok(out.includes('onSelect(row.id);'));
});

test('没有客户端代码时安全跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'navgroups-'));
  const r = patchSettingsNavGroups(root);
  assert.equal(r.patched, false);
});

test('锚点缺失（上游改版）时不改写文件', () => {
  const { root, file } = makeRoot('function other() {\n}\n');
  const r = patchSettingsNavGroups(root);
  assert.equal(r.patched, false);
  assert.equal(readFileSync(file, 'utf8'), 'function other() {\n}\n');
});

test('幂等：二次运行不再改写', () => {
  const { root, file } = makeRoot();
  patchSettingsNavGroups(root);
  const before = readFileSync(file, 'utf8');
  const r = patchSettingsNavGroups(root);
  assert.equal(r.patched, false);
  assert.equal(readFileSync(file, 'utf8'), before);
});
