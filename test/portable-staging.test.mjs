import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('portable packaging uses fresh staging rather than the additive Tauri cache', () => {
  const source = fs.readFileSync(new URL('../tauri-shell/make-portable.mjs', import.meta.url), 'utf8');
  assert.match(source, /const resources = path\.join\(tauri, 'resources'\)/);
  assert.doesNotMatch(source, /path\.join\(release, 'resources'\)/);
  assert.match(source, /cpSync\(resources, path\.join\(staging, 'resources'\)/);
});
