import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function fingerprint(inputs, excluded = new Set()) {
  const hash = createHash('sha256');
  const ancestors = new Set();
  function walk(file, name) {
    hash.update(name + '\0');
    if (!fs.existsSync(file)) { hash.update('missing\0'); return; }
    const real = fs.realpathSync(file);
    if (ancestors.has(real)) throw new Error('Cyclic build input');
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      ancestors.add(real); hash.update('directory\0');
      for (const entry of fs.readdirSync(file).sort()) if (!excluded.has(entry)) walk(path.join(file, entry), name + '/' + entry);
      ancestors.delete(real);
    } else { hash.update(String(stat.size) + '\0'); const fd = fs.openSync(file, 'r');
      try { const buffer = Buffer.allocUnsafe(1024 * 1024); let count; while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
    }
  }
  for (let i = 0; i < inputs.length; i++) walk(inputs[i], String(i));
  return hash.digest('hex');
}
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(temporary, file);
}
export function cachedStep({ root, name, inputs, outputs, run, clean = false, metadata = {} }) {
  const started = Date.now();
  const stamp = path.join(root, 'temp/build-cache', name + '.json');
  const key = fingerprint(inputs.concat([path.join(root, 'scripts/build-cache.mjs')])) + JSON.stringify(metadata);
  let old; try { old = JSON.parse(fs.readFileSync(stamp)); } catch { /* no valid cache */ }
  const hit = !clean && old?.input === key && outputs.every(p => fs.existsSync(p)) && old.output === fingerprint(outputs);
  if (!hit) {
    run();
    if (!outputs.every(p => fs.existsSync(p))) throw new Error(`Missing output of ${name}`);
    writeJson(stamp, { input: key, output: fingerprint(outputs) });
  }
  const result = { name, cache: hit ? 'hit' : 'miss', elapsedMs: Date.now() - started, input: key.slice(0, 64) };
  console.log(`[build] ${name}: ${result.cache}, ${(result.elapsedMs / 1000).toFixed(2)}s`);
  return result;
}
