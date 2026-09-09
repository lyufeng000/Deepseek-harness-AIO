import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(shellDir, '..');
const tauri = path.join(repo, 'tauri-app');
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(tauri, process.env.CARGO_TARGET_DIR)
  : path.join(tauri, 'target');
const release = path.join(target, 'release');
const version = JSON.parse(readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8')).version;
const outAt = process.argv.indexOf('--out');
const outDir = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : path.join(release, 'portable');
const exe = path.join(release, 'DSHEAC AIO.exe');
// Tauri's release cache is additive and can retain retired plugin files.
// prepare:bundle rebuilds this staging tree from the current approved inputs.
const resources = path.join(tauri, 'resources');

for (const required of [exe, path.join(resources, 'app', 'package.json'), path.join(resources, 'node', 'node.exe')]) {
  if (!existsSync(required)) throw new Error(`portable input is missing: ${required}`);
}

mkdirSync(outDir, { recursive: true });
const staging = path.join(outDir, '.staging-aio-v1');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(exe, path.join(staging, 'DSHEAC AIO.exe'));
cpSync(resources, path.join(staging, 'resources'), { recursive: true });
writeFileSync(path.join(staging, '.dsh-portable'), `DSHEAC AIO portable v${version}\n`, 'utf8');

const zip = path.join(outDir, `DSHEAC-AIO-v${version}-Portable-x64.zip`);
rmSync(zip, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "$ProgressPreference='SilentlyContinue'; $items = Get-ChildItem -LiteralPath $env:P_STAGE | ForEach-Object FullName; Compress-Archive -LiteralPath $items -DestinationPath $env:P_ZIP -Force",
], {
  env: { ...process.env, P_STAGE: staging, P_ZIP: zip },
  windowsHide: true,
  stdio: 'inherit',
});

const hash = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${hash}  ${path.basename(zip)}\n`, 'ascii');
rmSync(staging, { recursive: true, force: true });
console.log(`[portable] ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MiB)`);
console.log(`[portable] SHA256 ${hash}`);
