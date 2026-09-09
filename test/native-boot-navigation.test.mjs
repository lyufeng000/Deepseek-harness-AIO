import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native boot navigation preserves the authenticated URL without a cross-site script redirect', () => {
  const source = fs.readFileSync(new URL('../tauri-app/src/boot.rs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('pub fn navigate_main_to_web('), source.indexOf('pub fn navigate_main_to_local('));
  assert.match(body, /win\.navigate\(target\)/);
  assert.doesNotMatch(body, /window\.location\.replace|win\.eval/);
  const shell = fs.readFileSync(new URL('../tauri-app/src/lib.rs', import.meta.url), 'utf8');
  assert.match(shell, /DISPLAY_RELEASE: &str = concat!\("v", env!\("CARGO_PKG_VERSION"\)\)/);
});
