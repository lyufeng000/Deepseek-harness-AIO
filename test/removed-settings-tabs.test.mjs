import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const name of ['dsh-skin-switch', 'dsh-webui-market']) {
  test(`${name} is fully retired from the built-in plugin sources`, () => {
    assert.equal(fs.existsSync(new URL(`../assets/plugins/${name}/`, import.meta.url)), false);
  });
}

test('retired settings plugins are absent from the active profile and sidecar registries', () => {
  const patch = fs.readFileSync(new URL('../distribution/profile-seed/profiles/web-desktop/cordis.patch.yml', import.meta.url), 'utf8');
  const core = fs.readFileSync(new URL('../sidecar/src/desktop-core.ts', import.meta.url), 'utf8');
  for (const token of ['@deepseek-ai/dsh-skin-switch', '@sanqi-normal/dsh-webui-market-plugin']) {
    assert.equal(patch.includes(token), false);
    assert.equal(core.includes(token), false);
  }
});

test('only active plugin-install support remains outside plugin packages', () => {
  assert.equal(fs.existsSync(new URL('../assets/runtime/plugin-install/allow-builds.mjs', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../assets/runtime/plugin-install/artifact-keep.mjs', import.meta.url)), false);
});
