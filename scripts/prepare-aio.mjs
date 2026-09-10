import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cachedStep, writeJson } from './build-cache.mjs';
import { applySeedPatches } from './seed-kernel-patches.mjs';

const root = path.resolve(import.meta.dirname, '..');
const resolve = value => path.join(root, value);
const seed = process.env.DSH_PROFILE_SEED_DIR || resolve('distribution/profile-seed');
const clean = process.env.AIO_CLEAN_BUILD === '1';
const results = [];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Build preparation failed: ${path.basename(command)}`);
}
const node = (file, ...args) => run(process.execPath, [resolve(file), ...args]);
const step = (name, inputs, outputs, fn, metadata = {}) => results.push(cachedStep({ root, name, inputs: inputs.map(resolve), outputs: outputs.map(resolve), run: fn, clean, metadata }));
const toolchain = { node: process.version, abi: process.versions.modules, arch: process.arch };
try {
  step('icon', ['scripts/build-icon.ps1', 'assets/DeepSeekHarness-WhaleGirl.ico'], ['assets/icon.png', 'assets/tray-icon.png', 'build/icon.ico', 'tauri-app/icons'], () => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/build-icon.ps1')]));
  step('inject', ['tauri-app/frontend', 'tauri-app/build-inject.mjs', 'tauri-app/package-lock.json'], ['tauri-app/src/inject/chrome.js'], () => node('tauri-app/build-inject.mjs'), toolchain);
  step('sidecar', ['sidecar/src', 'sidecar/tsconfig.json', 'tauri-app/package-lock.json'], ['sidecar/dist'], () => {
    fs.rmSync(resolve('sidecar/dist'), { recursive: true, force: true });
    node('tauri-app/node_modules/typescript/bin/tsc', '-p', resolve('sidecar/tsconfig.json'), '--noEmitOnError');
  }, toolchain);
  // Sanitization policy and the complete seed content participate in the key.
  // The step rewrites the seed in place, so the input fingerprint already proves
  // the reviewed state; re-hashing the same tree as an output would double the
  // expensive whole-seed walk on every cache hit.
  results.push(cachedStep({ root, name: 'seed-review', inputs: [seed, resolve('scripts/sanitize-public-seed.mjs'), resolve('scripts/public-seed-privacy.mjs'), resolve('scripts/public-seed-reviewed-content.mjs')], outputs: [], clean,
    run: () => node('scripts/sanitize-public-seed.mjs', root) }));
  node('scripts/build-native-runtime.mjs');
  step('staging', ['package.json', 'package-lock.json', 'sidecar/dist', 'assets', 'node_modules', 'vendor', 'tauri-app/scripts/stage.ts', 'scripts/patch-done-pill.cjs', 'scripts/patch-session-motion.cjs', 'scripts/seed-kernel-patches.mjs', path.relative(root, seed)], ['tauri-app/resources'], () => {
    node('tauri-app/scripts/stage.ts');
    // 受控种子补丁只作用于打包副本：图片交给原生多模态模型，不再依赖专门的图像解析模型。
    for (const patched of applySeedPatches(resolve('tauri-app/resources/profile-seed'))) {
      console.log(`[build] seed-patch ${patched.id}: ${patched.applied ? 'applied' : 'skipped'} ${patched.reason ?? ''}`);
    }
  }, toolchain);
} finally { writeJson(resolve('temp/build-metrics/prepare.json'), results); }
