// Shared content fingerprint of the release source inputs. Covers tracked files
// plus untracked-but-not-ignored files so a new source file cannot slip past the
// provenance/freshness guard.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint } from './build-cache.mjs';

export const IGNORED_PREFIXES = ['dist/', 'node_modules/', 'vendor/', '.git/', 'tauri-app/target/', 'temp/'];

export function sourceFiles(root) {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  return listed.filter(file => !IGNORED_PREFIXES.some(prefix => file.startsWith(prefix))).sort();
}

export function sourceFingerprint(root) {
  return fingerprint(sourceFiles(root).map(file => path.join(root, file)));
}
