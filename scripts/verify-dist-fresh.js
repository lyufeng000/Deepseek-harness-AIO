'use strict';

// Release freshness guard (v2.0.3 incident → issue #7).
//
// v2.0.3 shipped artifacts built BEFORE the last source edits. This script
// refuses to bless a dist/ directory when any tracked source file was
// modified after the packaged artifacts were built.
//
// Usage: node scripts/verify-dist-fresh.js [repoRoot]
// Exit 0 = fresh, exit 1 = stale or missing artifacts (with a report).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
// Node 24 supports require() of ESM modules; the helper shares the exact
// fingerprint algorithm with the build so the guard cannot drift from it.
const { sourceFingerprint } = require('./build-source-fingerprint.mjs');

const IGNORED_PREFIXES = ['dist/', 'node_modules/', 'vendor/', '.git/', 'tauri-app/target/'];

// 产物目录自动选择：Tauri 打包产物优先（tauri build 的 NSIS 输出），退回
// Electron 时代的 dist/（冻结双轨期两套产物都可能出现）。
function defaultArtifactDirs(repoRoot) {
  return [
    path.join(repoRoot, 'tauri-app', 'target', 'release', 'bundle', 'nsis'),
    path.join(repoRoot, 'dist'),
  ];
}

function listSources(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    // Not a git repo (tests): fall back to a directory walk.
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = path.relative(repoRoot, path.join(dir, e.name)).replace(/\\/g, '/');
        if (e.isDirectory()) {
          if (IGNORED_PREFIXES.some((p) => (p.endsWith('/') ? rel + '/' : rel).startsWith(p))) continue;
          walk(path.join(dir, e.name));
        } else {
          if (IGNORED_PREFIXES.some((p) => rel.startsWith(p))) continue;
          files.push(rel);
        }
      }
    };
    walk(repoRoot);
    return files;
  }
  return out.split(/\r?\n/).filter(Boolean).filter((f) => !IGNORED_PREFIXES.some((p) => f.startsWith(p)));
}

function collectArtifacts(repoRoot, distDir) {
  const artifacts = [];
  try {
    for (const e of fs.readdirSync(distDir, { withFileTypes: true })) {
      if (e.isFile() && /\.exe$/i.test(e.name)) artifacts.push(path.join(distDir, e.name));
    }
  } catch { /* dir missing */ }
  return artifacts;
}

function hashFile(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function provenanceFor(candidates) {
  for (const dir of candidates) {
    const file = path.join(dir, 'build-provenance.json');
    if (!fs.existsSync(file)) continue;
    try { return { dir, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { dir, invalid: true }; }
  }
  return null;
}

function verifyDistFresh(repoRoot, distDir) {
  const candidates = distDir ? [distDir] : defaultArtifactDirs(repoRoot);
  let artifacts = [];
  let usedDir = null;
  for (const dir of candidates) {
    artifacts = collectArtifacts(repoRoot, dir);
    if (artifacts.length) {
      usedDir = dir;
      break;
    }
  }
  if (!artifacts.length) {
    return { ok: false, offenders: [], error: 'no packaged artifacts (*.exe) found in ' + candidates.join(' | ') };
  }
  // Prefer the content binding written by the build; fall back to mtimes only
  // for legacy/untracked layouts without provenance.
  const provenance = provenanceFor(candidates);
  if (provenance?.data?.sourceFingerprint) {
    const current = sourceFingerprint(repoRoot);
    if (current !== provenance.data.sourceFingerprint) {
      return { ok: false, offenders: [], mode: 'content',
        error: 'source content changed after the artifacts were built (provenance mismatch)' };
    }
    for (const [name, expected] of Object.entries(provenance.data.artifacts || {})) {
      const file = path.join(provenance.dir, ...name.split('/'));
      if (!fs.existsSync(file)) return { ok: false, offenders: [name], mode: 'content', error: 'provenance artifact is missing: ' + name };
      if (hashFile(file) !== expected) return { ok: false, offenders: [name], mode: 'content', error: 'provenance artifact hash mismatch: ' + name };
    }
    return { ok: true, offenders: [], mode: 'content' };
  }
  if (provenance?.invalid) return { ok: false, offenders: [], error: 'build-provenance.json is not valid JSON' };
  const artifactTime = Math.min(...artifacts.map((p) => fs.statSync(p).mtimeMs));
  const offenders = [];
  for (const rel of listSources(repoRoot)) {
    const p = path.join(repoRoot, ...rel.split('/'));
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > artifactTime) offenders.push(rel);
  }
  return { ok: offenders.length === 0, offenders, artifactTime, mode: 'mtime' };
}

module.exports = { verifyDistFresh };

if (require.main === module) {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const r = verifyDistFresh(repoRoot);
  if (r.ok) {
    console.log(r.mode === 'content'
      ? 'verify-dist-fresh: OK — artifact hashes and source content match build provenance'
      : 'verify-dist-fresh: OK — artifacts newer than every tracked source file');
    process.exit(0);
  }
  console.error('verify-dist-fresh: STALE — ' + (r.error || `${r.offenders.length} source file(s) modified after the artifacts were built:`));
  for (const o of r.offenders.slice(0, 40)) console.error('  ' + o);
  if (r.offenders.length > 40) console.error(`  … and ${r.offenders.length - 40} more`);
  console.error('Rebuild (npm run dist) before publishing.');
  process.exit(1);
}
