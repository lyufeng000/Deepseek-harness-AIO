import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

test('stage copy includes only qualified fs-ext binary from its build tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-native-stage-test-'));
  try {
    const src = path.join(root, 'source/node_modules/fs-ext');
    const dst = path.join(root, 'output/fs-ext');
    const files = ['package.json', 'build/config.gypi', 'build/fs_ext.vcxproj',
      'build/Release/fs_ext.node', 'build/Release/fs_ext.iobj', 'build/Release/fs_ext.exp',
      'build/Release/fs_ext.ipdb', 'build/Release/fs_ext.pdb', 'build/Release/obj/source.obj'];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
      fs.writeFileSync(path.join(src, file), 'fixture');
    }
    const source = fs.readFileSync(new URL('../tauri-app/scripts/stage.ts', import.meta.url), 'utf8');
    const implementation = source.slice(source.indexOf('const releaseSkip ='), source.indexOf('function longPath('));
    const copy = vm.runInNewContext(`${implementation}\ncopyTree`, { fs, path });
    copy(src, dst);
    assert.deepEqual(fs.readdirSync(path.join(dst, 'build')), ['Release']);
    assert.deepEqual(fs.readdirSync(path.join(dst, 'build/Release')), ['fs_ext.node']);
    assert.equal(fs.readFileSync(path.join(dst, 'build/Release/fs_ext.node'), 'utf8'), 'fixture');
    assert.ok(fs.existsSync(path.join(dst, 'package.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
