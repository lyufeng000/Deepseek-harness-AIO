import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneSeedDebugArtifacts } from '../scripts/prepare-public-seed.mjs';

test('seed packaging removes debugging artifacts but keeps runtime and declarations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-seed-debug-test-'));
  try {
    const pkg = path.join(root, 'profiles/web-desktop/node_modules/example');
    fs.mkdirSync(pkg, { recursive: true });
    for (const name of ['client.js', 'client.js.map', 'native.pdb', 'client.d.ts']) {
      fs.writeFileSync(path.join(pkg, name), 'fixture');
    }
    pruneSeedDebugArtifacts(root);
    assert.deepEqual(fs.readdirSync(pkg).sort(), ['client.d.ts', 'client.js']);
    pruneSeedDebugArtifacts(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
