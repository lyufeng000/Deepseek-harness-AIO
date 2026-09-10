import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint, writeJson } from './build-cache.mjs';
import { sourceFingerprint } from './build-source-fingerprint.mjs';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[process.argv.indexOf('--out') + 1]);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const names = [`DSHEAC-AIO-v${version}-Setup-x64.exe`, `portable/DSHEAC-AIO-v${version}-Portable-x64.zip`];
const artifacts = {};
for (const name of names) {
  const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(path.join(output, name))) hash.update(bytes);
  artifacts[name] = hash.digest('hex');
}
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), Object.entries(artifacts).map(([name, hash]) => `${hash}  ${name}\n`).join(''));
fs.writeFileSync(path.join(output, 'portable/SHA256SUMS.txt'), `${artifacts[names[1]]}  ${path.basename(names[1])}\n`);
writeJson(path.join(output, 'build-provenance.json'), { version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  sourceFingerprint: sourceFingerprint(root), resources: fingerprint([path.join(root, 'tauri-app/resources')]), artifacts });
