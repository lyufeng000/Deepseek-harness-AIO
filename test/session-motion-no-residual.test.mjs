import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { originalWebui } from './fixture-paths.mjs';

const require = createRequire(import.meta.url);
const { transform, apply, EDITS, NAME, VERSION, MARKER, SOURCE_HASH } =
  require('../scripts/patch-session-motion.cjs');
const { transform: donePillTransform } = require('../scripts/patch-done-pill.cjs');

const metadata = { name: NAME, version: VERSION };
const REGION = '//#region src/client/session-motion.ts';
const END = '//#endregion';

/** 浏览器用例与被测源码共用的两条规则（下面会与真实产物逐字对账）。 */
const SWAP_IN_CSS = `@keyframes dsh-webui-swap-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
[data-conversation-scroll] :is([class*="viewArea"], [class*="composerHero"]) {
  animation: dsh-webui-swap-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
`;

function patchedCss(css) {
  let text = css;
  for (const [before, after] of EDITS) text = text.replace(before, after);
  return text;
}

// 未打过补丁的真实产物：环境变量 → 审核过的 WebUI 归档夹具 → 本机 profile。
// 夹具优先，保证断言不依赖某台机器上是否已手工打过补丁。
const installed = [
  process.env.DSH_SESSION_MOTION_TEST_PACKAGE,
  originalWebui,
  process.env.APPDATA ? path.join(process.env.APPDATA, 'com.deepseek.dsh.desktop.aio',
    'dsh-home', 'profiles', 'web-desktop', 'node_modules', '@dsh-external', 'dsh-webui') : '',
].filter(Boolean).find(candidate => {
  const client = path.join(candidate, 'lib', 'client.js');
  return fs.existsSync(client) && !fs.readFileSync(client, 'utf8').includes(MARKER);
}) ?? '';

test('unknown metadata, missing region and unknown builds fail closed', () => {
  assert.throws(() => transform('', { ...metadata, version: '0.5.2' }), /Unsupported/);
  assert.throws(() => transform('', { ...metadata, name: '@dsh-external/other' }), /Unsupported/);
  assert.throws(() => transform('', metadata), /region/);
  assert.throws(() => transform(
    `const x = 1;\n${REGION}\nconst y = 2;\n${END}\n`, metadata), /fingerprint/);
  assert.throws(() => transform(
    `const x = 1;\n${REGION}\n/* EAC_SESSION_MOTION_NO_RESIDUAL_V0 */\n${END}\n`, metadata),
  /restore the verified original/);
  assert.throws(() => transform(null, metadata), TypeError);
});

test('staging patches the copied seed after copy and the cache key tracks the script', () => {
  const stage = fs.readFileSync(new URL('../tauri-app/scripts/stage.ts', import.meta.url), 'utf8');
  const copy = stage.indexOf("copyTree(PROFILE_SEED, path.join(RESOURCES, 'profile-seed'));");
  const sessionPatch = stage.indexOf("path.join(REPO_ROOT, 'scripts', 'patch-session-motion.cjs')");
  assert.ok(copy >= 0 && sessionPatch > copy, 'session-motion patch must run on the staged seed copy');
  assert.match(stage.slice(copy, sessionPatch), /execFileSync\(process\.execPath/);
  const block = stage.slice(sessionPatch, sessionPatch + 350);
  assert.match(block, /'--write'/);
  assert.match(block, /path\.join\(RESOURCES, 'profile-seed'/);
  assert.match(block, /'@dsh-external', 'dsh-webui'/);
  const prepare = fs.readFileSync(new URL('../scripts/prepare-aio.mjs', import.meta.url), 'utf8');
  assert.ok(prepare.includes("'scripts/patch-session-motion.cjs'"),
    'the staging content fingerprint must include the new patch script');
});

test('anchors and fingerprints match the reviewed WebUI artifact',
  { skip: !installed }, () => {
    const original = fs.readFileSync(path.join(installed, 'lib', 'client.js'), 'utf8');
    const normalized = original.replace(/\r\n/g, '\n');
    assert.equal(normalized.split(REGION).length, 2);
    const start = normalized.indexOf(REGION);
    const end = normalized.indexOf(END, start);
    // 补丁锚点逐字来自真实产物；指纹锚定同一区段。
    for (const [before] of EDITS) assert.ok(normalized.slice(start, end).includes(before));
    assert.ok(normalized.includes('  from { opacity: 0; transform: translateY(10px); }'));
    assert.ok(normalized.includes('@keyframes dsh-webui-swap-in {'));
    // 浏览器用例使用的规则文本必须与真实产物一致。
    for (const line of SWAP_IN_CSS.split('\n').filter(Boolean)) {
      assert.ok(normalized.includes(line), `browser fixture drifted from the artifact: ${line}`);
    }
    assert.equal(SOURCE_HASH.length, 64);
  });

test('real bundle: strict transform, syntax, idempotence and isolated apply',
  { skip: !installed }, () => {
    const clientPath = path.join(installed, 'lib', 'client.js');
    const original = fs.readFileSync(clientPath, 'utf8');
    const realMetadata = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const result = transform(original, realMetadata);
    assert.equal(result.changed, true);
    assert.ok(result.source.includes(MARKER));
    new vm.Script(result.source);
    const normalized = (text) => text.replace(/\r\n/g, '\n');
    const index = (text, needle) => {
      const at = text.indexOf(needle);
      assert.ok(at >= 0, `missing ${needle}`);
      return at;
    };
    // 区段偏移必须量在 LF 文本上（原文件是 CRLF，直接用原串偏移会错位）。
    const normOriginal = normalized(original);
    const start = index(normOriginal, REGION);
    const end = start + index(normOriginal.slice(start), END);
    const normPatched = normalized(result.source);
    const patchedEnd = start + index(normPatched.slice(start), END);
    // 除 session-motion 区段外逐字节不变（含 DonePill 等其他插件区段）。
    assert.equal(normPatched.slice(0, start), normOriginal.slice(0, start));
    assert.equal(normPatched.slice(patchedEnd), normOriginal.slice(end));
    const region = normPatched.slice(start, patchedEnd);
    let expected = normOriginal.slice(start, end);
    for (const [editBefore, editAfter] of EDITS) {
      assert.ok(expected.includes(editBefore), `anchor missing in the region: ${editBefore.slice(0, 60)}`);
      expected = expected.replace(editBefore, editAfter);
    }
    assert.equal(region, expected,
      'the patched region must be the original region plus the controlled edits');
    assert.equal(region.split(MARKER).length - 1, 1);
    for (const [, after] of EDITS) assert.ok(region.includes(after));
    // 幂等：第二次只校验。
    assert.deepEqual(transform(result.source, realMetadata), { source: result.source, changed: false });
    // CRLF 往返。
    const crlf = original.replace(/\r?\n/g, '\r\n');
    const crlfPatched = transform(crlf, realMetadata).source;
    assert.ok(!/(?<!\r)\n/.test(crlfPatched));
    assert.equal(transform(crlfPatched, realMetadata).changed, false);
    // 与 DonePill 补丁共存：顺序无关，双向幂等。
    const donePillFirst = donePillTransform(original, realMetadata);
    assert.equal(donePillFirst.changed, true);
    assert.equal(transform(donePillFirst.source, realMetadata).changed, true);
    assert.equal(transform(result.source, realMetadata).changed, false);
    const sessionThenDonePill = donePillTransform(result.source, realMetadata).source;
    const donePillThenSession = transform(donePillFirst.source, realMetadata);
    assert.equal(donePillThenSession.changed, true);
    assert.equal(donePillThenSession.source, sessionThenDonePill, 'patch order must not matter');
    assert.equal(donePillTransform(sessionThenDonePill, realMetadata).changed, false);
    assert.equal(transform(sessionThenDonePill, realMetadata).changed, false);
    // 上游内容一变就拒绝，而不是盲目改写。
    assert.throws(() => transform(original.replace('const SLIDE_DURATION = 260;',
      'const SLIDE_DURATION = 261;'), realMetadata), /fingerprint/);
    assert.throws(() => transform(result.source.replace(MARKER, '/* moved */'),
      realMetadata), /fingerprint/);
    // apply 默认只读；显式 --write 才落盘，且第二次不再改写。
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-motion-test-'));
    try {
      fs.mkdirSync(path.join(temp, 'lib'));
      fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify(realMetadata));
      fs.writeFileSync(path.join(temp, 'lib', 'client.js'), original);
      assert.equal(apply(temp).changed, true);
      assert.equal(fs.readFileSync(path.join(temp, 'lib', 'client.js'), 'utf8'), original);
      assert.equal(apply(temp, { write: true }).changed, true);
      assert.equal(apply(temp, { write: true }).changed, false);
      assert.equal(fs.readFileSync(path.join(temp, 'lib', 'client.js'), 'utf8'), result.source);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    assert.equal(fs.readFileSync(clientPath, 'utf8'), original, 'the source copy must stay read-only');
  });

const playwrightPath = process.env.DSH_DONE_PILL_PLAYWRIGHT ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright') : '');

test('real engine: finished entrance keeps no transform and no fixed containing block',
  { skip: !playwrightPath || !fs.existsSync(playwrightPath), timeout: 60000 }, async () => {
    const { chromium } = require(playwrightPath);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const probes = {};
      for (const [name, css] of [['current', SWAP_IN_CSS], ['patched', patchedCss(SWAP_IN_CSS)]]) {
        await page.setContent(`
          <style>
            body { margin: 0; }
            #scroller { position: relative; width: 200px; height: 300px; overflow-y: auto; }
            #inner { height: 2000px; }
            #row { height: 40px; }
            #probe { position: fixed; top: 10px; left: 10px; width: 40px; height: 20px; background: #000; }
          </style>
          <div id="scroller" data-conversation-scroll="">
            <div id="inner" class="wSkVaW_viewArea">
              <div id="probe"></div>
              <div id="row"></div>
            </div>
          </div>
        `);
        await page.addStyleTag({ content: css });
        await page.waitForTimeout(700); // 400ms 入场动画必须已经播完
        probes[name] = await page.evaluate(() => {
          const scroller = document.querySelector('#scroller');
          const inner = document.querySelector('#inner');
          const probe = document.querySelector('#probe');
          const row = document.querySelector('#row');
          const beforeProbe = probe.getBoundingClientRect().top;
          const beforeRow = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop = 200;
          const afterProbe = probe.getBoundingClientRect().top;
          const afterRow = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          return {
            transform: getComputedStyle(inner).transform,
            probeShift: Math.round(afterProbe - beforeProbe),
            rowShift: Math.round(afterRow - beforeRow),
          };
        });
      }
      assert.deepEqual(errors, []);
      // 现行 CSS：动画结束后单位矩阵仍在 → 该盒仍是 fixed 后代的包含块，
      // 视口定位的控件跟着内容滚走（用户看到的抽动/错位）。
      assert.notEqual(probes.current.transform, 'none');
      assert.equal(probes.current.probeShift, -200);
      assert.equal(probes.current.rowShift, -200);
      // 补丁后：没有残留变换，fixed 后代保持视口定位，行位移仍是纯滚动量。
      assert.equal(probes.patched.transform, 'none');
      assert.equal(probes.patched.probeShift, 0);
      assert.equal(probes.patched.rowShift, -200);
    } finally {
      await browser.close();
    }
  });
