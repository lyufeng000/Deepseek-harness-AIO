import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('../tauri-app/node_modules/typescript');
const source = fileURLToPath(new URL('../sidecar/src/lib/plugin-manager-patch.ts', import.meta.url));
const compiled = new Module(source);
compiled.filename = source;
compiled.paths = Module._nodeModulePaths(path.dirname(source));
compiled._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, source);
const implementations = {
  sidecar: compiled.exports,
  legacy: require('../scripts/plugin-manager-patch.js'),
};

for (const [name, api] of Object.entries(implementations)) {
  for (const eol of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) {
      const label = `${name} ${eol === '\n' ? 'LF' : 'CRLF'} ${bom ? 'BOM' : 'no BOM'}`;
      const lines = (...values) => values.join(eol) + eol;
      test(`${label}: first entry enables, disables in place and removes without touching siblings`, () => {
        const first = lines('- id: first', "  name: 'first'", '  disabled: true');
        const sibling = lines('# exact sibling comment', '- id: first-other', "  name: 'other'", '  config: !!js ({ untouched: true })', '', '');
        const input = bom + first + sibling;
        const enabled = api.togglePluginInPatch(input, 'first', true, 'first');
        assert.equal(enabled, bom + first.replace('  disabled: true' + eol, '') + sibling);
        assert.equal(api.togglePluginInPatch(enabled, 'first', true, 'first'), enabled);
        assert.equal(api.togglePluginInPatch(enabled, 'first', false, 'first'), input);
        assert.equal(api.togglePluginInPatch(input, 'first', false, 'first'), input);
        assert.equal(api.removePluginFromPatch(input, 'first'), bom + sibling);
        assert.equal(api.removePluginFromPatch(bom + sibling, 'first'), bom + sibling);
        assert.equal(api.hasEntryId(input, 'first'), true);
        assert.equal(api.hasEntryId(bom + sibling, 'first'), false);
      });
      test(`${label}: inserted rows and empty insert cleanup preserve untouched blocks`, () => {
        const prefix = bom + lines('- insert:');
        const target = lines('    - id: target', "      name: 'target'", '      disabled: true');
        const sibling = lines('    - id: other', "      name: 'other'", '      config:', '        nested: true');
        const suffix = lines('- id: untouched', '  config: !!js process.platform');
        const input = prefix + target + sibling + suffix;
        assert.equal(api.togglePluginInPatch(input, 'target', true),
          prefix + target.replace('      disabled: true' + eol, '') + sibling + suffix);
        assert.equal(api.removePluginFromPatch(input, 'target'), prefix + sibling + suffix);
        assert.equal(api.removePluginFromPatch(prefix + target + suffix, 'target'), bom + suffix);
        const disabled = api.togglePluginInPatch(input, 'target', false, 'target');
        assert.ok(disabled.startsWith(prefix + sibling + suffix));
        assert.equal(api.togglePluginInPatch(disabled, 'target', false, 'target'), disabled);
        if (eol === '\r\n') assert.ok(!/(?<!\r)\n/.test(disabled));
        assert.equal((disabled.match(/\uFEFF/g) || []).length, bom.length);
      });
      test(`${label}: append respects final-newline convention and trailing blank bytes`, () => {
        for (const final of [true, false]) {
          const original = bom + lines('# retained', '- id: other', "  name: 'other'") +
            (final ? eol + eol : '# unterminated');
          const disabled = api.togglePluginInPatch(original, 'new', false, 'new');
          assert.ok(disabled.startsWith(original), 'all original bytes remain');
          assert.equal(disabled.endsWith(eol), final);
          if (eol === '\r\n') assert.ok(!/(?<!\r)\n/.test(disabled), 'no appended LF-only lines');
          assert.equal(api.togglePluginInPatch(disabled, 'new', false, 'new'), disabled);
        }
        const noFinal = bom + ['- id: first', "  name: 'first'"].join(eol);
        assert.equal(api.togglePluginInPatch(noFinal, 'first', false, 'first'),
          noFinal + eol + '  disabled: true');
      });
      test(`${label}: missing entry operations are byte-identical`, () => {
        const input = bom + lines('# header', '- id: other', "  name: 'other'", '', '');
        assert.equal(api.togglePluginInPatch(input, 'missing', true), input);
        assert.equal(api.removePluginFromPatch(input, 'missing'), input);
      });
    }
  }
  test(`${name}: mixed terminators are retained on untouched lines`, () => {
    const input = '\uFEFF- id: first\r\n  name: first\n  disabled: true\r\n# untouched\n- id: second\r\n  config: {}\n\n';
    const enabled = api.togglePluginInPatch(input, 'first', true);
    assert.equal(enabled, input.replace('  disabled: true\r\n', ''));
    const disabled = api.togglePluginInPatch(enabled, 'first', false);
    assert.equal(disabled, input);
    assert.equal(api.removePluginFromPatch(input, 'first'), '\uFEFF# untouched\n- id: second\r\n  config: {}\n\n');
  });
}
