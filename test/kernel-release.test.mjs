import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const manifest = read('package.json');
const version = manifest.dependencies['@deepseek-ai/dsh'];

test('release and profile use one exact first-party kernel version', () => {
  const lock = read('package-lock.json');
  for (const source of [manifest, read('distribution/profile-seed/profiles/web-desktop/package.json')]) {
    for (const [name, spec] of Object.entries(source.dependencies)) {
      if (!/^@deepseek-ai\/dsh(?:-|$)/.test(name)) continue;
      assert.equal(spec, version, name);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} must exist in the qualified graph`);
    }
  }
  assert.equal(read('node_modules/@deepseek-ai/dsh/package.json').version, version);
});

test('bundled client load declarations reference current provider packages', () => {
  for (const group of ['assets/plugins', 'assets/skins']) {
    for (const name of fs.readdirSync(path.join(root, group))) {
      const file = path.join(group, name, 'package.json');
      if (!fs.existsSync(path.join(root, file))) continue;
      const pkg = read(file);
      for (const dependency of pkg.dsh?.client?.inject || []) {
        assert.doesNotMatch(dependency, /dsh-client-runtime|dsh-client-web-react|dsh-client-schema-form/);
        assert.ok(fs.existsSync(path.join(root, 'node_modules', dependency, 'package.json')),
          `${pkg.name} references missing provider ${dependency}`);
      }
    }
  }
});
