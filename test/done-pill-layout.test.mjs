import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform, apply, placeDonePill, watchDonePillLayout, donePillObstacles,
  donePillLayoutGroups, updateDonePillClearance, startDonePillClearance,
  NAME, VERSION, MARKER } = require('../scripts/patch-done-pill.cjs');
const metadata = { name: NAME, version: VERSION };
const viewport = { width: 1000, height: 700 };
const header = { left: 100, right: 900, top: 20, bottom: 90, width: 800, height: 70 };

function fakeLayoutElement(rect = header, { toolbar = false, display = 'block',
  visibility = 'visible', children = [], ancestor = null } = {}) {
  return {
    id: '', children, display, visibility,
    matches: () => toolbar,
    closest: (selector) => selector === '.dsh-done-pill' ? null : ancestor,
    querySelectorAll: () => children,
    getBoundingClientRect: () => rect
  };
}

test('default position, legacy anchor and dragged positions avoid header', () => {
  for (const x of [0, 200, 900]) {
    const pos = placeDonePill(x, 40, 500, 30, viewport, [header]);
    assert.equal(pos.y, 106);
    assert.ok(pos.x >= 8 && pos.x + 500 <= 992);
    assert.equal(pos.hidden, false);
  }
});

test('resize, header growth and scale include hover hit area', () => {
  const pos = placeDonePill(800, 40, 500, 48, { width: 600, height: 400 },
    [{ ...header, bottom: 130 }]);
  assert.ok(pos.y - 48 * 8 / 30 >= 138);
  assert.equal(pos.x, 92);
  assert.equal(pos.hidden, false);
});

test('hidden/offscreen/empty headers do not reserve space; safe manual position survives', () => {
  const pos = placeDonePill(200, 300, 200, 30, viewport, [
    { ...header, width: 0 }, { ...header, left: 1200, right: 1400 }
  ]);
  assert.deepEqual(pos, { x: 200, y: 300, hidden: false });
});

test('impossible viewport hides instead of clamping pill back over toolbar', () => {
  const pos = placeDonePill(0, 40, 200, 30, { width: 300, height: 110 }, [header]);
  assert.equal(pos.hidden, true);
  assert.ok(pos.y > header.bottom);
});

test('unknown metadata and unrecognized source fail closed', () => {
  assert.throws(() => transform('', { ...metadata, version: '0.5.2' }), /Unsupported/);
  assert.throws(() => transform('', metadata), /region/);
});

test('staging applies after copying seed and propagates patch failure', () => {
  const stage = fs.readFileSync(new URL('../tauri-app/scripts/stage.ts', import.meta.url), 'utf8');
  const copy = stage.indexOf("copyTree(PROFILE_SEED, path.join(RESOURCES, 'profile-seed'));");
  const patch = stage.indexOf("path.join(REPO_ROOT, 'scripts', 'patch-done-pill.cjs')");
  assert.ok(copy >= 0 && patch > copy);
  assert.match(stage.slice(copy, patch), /execFileSync\(process\.execPath/);
  assert.match(stage.slice(patch, patch + 350), /'--write'/);
  assert.match(stage.slice(patch, patch + 350), /path\.join\(RESOURCES, 'profile-seed'/);
});

test('observer coalesces changes, ignores pill mutations and cleans up', () => {
  const previous = { window: globalThis.window, document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
  let mutationCallback;
  let resizeCallback;
  let queued;
  let calls = 0;
  let disconnected = 0;
  const listeners = new Set();
  const realHeaderChild = fakeLayoutElement();
  let headers = [fakeLayoutElement(undefined, { display: 'contents', children: [realHeaderChild] })];
  const observed = new Set();
  globalThis.document = { body: {}, documentElement: {},
    querySelectorAll: (selector) => selector === '.dsh-done-pill' ? [] : headers };
  globalThis.window = {
    requestAnimationFrame: (fn) => { queued = fn; return 1; },
    cancelAnimationFrame: () => { queued = null; },
    addEventListener: (name) => listeners.add(name),
    removeEventListener: (name) => listeners.delete(name)
  };
  globalThis.ResizeObserver = class {
    constructor(fn) { resizeCallback = fn; }
    observe(el) { observed.add(el); }
    unobserve(el) { observed.delete(el); }
    disconnect() { disconnected++; }
  };
  globalThis.MutationObserver = class {
    constructor(fn) { mutationCallback = fn; }
    observe() {}
    disconnect() { disconnected++; }
  };
  try {
    const stop = watchDonePillLayout(() => calls++);
    assert.equal(observed.has(realHeaderChild), true, 'observe real layout children, not only slot hosts');
    mutationCallback([{ target: { nodeType: 1, closest: () => true } }]);
    assert.equal(queued, undefined);
    resizeCallback();
    const first = queued;
    resizeCallback();
    assert.equal(queued, first);
    first();
    assert.equal(calls, 1);
    const oldHeader = headers[0];
    headers = [fakeLayoutElement()];
    mutationCallback([{ target: { nodeType: 1, closest: () => false } }]);
    assert.equal(observed.has(oldHeader), false);
    assert.equal(observed.has(realHeaderChild), false);
    assert.equal(observed.has(headers[0]), true);
    stop();
    assert.equal(queued, null);
    assert.equal(disconnected, 2);
    assert.equal(listeners.size, 0);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('obstacle scan excludes composer toolbar and hidden header', () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  const make = (toolbar, top, visibility = 'visible') =>
    fakeLayoutElement({ ...header, top, bottom: top + header.height }, { toolbar, visibility });
  globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [
    make(false, 20), make(true, 12), make(true, 600), make(false, 20, 'hidden')
  ] };
  globalThis.window = { innerWidth: 1000, innerHeight: 800,
    getComputedStyle: (el) => ({ display: el.display, visibility: el.visibility }) };
  try {
    assert.equal(donePillObstacles().length, 2);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('display:contents resolves actual header, ancestor titleRow and button union', () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  const zero = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  const actual = fakeLayoutElement({ ...header, top: 32, bottom: 82, height: 50 });
  const contents = fakeLayoutElement(zero, { display: 'contents', children: [actual] });
  const utilities = fakeLayoutElement(zero, { display: 'contents', ancestor: actual });
  const leftButton = fakeLayoutElement({ left: 600, right: 700, top: 42, bottom: 70, width: 100, height: 28 });
  const rightButton = fakeLayoutElement({ left: 710, right: 800, top: 42, bottom: 86, width: 90, height: 44 });
  const buttonsOnly = fakeLayoutElement(zero, { display: 'contents', children: [leftButton, rightButton] });
  globalThis.document = {
    documentElement: { getAttribute: () => '32' },
    querySelectorAll: () => [contents, utilities, buttonsOnly]
  };
  globalThis.window = { innerWidth: 1000, innerHeight: 800,
    getComputedStyle: (el) => ({ display: el.display, visibility: el.visibility }) };
  try {
    const rects = donePillObstacles();
    assert.deepEqual(rects.map((rect) => rect.bottom), [32, 82, 82, 86]);
    const pos = placeDonePill(250, 40, 500, 30, viewport, rects);
    assert.equal(pos.y, 102, 'max absolute bottom + clearance, without adding 32 twice');
    assert.ok(pos.y - 8 > 86, 'hover wrapper also clears buttons');
    assert.ok(donePillLayoutGroups().some((group) => group.elements.has(actual)));
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('clearance updates CSS only, skips identical writes and restores visibility', () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  const values = new Map();
  let writes = 0;
  const wrapper = {
    querySelector: () => ({ getBoundingClientRect: () => ({ width: 500, height: 30 }) }),
    style: {
      getPropertyValue: (key) => values.get(key) || '',
      setProperty: (key, value) => { writes++; values.set(key, value); }
    }
  };
  globalThis.document = {
    documentElement: { getAttribute: () => '32' },
    querySelectorAll: (selector) => selector === '.dsh-done-pill' ? [wrapper] : [fakeLayoutElement()]
  };
  globalThis.window = { innerWidth: 1000, innerHeight: 700,
    getComputedStyle: (el) => ({ display: el.display, visibility: el.visibility }) };
  try {
    updateDonePillClearance();
    assert.equal(values.get('--eac-done-pill-floor'), '106px');
    assert.equal(values.get('--eac-done-pill-visibility'), 'visible');
    assert.equal(writes, 2);
    for (let i = 0; i < 100; i++) updateDonePillClearance();
    assert.equal(writes, 2, 'unchanged observations must produce zero DOM writes');
    globalThis.window.innerHeight = 110;
    updateDonePillClearance();
    assert.equal(values.get('--eac-done-pill-visibility'), 'hidden');
    globalThis.window.innerHeight = 700;
    updateDonePillClearance();
    assert.equal(values.get('--eac-done-pill-visibility'), 'visible');
  } finally {
    Object.assign(globalThis, previous);
  }
});

const playwrightPath = process.env.DSH_DONE_PILL_PLAYWRIGHT ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright') : '');

test('headless DOM: contents slots, native chrome and real child resize avoid overlap',
  { skip: !playwrightPath || !fs.existsSync(playwrightPath), timeout: 30000 }, async () => {
    const { chromium } = require(playwrightPath);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const chrome of [0, 32, 36]) {
        await page.setContent(`
          <style>
            body { margin: 0; }
            [data-slot] { display: contents; }
            #__dsh_desktop_chrome__ { position: fixed; inset: 0 0 auto; height: ${chrome}px; }
            header { position: fixed; top: ${chrome}px; left: 200px; right: 0; height: 54px; }
            .titleRow { display: flex; align-items: center; justify-content: end; height: 100%; }
            button { height: 30px; }
            [role=toolbar] { position: fixed; top: 600px; height: 40px; }
            .dsh-done-pill { position:fixed; left:250px;
              top:max(40px,var(--eac-done-pill-floor,0px)); padding:8px 0; margin-top:-8px;
              visibility:var(--eac-done-pill-visibility,hidden); }
            .dsh-done-pill-shell { width:500px; height:30px; }
          </style>
          <div id="__dsh_desktop_chrome__"></div>
          <div data-slot="conversation.session.header">
            <header><div class="titleRow">
              <span data-slot="conversation.session.header.utilities">
                <button>Session log</button><button>Conversation</button><button>Trace</button>
              </span>
            </div></header>
          </div>
          <div role="toolbar"><button>Composer</button></div>
          <div class="dsh-done-pill"><div class="dsh-done-pill-shell"></div></div>
        `);
        await page.evaluate((height) => document.documentElement.setAttribute(
          'data-dsh-title-bar-height', String(height)), chrome);
        await page.addScriptTag({ content: [placeDonePill, donePillLayoutGroups,
          donePillObstacles, updateDonePillClearance, watchDonePillLayout,
          startDonePillClearance].map((fn) => fn.toString()).join('\n') });
        const initial = await page.evaluate(() => {
          window.stopLayoutWatch?.();
          const sync = () => {
            window.pillPosition = placeDonePill(250, 40, 500, 30,
              { width: innerWidth, height: innerHeight }, donePillObstacles());
          };
          window.stopLayoutWatch = watchDonePillLayout(sync);
          window.stopClearance = startDonePillClearance();
          sync();
          return {
            slotHeight: document.querySelector('[data-slot]').getBoundingClientRect().height,
            headerBottom: document.querySelector('header').getBoundingClientRect().bottom,
            position: window.pillPosition,
            shellTop: document.querySelector('.dsh-done-pill-shell').getBoundingClientRect().top,
            visibility: getComputedStyle(document.querySelector('.dsh-done-pill')).visibility
          };
        });
        assert.equal(initial.slotHeight, 0);
        assert.equal(initial.position.y, initial.headerBottom + 16);
        assert.equal(initial.position.hidden, false);
        assert.equal(initial.shellTop, initial.headerBottom + 16);
        assert.equal(initial.visibility, 'visible');
        await page.evaluate(() => { document.querySelector('header').style.height = '96px'; });
        await page.waitForFunction((y) => window.pillPosition.y === y, chrome + 96 + 16);
        // No header/titleRow layout boxes remain: button union is the fallback.
        const union = await page.evaluate((height) => {
          document.querySelector('header').style.display = 'contents';
          document.querySelector('.titleRow').style.display = 'contents';
          const buttons = [...document.querySelectorAll('header button')];
          buttons.forEach((button, i) => Object.assign(button.style, {
            position: 'fixed', left: `${500 + i * 100}px`, top: `${height + 12}px`,
            height: i === 2 ? '44px' : '30px'
          }));
          const bottom = Math.max(...buttons.map((el) => el.getBoundingClientRect().bottom));
          return { bottom, position: placeDonePill(250, 40, 500, 30,
            { width: innerWidth, height: innerHeight }, donePillObstacles()) };
        }, chrome);
        assert.equal(union.position.y, union.bottom + 16);
        assert.ok(union.position.y - 8 > union.bottom);
        const chromeOnly = await page.evaluate(() => {
          document.querySelector('header').style.display = 'none';
          return placeDonePill(250, 8, 500, 30,
            { width: innerWidth, height: innerHeight }, donePillObstacles());
        });
        assert.equal(chromeOnly.y, chrome > 0 ? chrome + 16 : 16);
        await page.evaluate(() => { window.stopLayoutWatch(); window.stopClearance(); });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

const installed = process.env.DSH_DONE_PILL_TEST_PACKAGE ||
  (process.env.APPDATA ? path.join(process.env.APPDATA, 'com.deepseek.dsh.desktop.aio',
    'dsh-home', 'profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui') : '');

test('real installed bundle: strict transform, syntax, idempotence and isolated apply',
  { skip: !installed || !fs.existsSync(path.join(installed, 'lib', 'client.js')) }, () => {
    const original = fs.readFileSync(path.join(installed, 'lib', 'client.js'), 'utf8');
    const realMetadata = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const result = transform(original, realMetadata);
    assert.equal(result.changed, !original.includes(MARKER));
    assert.ok(result.source.includes(MARKER));
    new vm.Script(result.source);
    assert.deepEqual(transform(result.source, realMetadata), { source: result.source, changed: false });
    const patchScript = fs.readFileSync(require.resolve('../scripts/patch-done-pill.cjs'), 'utf8');
    for (const eol of ['\n', '\r\n']) {
      const module = { exports: {} };
      vm.runInNewContext(patchScript.replace(/\r?\n/g, eol), { require, module });
      const checkoutResult = module.exports.transform(result.source, realMetadata);
      assert.equal(checkoutResult.changed, false, 'patch checkout line endings must not affect verification');
      assert.equal(checkoutResult.source, result.source);
    }
    const crlf = original.replace(/\r?\n/g, '\r\n');
    const crlfPatched = transform(crlf, realMetadata).source;
    assert.ok(!/(?<!\r)\n/.test(crlfPatched));
    assert.equal(transform(crlfPatched, realMetadata).changed, false);
    assert.throws(() => transform(original.replace('const SHELL_MAX_W = 720;', 'const SHELL_MAX_W = 721;'),
      realMetadata), /fingerprint/);
    assert.throws(() => transform(result.source.replace('const gap = 16;', 'const gap = 17;'),
      realMetadata), /mismatch|fingerprint/);
    assert.throws(() => transform(result.source.replace(MARKER, '// EAC_DONE_PILL_LAYOUT_V1'),
      realMetadata), /restore the verified original/);
    const regionStart = original.indexOf('//#region src/client/done-pill.tsx');
    const regionEnd = original.indexOf('//#endregion', regionStart);
    assert.equal(result.source.slice(0, regionStart), original.slice(0, regionStart));
    assert.ok(result.source.endsWith(original.slice(regionEnd)));
    const component = (source) => {
      const start = source.indexOf('\t\tfunction DonePill(props) {');
      const end = source.indexOf('\t\tfunction applyDonePill(ctx) {', start);
      assert.ok(start > 0 && end > start);
      return source.slice(start, end);
    };
    assert.equal(component(result.source), component(original),
      'all original React hooks, state setters, dragging and saved anchors remain byte-identical');
    assert.ok(result.source.includes('top: `max(${pos.y}px, var(--eac-done-pill-floor, 0px))`'));
    assert.ok(result.source.includes('ctx.effect(() => startDonePillClearance()'));
    assert.ok(!result.source.includes('watchDonePillLayout(syncPosition)'));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'done-pill-test-'));
    try {
      fs.mkdirSync(path.join(temp, 'lib'));
      fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify(realMetadata));
      fs.writeFileSync(path.join(temp, 'lib', 'client.js'), original);
      assert.equal(apply(temp).changed, result.changed);
      assert.equal(fs.readFileSync(path.join(temp, 'lib', 'client.js'), 'utf8'), original);
      assert.equal(apply(temp, { write: true }).changed, result.changed);
      assert.equal(apply(temp, { write: true }).changed, false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    assert.equal(fs.readFileSync(path.join(installed, 'lib', 'client.js'), 'utf8'), original);
  });
