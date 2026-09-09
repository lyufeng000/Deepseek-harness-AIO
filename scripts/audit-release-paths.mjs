import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const normalize = value => value.replace(/\\+/g, '/').toLowerCase();

export function auditReleasePaths(root, forbidden) {
  if (!forbidden.length || forbidden.some(value => value.length < 4)) throw new Error('Explicit forbidden paths required');
  const patterns = forbidden.map(normalize);
  const findings = [];
  let count = 0;
  function walk(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Release audit requires a plain staged tree');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(file, name), relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile()) throw new Error('Unsupported release artifact');
    count++;
    const bytes = fs.readFileSync(file);
    for (const encoding of ['utf8', 'utf16le']) {
      const text = normalize(bytes.toString(encoding));
      if (patterns.some(pattern => text.includes(pattern))) {
        findings.push(relative);
        break;
      }
    }
  }
  walk(path.resolve(root), '');
  return { files: count, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = auditReleasePaths(process.argv[2], process.argv.slice(3));
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length) process.exitCode = 1;
  } catch {
    console.error('Release build-path audit failed');
    process.exitCode = 1;
  }
}
