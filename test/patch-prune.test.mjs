// 远程更新换掉依赖闭包后，用户 patch 里引用已退场包的行必须被安全删除，
// 而不是让 dsh 因缺包起不来；用户自己的行、相对入口与裸条目一律不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.join(root, 'tauri-app/node_modules/typescript'));
const source = path.join(root, 'sidecar/src/lib/plugin-manager-patch.ts');
const compiled = new Module(source);
compiled.filename = source;
compiled.paths = Module._nodeModulePaths(path.dirname(source));
compiled._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, source);

const implementations = {
  sidecar: compiled.exports,
  legacy: require(path.join(root, 'scripts/plugin-manager-patch.js')),
};

const PATCH = [
  '- insert:',
  "    - id: retired",
  "      name: 'dsh-retired'",
  '      config: !!js ({ a: 1 })',
  '- insert:',
  "    - id: kept",
  "      name: '@scope/kept'",
  '- id: top-retired',
  '  name: dsh-top-gone',
  '  disabled: true',
  '- id: relative',
  "  name: './local-entry.js'",
  '- id: bare',
].join('\n') + '\n';

for (const [name, api] of Object.entries(implementations)) {
  test(`${name}: 退场条目整块删除，保留条目与相对入口不动`, () => {
    const result = api.pruneUnavailableRows(PATCH, new Set(['@scope/kept']));
    assert.deepEqual(result.pruned, [
      { id: 'retired', name: 'dsh-retired' },
      { id: 'top-retired', name: 'dsh-top-gone' },
    ]);
    assert.doesNotMatch(result.patch, /retired/);
    assert.doesNotMatch(result.patch, /dsh-top-gone/);
    // 空掉的 insert 头行一并清理，避免 `- insert:` 变成空列表。
    assert.equal((result.patch.match(/^\s*-\s*insert:$/gm) || []).length, 1);
    assert.match(result.patch, /^\s*-\s*id: kept$/m);
    assert.match(result.patch, /^\s*-\s*id: relative$/m);
    assert.match(result.patch, /^\s*-\s*id: bare$/m);
    // 保留条目的 config 未受影响。
    assert.equal(result.patch, [
      '- insert:',
      "    - id: kept",
      "      name: '@scope/kept'",
      '- id: relative',
      "  name: './local-entry.js'",
      '- id: bare',
    ].join('\n') + '\n');
  });

  test(`${name}: 全部可用时原文返回，不改一个字节`, () => {
    const available = new Set(['dsh-retired', '@scope/kept', 'dsh-top-gone', './local-entry.js', 'bare']);
    const result = api.pruneUnavailableRows(PATCH, available);
    assert.deepEqual(result.pruned, []);
    assert.equal(result.patch, PATCH);
  });

  test(`${name}: CRLF + BOM 输入保持原样，只删除失效行`, () => {
    const crlf = PATCH.replace(/\n/g, '\r\n');
    const input = '\uFEFF' + crlf;
    const result = api.pruneUnavailableRows(input, new Set(['@scope/kept']));
    assert.ok(result.patch.startsWith('\uFEFF'));
    assert.equal((result.patch.match(/\uFEFF/g) || []).length, 1);
    assert.ok(!/(?<!\r)\n/.test(result.patch), '不得引入裸 LF');
    assert.match(result.patch, /^\s*-\s*id: kept\r$/m);
    assert.doesNotMatch(result.patch, /retired/);
  });

  test(`${name}: 空文本与非法输入安全返回`, () => {
    assert.deepEqual(api.pruneUnavailableRows('', new Set()), { patch: '', pruned: [] });
    assert.deepEqual(api.pruneUnavailableRows(null, new Set()), { patch: '', pruned: [] });
  });

  test(`${name}: packageNameOf 归一化包名`, () => {
    assert.equal(api.packageNameOf('@scope/name/entry.js'), '@scope/name');
    assert.equal(api.packageNameOf('dsh-x/lib/y.js'), 'dsh-x');
    assert.equal(api.packageNameOf('plain'), 'plain');
  });

  test(`${name}: bundle 清单剔除缺包项，保留可用项与异常项`, () => {
    const bundles = ['@deepseek-ai/dsh-base', 'dsh-retired', '@scope/kept/preset', './local', 42];
    const result = api.pruneUnavailableBundles(bundles, new Set(['@deepseek-ai/dsh-base', '@scope/kept']));
    assert.deepEqual(result.removed, ['dsh-retired']);
    assert.deepEqual(result.kept, ['@deepseek-ai/dsh-base', '@scope/kept/preset', './local', 42]);
  });

  test(`${name}: bundle 输入非数组时安全返回`, () => {
    assert.deepEqual(api.pruneUnavailableBundles(null, new Set()), { kept: [], removed: [] });
    assert.deepEqual(api.pruneUnavailableBundles(undefined, []), { kept: [], removed: [] });
  });
}
