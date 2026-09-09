import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { reviewedPublicContent, reviewedPublicAlternates } from './public-seed-reviewed-content.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));
const groups = new Map();
const candidates = [
  ...[...reviewedPublicContent].map(([file, sha256]) => ({ file, sha256 })),
  ...reviewedPublicAlternates,
];
for (const { file, sha256, version: explicitVersion } of candidates) {
  const segments = file.split('/');
  const name = segments.splice(0, file.startsWith('@') ? 2 : 1).join('/');
  const version = explicitVersion ?? ({ 'dsh-smooth-stream': '0.4.1', 'dsh-usage-skill': '0.3.0' })[name]
    ?? lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`Missing pinned version: ${name}`);
  const key = `${name}@${version}`;
  if (!groups.has(key)) groups.set(key, { name, version, files: new Map() });
  groups.get(key).files.set(segments.join('/'), sha256);
}
for (const { name, version, files } of groups.values()) {
  let bytes;
  if (name === 'dsh-usage-skill') {
    // This reviewed legacy package is supplied as an archive, not published on npm.
    if (!process.argv[2]) throw new Error('Provide the reviewed dsh-usage-skill archive');
    bytes = fs.readFileSync(process.argv[2]);
    if (createHash('sha256').update(bytes).digest('hex') !==
        '07c83593bad68cd46ad0106ead3f4d082b16250b0e9c0cecd010414387475159') {
      throw new Error('Reviewed legacy archive integrity mismatch');
    }
  } else {
  const metadata = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (!metadata.ok) throw new Error(`Registry metadata unavailable: ${name}`);
  const { dist } = await metadata.json();
  if (new URL(dist.tarball).origin !== 'https://registry.npmjs.org') throw new Error('Non-public tarball URL');
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`Public archive unavailable: ${name}`);
  bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== dist.integrity) throw new Error(`Archive integrity mismatch: ${name}`);
  }
  const verified = new Set();
  await new Promise((resolve, reject) => {
    const parser = tar.t({ onentry(entry) {
      const file = entry.path.slice(entry.path.indexOf('/') + 1);
      const expected = files.get(file);
      if (!expected) { entry.resume(); return; }
      const hash = createHash('sha256');
      entry.on('data', chunk => hash.update(chunk));
      entry.on('end', () => {
        if (hash.digest('hex') !== expected) reject(new Error(`Public content mismatch: ${name}/${file}`));
        else verified.add(file);
      });
    } });
    parser.on('error', reject).on('end', resolve);
    parser.end(bytes);
  });
  if (verified.size !== files.size) throw new Error(`Incomplete public content verification: ${name}`);
  console.log(`${name}@${version}: ${verified.size} ${name === 'dsh-usage-skill' ? 'reviewed archive' : 'public registry'} files verified`);
}
