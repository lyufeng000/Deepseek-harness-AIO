import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_REL = 'legacy/electron/main.js';
const mainSrc = fs.readFileSync(join(root, MAIN_REL), 'utf8');

function localRequiresOf(src) {
  const out = new Set();
  const re = /require\(\s*['"](?:\.\.?[\\/])+[^'"]+['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const specifier = m[0].match(/['"]([^'"]+)['"]/)?.[1];
    if (!specifier) continue;
    let name = new URL(specifier, 'file:///' + MAIN_REL.replace(/\\/g, '/')).pathname.slice(1);
    name = name.replace(/\\/g, '/');
    if (!name.endsWith('.js')) name += '.js';
    out.add(name);
  }
  return out;
}

function bundledFilesPatterns() {
  const yml = fs.readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const lines = yml.split(/\r?\n/);
  const patterns = [];
  let inFiles = false;
  for (const line of lines) {
    if (/^files:/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      const m = line.match(/^\s{2}-\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/);
      if (m) patterns.push(m[1] || m[2] || m[3]);
      else if (line.trim() && !line.trim().startsWith('#')) inFiles = false;
    }
  }
  return patterns;
}

function patternCovers(pattern, file) {
  if (pattern === file) return true;
  const normalized = pattern.replace(/\\/g, '/');
  if (normalized.endsWith('/**/*.js')) {
    return file.startsWith(normalized.slice(0, -'**/*.js'.length)) && file.endsWith('.js');
  }
  return false;
}

test('main.js 顶层 require 的每个本地模块都在 electron-builder files 清单中', () => {
  const requires = localRequiresOf(mainSrc);
  assert.ok(requires.size >= 10, '应至少识别出 10 个本地依赖，实际: ' + [...requires].join(', '));
  const patterns = bundledFilesPatterns();
  assert.ok(patterns.length > 0, 'files 清单解析失败');
  const missing = [...requires].filter((name) => !patterns.some((pattern) => patternCovers(pattern, name)));
  assert.deepEqual(missing, [],
    '以下模块被 main.js require 但未打包，会导致启动即闪退: ' + missing.join(', '));
});

test('main.js 通过 __dirname 直接引用的运行时脚本也必须打包', () => {
  const refs = new Set();
  const re = /__dirname\s*,\s*['"]([^'"]+\.js)['"]/g;
  let m;
  while ((m = re.exec(mainSrc)) !== null) refs.add('legacy/electron/' + m[1]);
  const patterns = bundledFilesPatterns();
  const missing = [...refs].filter((name) => !patterns.some((pattern) => patternCovers(pattern, name)));
  assert.deepEqual(missing, [],
    '以下脚本被运行时引用但未打包: ' + missing.join(', '));
});

test('preload.js 必须在打包清单中（窗口上下文桥）', () => {
  const patterns = bundledFilesPatterns();
  assert.ok(patterns.some((pattern) => patternCovers(pattern, 'legacy/electron/preload.js')));
});
