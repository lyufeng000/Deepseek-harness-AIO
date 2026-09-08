import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/plugins/dsh-composer-dynamic-island/lib/client.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('    function fixedPositionIsReliable('), source.indexOf('    function discoverCandidates('));
const { fixedPositionOrigin, fixedPositionIsReliable } = vm.runInNewContext(`${functions}; ({fixedPositionOrigin, fixedPositionIsReliable})`, {
  window: { getComputedStyle: (node) => node.style },
});
const node = (style = {}, parentElement = null, rect = { left: 120, top: 300 }) => ({
  parentElement,
  style: { transform: 'none', filter: 'none', perspective: 'none', contain: 'none', backdropFilter: 'none', willChange: 'auto', ...style },
  clientLeft: 1, clientTop: 2, scrollLeft: 0, scrollTop: 0,
  getBoundingClientRect: () => rect,
});

test('ordinary ancestors retain viewport coordinates', () => {
  const child = node({}, node());
  assert.equal(fixedPositionOrigin(child).left, 0);
  assert.equal(fixedPositionOrigin(child).top, 0);
  assert.equal(fixedPositionIsReliable(child), true);
});

test('frosted composer offsets use padding edge and account for scrolling', () => {
  const card = node({ backdropFilter: 'blur(16px)' });
  card.scrollLeft = 3;
  card.scrollTop = 7;
  const child = node({}, card);
  assert.equal(fixedPositionIsReliable(child), true);
  assert.equal(fixedPositionOrigin(child).left, 118);
  assert.equal(fixedPositionOrigin(child).top, 295);
});

test('each contribution uses its nearest containing block', () => {
  const outer = node({ backdropFilter: 'blur(16px)' });
  const inner = node({ backdropFilter: 'blur(4px)' }, outer, { left: 180, top: 350 });
  assert.equal(fixedPositionOrigin(node({}, inner)).left, 181);
  assert.equal(fixedPositionOrigin(node({}, outer)).left, 121);
});

test('other non-transform containing blocks and root ancestors are handled', () => {
  for (const style of [{ webkitBackdropFilter: 'blur(4px)' }, { willChange: 'transform' }, { contain: 'layout' }, { contentVisibility: 'auto' }]) {
    assert.equal(fixedPositionOrigin(node({}, node(style))).top, 302);
  }
  for (const style of [{ transform: 'matrix(1,0,0,1,2,3)' }, { scale: '0.9' }, { rotate: '2deg' }, { translate: '2px' }, { contain: 'paint' }]) {
    assert.equal(fixedPositionIsReliable(node({}, node(style))), false);
  }
});

test('completed entrance animation retains its identity containing block', () => {
  const child = node({}, node({ transform: 'matrix(1, 0, 0, 1, 0, 0)' }));
  assert.equal(fixedPositionIsReliable(child), true);
  assert.equal(fixedPositionOrigin(child).top, 302);
});

test('scroll listener is removed on teardown and opening refreshes position', () => {
  assert.match(source, /document\.addEventListener\("scroll", scheduleItemLayout, true\)/);
  assert.match(source, /document\.removeEventListener\("scroll", scheduleItemLayout, true\)/);
  assert.match(source, /const open = \(\) => \{\s+layout\(\);\s+setOpen\(true\)/);
});

test('button bounds are included when a toolbar wrapper shrinks', () => {
  const measureSource = source.slice(source.indexOf('    function measureCandidate('), source.indexOf('    function packItems('));
  const measure = vm.runInNewContext(`${measureSource}; measureCandidate`, {
    buttonControlOf: () => ({ getBoundingClientRect: () => ({ width: 101, height: 28 }) }),
  });
  assert.equal(measure({ node: { getBoundingClientRect: () => ({ width: 28, height: 28 }) } }).width, 101);
});

test('popup remains within the composer column when a side panel is open', () => {
  const packSource = source.slice(source.indexOf('    function packItems('), source.indexOf('    function stateIsCurrent('));
  const pack = vm.runInNewContext(`${packSource}; packItems`, { MAX_PANEL_WIDTH: 520, window: { innerWidth: 1280, innerHeight: 800 } });
  const packed = pack([{ width: 200, height: 28 }], { left: 300, right: 880, width: 580 }, { left: 840, top: 700, bottom: 730, width: 38 });
  assert.ok(packed.left >= 300);
  assert.ok(packed.left + packed.panelWidth <= 880);
});

test('Escape closes a hover-open popup even when returning focus fires open', () => {
  const start = source.indexOf('      const onKeyDown = ');
  const end = source.indexOf('      const onDocumentPointerDown = ', start);
  const row = { dataset: { dshIslandOpen: 'true' } };
  let focused = false;
  const handler = vm.runInNewContext(`let pinned = true;\n${source.slice(start, end)}; onKeyDown`, {
    row,
    trigger: { focus() { focused = true; row.dataset.dshIslandOpen = 'true'; } },
    setOpen: open => { row.dataset.dshIslandOpen = String(open); },
  });
  handler({ key: 'Escape', defaultPrevented: false });
  assert.equal(focused, true);
  assert.equal(row.dataset.dshIslandOpen, 'false');
  assert.match(source, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(source, /document\.removeEventListener\("keydown", onKeyDown\)/);
});
