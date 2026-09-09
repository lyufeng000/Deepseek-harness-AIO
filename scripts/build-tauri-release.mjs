import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditReleasePaths } from './audit-release-paths.mjs';

export function releaseBuildEnvironment(input, repo, home) {
  const previous = input.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? input.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (input.RUSTFLAGS || '').trim().split(/\s+/).filter(Boolean);
  return { ...input, CARGO_ENCODED_RUSTFLAGS: [...previous,
    `--remap-path-prefix=${home}=/build/home`,
    `--remap-path-prefix=${repo}=/build/aio`,
  ].join('\x1f') };
}

export function validateReleaseArguments(args, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || args.some(arg =>
    /^--(?:debug|target)(?:=|$)/.test(arg) || /^-[dt]/.test(arg))
      || env.CARGO_BUILD_TARGET) throw new Error('Only native Windows release builds are supported');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tauri = path.join(repo, 'tauri-app');
  const args = process.argv.slice(2);
  try {
    validateReleaseArguments(args);
    const home = os.homedir();
    const run = spawnSync(process.execPath, [path.join(tauri, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args], {
      cwd: tauri, env: releaseBuildEnvironment(process.env, repo, home), stdio: 'inherit', windowsHide: true,
    });
    if (run.error || run.status !== 0) throw new Error('Tauri release build failed');
    const config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
    const target = process.env.CARGO_TARGET_DIR ? path.resolve(tauri, process.env.CARGO_TARGET_DIR) : path.join(tauri, 'target');
    const binary = path.join(target, 'release', `${config.mainBinaryName}.exe`);
    for (const root of [binary, path.join(tauri, 'resources')]) {
      if (auditReleasePaths(root, [repo, home]).findings.length) throw new Error('Local build paths remain in release artifacts');
    }
    console.log('Release binary and resources passed the local build-path audit.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
