import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchConversationScrollSampling } from '../scripts/patch-deps.js';

const OLD_BUNDLE = [
  'const atBottomRef = (0, react.useRef)(true);',
  '\t\t\tconst [atBottom, setAtBottom] = (0, react.useState)(true);',
  '(0, react.useLayoutEffect)(() => {',
  '\t\t\t\tconst local = listRef.current;',
  '\t\t\t\t/* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */',
  '\t\t\t\tif (local === null) return;',
  '\t\t\t});',
  '(0, react.useEffect)(() => {',
  '\t\t\t\tconst local = listRef.current;',
  '\t\t\t\t/* v8 ignore next -- ref-null guard: effect runs after the list node commits. */',
  '\t\t\t\tif (local === null) return;',
  '\t\t\t\tconst el = scrollerOf(local);',
  '\t\t\t\tconst onScroll = () => {',
  '\t\t\t\t\tonScrollRef.current();',
  '\t\t\t\t};',
  '\t\t\t\tel.addEventListener("scroll", onScroll, { passive: true });',
  '\t\t\t\treturn () => {',
  '\t\t\t\t\tel.removeEventListener("scroll", onScroll);',
  '\t\t\t\t};',
  '\t\t\t}, []);',
  'const followRef = (0, react.useRef)(null);',
  '\t\t\tfollowRef.current = () => {',
  '\t\t\t\tconst local = listRef.current;',
  '\t\t\t};',
].join('\n');

function makeRoot(source = OLD_BUNDLE) {
  const root = mkdtempSync(join(tmpdir(), 'patchdeps-scroll-'));
  const lib = join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib');
  mkdirSync(lib, { recursive: true });
  const file = join(lib, 'client.js');
  writeFileSync(file, source, 'utf8');
  return { root, file };
}

test('回移上游滚动采样，保护真实惯性与近底部滑动手势', () => {
  const { root, file } = makeRoot();
  const result = patchConversationScrollSampling(root);
  assert.equal(result.patched, true);

  const output = readFileSync(file, 'utf8');
  assert.match(output, /scrollSamplePendingRef/);
  assert.match(output, /addEventListener\("scrollend", sample/);
  assert.match(output, /setTimeout\(sample, 500\)/);
  assert.match(output, /if \(scrollSamplePendingRef\.current\) return;/);
  assert.match(output, /Math\.abs\(el\.scrollTop - Math\.min\(observedTopRef\.current, floor\)\) > \.5/);
});

test('幂等：已应用会话滚动补丁时不再改写', () => {
  const { root, file } = makeRoot();
  patchConversationScrollSampling(root);
  const before = readFileSync(file, 'utf8');
  const result = patchConversationScrollSampling(root);
  assert.equal(result.patched, false);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('目标包或旧版锚点不存在时安全跳过', () => {
  const empty = mkdtempSync(join(tmpdir(), 'patchdeps-scroll-empty-'));
  assert.equal(patchConversationScrollSampling(empty).patched, false);

  const { root } = makeRoot('const alreadyNewer = true;');
  assert.equal(patchConversationScrollSampling(root).patched, false);
});
