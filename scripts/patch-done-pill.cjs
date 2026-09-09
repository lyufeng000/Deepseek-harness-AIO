'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.5.1';
const NAME = '@dsh-external/dsh-webui';
const REGION = '\t\t//#region src/client/done-pill.tsx';
const END = '\t\t//#endregion';
const MARKER = '// EAC_DONE_PILL_LAYOUT_V3';
const SOURCE_HASH = '07ea83bb68b66cd1a21f73ca64313b66d168ae681a929b4afc34f77a790d459d';
const HEADER_SELECTOR = '[data-slot="conversation.session.header"]';
const TOOLBAR_SELECTOR = '[role="toolbar"]';

// Reserve the entire top band so width/left transitions cannot cross controls.
function placeDonePill(x, y, w, h, viewport, obstacles) {
  const margin = 8;
  const gap = 16; // Includes the wrapper's 8px hover padding at normal scale.
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  const hoverPad = height * 8 / 30;
  const clearance = Math.max(gap, hoverPad + margin);
  let floor = margin + hoverPad;
  for (const rect of obstacles) {
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
        rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width) {
      floor = Math.max(floor, rect.bottom + clearance);
    }
  }
  const maxY = viewport.height - height - margin - hoverPad;
  return {
    x: Math.round(Math.max(margin, Math.min(x, viewport.width - width - margin))),
    y: Math.ceil(Math.max(floor, Math.min(y, maxY))),
    hidden: maxY < floor || width > viewport.width - margin * 2
  };
}

function donePillLayoutGroups() {
  const groups = [];
  for (const el of document.querySelectorAll(
    '[data-slot="conversation.session.header"],[data-slot="conversation.session.header.utilities"],[role="toolbar"],#__dsh_desktop_chrome__'
  )) {
    if (el.closest('.dsh-done-pill')) continue;
    const chrome = el.id === '__dsh_desktop_chrome__';
    const toolbar = el.matches('[role="toolbar"]');
    const elements = new Set([el]);
    if (!chrome) {
      // Slot hosts use display:contents; measure their actual layout and controls.
      if (!toolbar) {
        const ancestor = el.closest('header,[class*="titleRow"]');
        if (ancestor) elements.add(ancestor);
      }
      for (const child of el.children) elements.add(child);
      for (const child of el.querySelectorAll(
        'header,[class*="titleRow"],[data-slot],button,[role="button"],[role="tab"],[role="tablist"],a'
      )) elements.add(child);
    }
    groups.push({ toolbar, elements });
  }
  return groups;
}

function donePillObstacles() {
  const result = [];
  const rawHeight = Number(document.documentElement.getAttribute('data-dsh-title-bar-height'));
  const chromeHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 0;
  if (chromeHeight > 0) result.push({
    left: 0, right: window.innerWidth, top: 0, bottom: chromeHeight,
    width: window.innerWidth, height: chromeHeight
  });
  for (const group of donePillLayoutGroups()) {
    const rects = [];
    for (const el of group.elements) {
      if (el.closest('.dsh-done-pill')) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
          rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
        rects.push(rect);
      }
    }
    if (rects.length === 0) continue;
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    // Coordinates already include the native chrome offset; never add it twice.
    if (group.toolbar && top >= Math.max(100, chromeHeight + 68)) continue;
    result.push({ left, right, top, bottom, width: right - left, height: bottom - top });
  }
  return result;
}

function updateDonePillClearance() {
  const obstacles = donePillObstacles();
  for (const wrapper of document.querySelectorAll('.dsh-done-pill')) {
    const shell = wrapper.querySelector('.dsh-done-pill-shell');
    if (!shell) continue;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const bound = placeDonePill(8, 0, rect.width, rect.height,
      { width: window.innerWidth, height: window.innerHeight }, obstacles);
    // Do not enter React's state/layout-effect cycle or rewrite identical styles.
    for (const [key, value] of [
      ['--eac-done-pill-floor', `${bound.y}px`],
      ['--eac-done-pill-visibility', bound.hidden ? 'hidden' : 'visible']
    ]) {
      if (wrapper.style.getPropertyValue(key) !== value) wrapper.style.setProperty(key, value);
    }
  }
}

function watchDonePillLayout(sync) {
  let frame = null;
  let disposed = false;
  const observed = new Set();
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      sync();
    });
  };
  const resize = new ResizeObserver(schedule);
  const refresh = () => {
    const next = new Set(donePillLayoutGroups().flatMap((group) => [...group.elements]));
    for (const wrapper of document.querySelectorAll('.dsh-done-pill')) next.add(wrapper);
    next.add(document.documentElement);
    for (const el of observed) {
      if (!next.has(el)) {
        resize.unobserve(el);
        observed.delete(el);
      }
    }
    for (const el of next) {
      if (!observed.has(el)) {
        observed.add(el);
        resize.observe(el);
      }
    }
  };
  const mutations = new MutationObserver((records) => {
    if (!records.some((record) => {
      const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return !el?.closest('.dsh-done-pill');
    })) return;
    refresh();
    schedule();
  });
  refresh();
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'data-sidebar-collapsed',
      'data-dsh-sidebar-collapsed', 'data-dsh-title-bar-height', 'data-slot', 'role']
  });
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  };
}

function startDonePillClearance() {
  updateDonePillClearance();
  const stop = watchDonePillLayout(updateDonePillClearance);
  return () => {
    stop();
    for (const wrapper of document.querySelectorAll('.dsh-done-pill')) {
      wrapper.style.removeProperty('--eac-done-pill-floor');
      wrapper.style.removeProperty('--eac-done-pill-visibility');
    }
  };
}

const helpers = '\n' + MARKER + '\n' + [
  placeDonePill, donePillLayoutGroups, donePillObstacles, updateDonePillClearance,
  watchDonePillLayout, startDonePillClearance
].map((fn) => fn.toString().replace(/\r\n/g, '\n')).join('\n') + '\n';
const edits = [
  [REGION, REGION + helpers],
  [
    '\t\t\t\ttop: defaultShellTop(),',
    '\t\t\t\ttop: `max(${defaultShellTop()}px, var(--eac-done-pill-floor, 0px))`,'
  ],
  [
    '\t\t\t\ttop: pos.y,',
    '\t\t\t\ttop: `max(${pos.y}px, var(--eac-done-pill-floor, 0px))`,'
  ],
  ['\t\t\tzIndex: 9400,', '\t\t\tzIndex: 9400,\n\t\t\tvisibility: "var(--eac-done-pill-visibility, hidden)",'],
  [
    '\t\tfunction applyDonePill(ctx) {\n\t\t\tensurePillKeyframes();',
    '\t\tfunction applyDonePill(ctx) {\n\t\t\tensurePillKeyframes();\n\t\t\tctx.effect(() => startDonePillClearance(), "webui: done-pill layout clearance");'
  ]
];

function replaceStrict(source, before, after, expected = 1) {
  const parts = source.split(before);
  if (parts.length !== expected + 1) {
    throw new Error(`DonePill patch anchor mismatch: expected ${expected}, got ${parts.length - 1}: ${before.slice(0, 100)}`);
  }
  return parts.join(after);
}

function hash(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function transform(source, metadata) {
  if (metadata?.name !== NAME || metadata?.version !== VERSION) {
    throw new Error(`Unsupported DonePill package: ${metadata?.name}@${metadata?.version}; expected ${NAME}@${VERSION}`);
  }
  if (typeof source !== 'string') throw new TypeError('client source must be a string');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.split(REGION).length !== 2) throw new Error('Expected exactly one DonePill source region');
  const start = normalized.indexOf(REGION);
  const end = normalized.indexOf(END, start);
  if (end < 0) throw new Error('Missing DonePill region terminator');
  const region = normalized.slice(start, end);
  if (region.includes('// EAC_DONE_PILL_LAYOUT_V') && !region.includes(MARKER)) {
    throw new Error('Unsupported older DonePill patch; restore the verified original client.js before applying V3');
  }
  let original = region;
  const alreadyPatched = region.includes(MARKER);
  if (alreadyPatched) {
    for (const [before, after, count] of [...edits].reverse()) {
      original = replaceStrict(original, after, before, count);
    }
  }
  if (hash(original) !== SOURCE_HASH) {
    throw new Error('Unsupported DonePill source fingerprint (modified or unknown build)');
  }
  if (alreadyPatched) return { source, changed: false };
  let patched = original;
  for (const [before, after, count] of edits) {
    patched = replaceStrict(patched, before, after, count);
  }
  const result = normalized.slice(0, start) + patched + normalized.slice(end);
  return { source: eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result, changed: true };
}

// A dry run by default. The caller must explicitly authorize a filesystem write.
function apply(packageDir, { write = false } = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const clientPath = path.join(packageDir, 'lib', 'client.js');
  const result = transform(fs.readFileSync(clientPath, 'utf8'), metadata);
  if (write && result.changed) {
    const temp = `${clientPath}.eac-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, result.source, { flag: 'wx' });
      fs.renameSync(temp, clientPath);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  return { ...result, clientPath };
}

module.exports = { transform, apply, placeDonePill, watchDonePillLayout,
  donePillLayoutGroups, donePillObstacles, updateDonePillClearance, startDonePillClearance,
  VERSION, NAME, MARKER, SOURCE_HASH, HEADER_SELECTOR, TOOLBAR_SELECTOR };

if (require.main === module) {
  const args = process.argv.slice(2);
  const write = args[0] === '--write';
  const packageDir = args[write ? 1 : 0];
  if (!packageDir || args.length !== (write ? 2 : 1)) {
    console.error('Usage: node patch-done-pill.cjs [--write] <dsh-webui-package-directory>');
    process.exitCode = 1;
  } else {
    try {
      const result = apply(path.resolve(packageDir), { write });
      console.log(result.changed ? (write ? 'DonePill patched' : 'DonePill patch validated (dry run)') : 'DonePill already patched and verified');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
