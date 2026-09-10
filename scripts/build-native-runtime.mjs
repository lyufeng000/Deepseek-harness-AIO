import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fingerprint, writeJson } from './build-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('AIO native runtime requires a Windows x64 build host');
}
const npmCli = process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (path.basename(npmCli) !== 'npm-cli.js' || !fs.statSync(npmCli).isFile()) {
  throw new Error('An explicit npm CLI is required to build the native runtime');
}
const buildDir = path.join(root, 'node_modules/fs-ext/build');
const stamp = path.join(root, 'temp/build-cache/native.json');
const nativeFile = path.join(buildDir, 'Release/fs_ext.node');
const key = fingerprint([path.join(root, 'node_modules/fs-ext'), path.join(root, 'scripts/build-native-runtime.mjs'), path.join(root, 'package-lock.json')], new Set(['build']))
  + JSON.stringify({ node: process.version, abi: process.versions.modules, arch: process.arch, cl: process.env.VCToolsVersion || '', sdk: process.env.WindowsSDKVersion || '' });
let old; try { old = JSON.parse(fs.readFileSync(stamp)); } catch { /* cache miss */ }
if (process.env.AIO_CLEAN_BUILD !== '1' && old?.key === key && fs.existsSync(nativeFile) && old.output === fingerprint([nativeFile])) {
  if (typeof createRequire(import.meta.url)('fs-ext').flockSync !== 'function') throw new Error('Cached native runtime cannot load');
  console.log('[build] native: hit'); process.exit(0);
}
if (fs.existsSync(buildDir)) {
  if (fs.realpathSync(buildDir) !== path.resolve(buildDir)) throw new Error('Unexpected native build directory');
  fs.rmSync(buildDir, { recursive: true, force: true });
}
const result = spawnSync(process.execPath, [npmCli, 'rebuild', 'fs-ext', '--foreground-scripts'], {
  cwd: root,
  env: { ...process.env, _CL_: `/experimental:deterministic /pathmap:"${root}=."`, LINK: '/PDBALTPATH:fs_ext.pdb', _LINK_: '/PDBALTPATH:fs_ext.pdb' },
  windowsHide: true,
  stdio: 'inherit',
  timeout: 10 * 60 * 1000,
});
if (result.error || result.status !== 0) throw new Error('fs-ext native build failed');
const require = createRequire(import.meta.url);
if (typeof require('fs-ext').flockSync !== 'function') throw new Error('fs-ext native load failed');
const binary = fs.readFileSync(path.join(buildDir, 'Release/fs_ext.node')).toString('latin1');
if (binary.toLowerCase().includes(root.toLowerCase()) || /[a-z]:[\\/]Users[\\/]/i.test(binary)) {
  throw new Error('Native binary contains a machine-local build path');
}
console.log('Native runtime built and loaded with the build Node runtime.');
writeJson(stamp, { key, output: fingerprint([nativeFile]) });
