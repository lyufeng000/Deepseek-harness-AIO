import fs from 'node:fs';
import path from 'node:path';
import { isReviewedPublicContent } from './public-seed-reviewed-content.mjs';

const layout = new Map([
  ['', new Set(['README.md', 'settings.yaml', 'profiles'])],
  ['profiles', new Set(['web-desktop'])],
  ['profiles/web-desktop', new Set(['package.json', 'cordis.yml', 'cordis.patch.yml', 'node_modules'])],
]);
const directories = new Set(['profiles', 'profiles/web-desktop', 'profiles/web-desktop/node_modules']);
const localPath = /(?:[a-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|[a-z]:[\\/]+Documents and Settings[\\/]+|H:[\\/]+CODEX|\.dsh-v4lite|pnpm[\\/]+store)/i;
const secret = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:https?|socks5):\/\/[^/\s:@]+:[^/\s@]+@/;
const sensitiveKey = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|secret|client[-_]?secret|private[-_]?key|authorization|cookie)$/i;
const dependencyRootState = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|settings\.ya?ml|credentials(?:\.json|\.ya?ml)?|sessions)$/i;

export function inspectSeedTree(seedRoot) {
  if (fs.lstatSync(seedRoot).isSymbolicLink()) throw new Error('seed root must not be a symbolic link');
  const root = fs.realpathSync(seedRoot);
  const files = [];
  function walk(file, relative, ancestors) {
    const real = fs.realpathSync(file);
    const outside = path.relative(root, real);
    if (outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
      throw new Error('external seed symbolic link rejected');
    }
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error('cyclic seed symbolic link rejected');
      const next = new Set([...ancestors, real]);
      for (const entry of fs.readdirSync(file)) {
        if (relative === 'profiles/web-desktop/node_modules' && dependencyRootState.test(entry)) {
          throw new Error('unknown seed user state entry rejected');
        }
        if (layout.has(relative) && !layout.get(relative).has(entry)) {
          throw new Error('unknown seed user state entry rejected');
        }
        const rel = relative ? `${relative}/${entry}` : entry;
        const child = path.join(file, entry);
        if (layout.has(relative)) {
          if (fs.lstatSync(child).isSymbolicLink()) throw new Error('seed manifest symbolic link rejected');
          if (fs.statSync(child).isDirectory() !== directories.has(rel)) throw new Error('invalid seed layout');
        }
        walk(child, rel, next);
      }
    } else if (stat.isFile()) {
      files.push({ file, relative });
    } else {
      throw new Error('unsupported seed entry rejected');
    }
  }
  walk(root, '', new Set());
  return files;
}

export function inspectPublicConfig(value, ancestors = new Set()) {
  if (typeof value === 'string') inspectSeedText(value);
  if (!value || typeof value !== 'object') return;
  if (ancestors.has(value)) throw new Error('cyclic public configuration rejected');
  const next = new Set([...ancestors, value]);
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key) && item !== null && item !== '') {
      throw new Error('secret-bearing public configuration rejected');
    }
    inspectPublicConfig(item, next);
  }
}

export function inspectSeedText(text) {
  // Normalize JSON-escaped backslashes without including source text in diagnostics.
  if (localPath.test(text.replaceAll('\\\\', '\\'))) throw new Error('machine-local seed paths found');
  // AWS publishes this exact non-secret example in SDK declarations and its STS API reference.
  const withoutPublicExample = text.replace(/\bAKIAIOSFODNN7EXAMPLE\b/g, '');
  if (secret.test(withoutPublicExample)) throw new Error('secret-bearing seed content rejected');
}

export function inspectSeedArtifact(relative, bytes) {
  if (!isReviewedPublicContent(relative, bytes)) inspectSeedText(bytes.toString('utf8'));
}
