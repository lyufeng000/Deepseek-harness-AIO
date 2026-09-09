import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBuildEnvironment, validateReleaseArguments } from '../scripts/build-tauri-release.mjs';

test('release audit cannot target an unrelated native binary through target or debug flags', () => {
  for (const flag of ['--target', '--target=aarch64-pc-windows-msvc', '-t', '-taarch64-pc-windows-msvc',
    '--debug', '--debug=true', '-d']) {
    assert.throws(() => validateReleaseArguments([flag], {}, 'win32'), /native Windows release/);
  }
  assert.throws(() => validateReleaseArguments([], { CARGO_BUILD_TARGET: 'other' }, 'win32'));
  assert.throws(() => validateReleaseArguments([], {}, 'linux'));
  assert.doesNotThrow(() => validateReleaseArguments(['--no-bundle', '--config', 'qualification.json'], {}, 'win32'));
});

test('release flags preserve caller flags and encode paths with spaces as single arguments', () => {
  const env = { RUSTFLAGS: '-C debuginfo=0', SENTINEL: 'unchanged' };
  const result = releaseBuildEnvironment(env, 'Q:\\Build Root\\AIO', 'Q:\\Users\\Test User');
  assert.equal(result.SENTINEL, 'unchanged');
  assert.deepEqual(result.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), [
    '-C', 'debuginfo=0',
    '--remap-path-prefix=Q:\\Users\\Test User=/build/home',
    '--remap-path-prefix=Q:\\Build Root\\AIO=/build/aio',
  ]);
  assert.ok(!Object.hasOwn(env, 'CARGO_ENCODED_RUSTFLAGS'));
  const encoded = releaseBuildEnvironment({ CARGO_ENCODED_RUSTFLAGS: '-C\x1fopt-level=2', RUSTFLAGS: 'ignored' }, 'repo', 'home');
  assert.deepEqual(encoded.CARGO_ENCODED_RUSTFLAGS.split('\x1f').slice(0, 2), ['-C', 'opt-level=2']);
});
