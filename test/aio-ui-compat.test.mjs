import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildCompat, UPSTREAM_COMMIT } from '../scripts/build-aio-ui-compat.mjs';
import * as surface from '@deepseek-ai/dsh-session/surface';
import * as host from '../assets/plugins/dsh-aio-ui-compat/lib/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'assets/plugins/dsh-aio-ui-compat');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const asset = fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8');
const upstream = process.env.DSH_AIO_COMPAT_UPSTREAM ||
  path.resolve(root, '../deepseek-harness-upstream-20260908');
const playwright = process.env.DSH_AIO_COMPAT_PLAYWRIGHT ||
  path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes',
    'codex-primary-runtime/dependencies/node/node_modules/playwright');

function loadModule() {
  let registration;
  vm.runInNewContext(asset, { window: { __ModuleLoader__: {
    load(value) { registration = value; },
  } } });
  assert.equal(registration.id, 'dsh-aio-ui-compat');
  const requested = [];
  const api = registration.factory(id => {
    requested.push(id);
    // SSR never opens the portal; no removed UI exports are supplied.
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    assert.ok(['react', 'react/jsx-runtime', 'react-dom'].includes(id), id);
    return require(id);
  });
  return { api, requested };
}

test('package contract, no-op host, exact client exports and clean delivery', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json')));
  assert.equal(pkg.name, 'dsh-aio-ui-compat');
  assert.equal(pkg.version, '1.0.0');
  assert.deepEqual(pkg.dsh.client, { inject: [], platform: 'web' });
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(fs.readFileSync(path.join(plugin, 'cordis.patch.yml'), 'utf8'),
    /name: dsh-aio-ui-compat/);
  assert.equal(host.name, pkg.name);
  assert.deepEqual(host.inject, []);
  assert.equal(host.apply(new Proxy({}, { get() { throw Error('Host access'); } })), undefined);
  const { api } = loadModule();
  assert.deepEqual(Object.keys(api).sort(), [
    'ImageGallery', 'MessageText', 'apply', 'inject',
    'isAppendSurfaceEvent', 'isReplacementSurfaceEvent',
  ]);
  assert.doesNotMatch(asset, /sourceMappingURL|sourceURL|[A-Za-z]:[\\/]|node_modules\/|packages\/client\//);
  assert.deepEqual(fs.readdirSync(path.join(plugin, 'lib')).sort(), ['client.js', 'index.js']);
  const provenance = JSON.parse(fs.readFileSync(path.join(plugin, 'PROVENANCE.json')));
  assert.equal(provenance.commit, UPSTREAM_COMMIT);
  assert.equal(provenance.clientSha256, createHash('sha256').update(asset).digest('hex'));
  assert.equal(provenance.session.version, require('@deepseek-ai/dsh-session/package.json').version);
  assert.match(fs.readFileSync(path.join(plugin, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 DeepSeek/);
});

test('generated MessageText escapes HTML and retains literal Markdown and newlines', () => {
  const { api } = loadModule();
  const text = '<script>alert("x")</script>\n**not bold** & [link](https://example.test)\n  spaces';
  const html = renderToStaticMarkup(React.createElement(api.MessageText, { text }));
  assert.match(html, /^<div class="[^"]+">/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n**not bold** &amp;'));
  assert.ok(html.endsWith('\n  spaces</div>'));
  assert.doesNotMatch(html, /<(script|strong|a|p|br)\b/);
  assert.match(renderToStaticMarkup(React.createElement(api.MessageText, { text: '' })),
    /^<div class="[^"]+"><\/div>$/);
});

test('generated surface predicates match installed canonical surface module', () => {
  const { api } = loadModule();
  for (const type of ['user/message', 'assistant/message', 'tool/result', 'system/message', 'unknown']) {
    for (const surfaceOp of [undefined, 'append', { start: 0, end: 1 }, null, 'other']) {
      const event = { type, surfaceOp };
      assert.equal(api.isAppendSurfaceEvent(event), surface.isAppendSurfaceEvent(event));
      assert.equal(api.isReplacementSurfaceEvent(event), surface.isReplacementSurfaceEvent(event));
    }
  }
});

test('builder requires pinned checkout and reproduces checked-in asset', async () => {
  await assert.rejects(buildCompat(), /Required: --upstream/);
  await assert.rejects(buildCompat(root), /Upstream must be pinned/);
  const before = fs.readFileSync(path.join(plugin, 'PROVENANCE.json'), 'utf8');
  await buildCompat(upstream, { check: true });
  assert.equal(fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8'), asset);
  assert.equal(fs.readFileSync(path.join(plugin, 'PROVENANCE.json'), 'utf8'), before);
});

test('real browser: text, old gallery props, previews, cache, retry, portal and CSS lifecycle',
  { timeout: 60000 }, async () => {
    assert.ok(fs.existsSync(playwright), 'Set DSH_AIO_COMPAT_PLAYWRIGHT to the Playwright runtime');
    const { build } = createRequire(path.join(root, 'tauri-app/package.json'))('esbuild');
    const icon = path.join(upstream, 'packages/client/ui-primitives/src/icons/index.tsx');
    const harness = await build({
      stdin: {
        contents: `
          import * as React from 'react';
          import * as runtime from 'react/jsx-runtime';
          import * as ReactDOM from 'react-dom';
          import { createRoot } from 'react-dom/client';
          import { IconCloseOutline16 } from ${JSON.stringify(icon)};
          const modules = {react: React, 'react/jsx-runtime': runtime, 'react-dom': ReactDOM,
            '@deepseek-ai/dsh-client-ui-primitives': {IconCloseOutline16}};
          window.__ModuleLoader__ = {load({id, factory}) {
            if (id !== 'dsh-aio-ui-compat') throw Error(id);
            window.api = factory(id => {
              if (!Object.hasOwn(modules, id)) throw Error('Unexpected module: ' + id);
              return modules[id];
            });
          }};
          window.React = React;
          window.root = createRoot(document.getElementById('root'));
          window.render = (component, props) => ReactDOM.flushSync(() =>
            window.root.render(React.createElement(window.api[component], props)));
          window.cleanups = [];
          window.enable = () => window.api.apply({effect: fn => window.cleanups.push(fn())});
        `,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
      nodePaths: [path.join(root, 'node_modules')],
      write: false,
    });
    const { chromium } = require(playwright);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<div id="root" style="font-size:18px;line-height:26px"></div>');
      await page.addScriptTag({ content: harness.outputFiles[0].text });
      await page.addScriptTag({ content: asset });
      await page.evaluate(() => { window.enable(); window.enable(); });
      assert.equal(await page.locator('style[data-plugin="dsh-aio-ui-compat"]').count(), 1);
      const text = '<img src=x onerror=alert(1)>\n**literal** & <b>raw</b>\n  indented';
      await page.evaluate(text => window.render('MessageText', { text }), text);
      assert.equal(await page.locator('#root > div').textContent(), text);
      assert.equal(await page.locator('#root > div *').count(), 0);
      assert.deepEqual(await page.locator('#root > div').evaluate(element => {
        const css = getComputedStyle(element);
        return [css.whiteSpace, css.wordBreak, css.fontSize, css.lineHeight];
      }), ['pre-wrap', 'break-word', '18px', '26px']);

      await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 80; canvas.height = 40;
        canvas.getContext('2d').fillRect(0, 0, 80, 40);
        window.imageURL = canvas.toDataURL();
        window.attachment = { attachmentId: 'legacy-image', mediaType: 'image/png',
          bytes: 100, width: 80, height: 40, name: 'Old image' };
        window.labels = { image: 'Image', open: 'Open image', openNamed: name => `Open ${name}`,
          loading: 'Loading', loadFailed: 'Retry', lightbox: { dialog: 'Preview', close: 'Close' } };
        window.calls = [];
        window.load = attachment => {
          window.calls.push(attachment);
          return new Promise(resolve => { window.resolveImage = resolve; });
        };
        window.gallery = { images: [{ attachment: window.attachment }], load: window.load,
          align: 'end', labels: window.labels };
        window.render('ImageGallery', window.gallery);
      });
      assert.equal(await page.locator('#root').textContent(), 'Loading');
      assert.equal(await page.locator('#root [data-align]').getAttribute('data-align'), 'end');
      assert.equal(await page.evaluate(() => window.calls[0] === window.attachment), true);
      await page.evaluate(() => window.resolveImage(window.imageURL));
      await page.waitForFunction(() => document.querySelector('#root img')?.naturalWidth === 80);
      assert.equal(await page.locator('#root img').getAttribute('alt'), 'Old image');
      assert.equal(await page.locator('#root button').getAttribute('data-variant'), 'single');
      assert.deepEqual(await page.locator('#root button').evaluate(el => [el.style.width, el.style.height]),
        ['80px', '40px']);
      await page.getByRole('button', { name: 'Open Old image', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Preview' });
      await dialog.waitFor();
      assert.equal(await dialog.evaluate(el => el.parentElement === document.body), true);
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).evaluate(el =>
        el === document.activeElement && el.querySelector('svg') !== null), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: 'Open Old image', exact: true })
        .evaluate(el => el === document.activeElement), true);
      for (const dismissal of ['close', 'backdrop']) {
        await page.getByRole('button', { name: 'Open Old image', exact: true }).click();
        if (dismissal === 'close') await page.getByRole('button', { name: 'Close', exact: true }).click();
        else await page.locator('[role=dialog] [aria-hidden=true]').click({ position: { x: 5, y: 5 } });
        await dialog.waitFor({ state: 'detached' });
      }
      for (const width of [390, 1200]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(() => window.render('ImageGallery', {
          ...window.gallery, align: 'start', compact: true,
        }));
        assert.deepEqual(await page.locator('#root button').evaluate(el => {
          const rect = el.getBoundingClientRect();
          return [rect.width, rect.height];
        }), [64, 64]);
      }
      await page.evaluate(() => window.render('ImageGallery', {
        ...window.gallery, images: [window.gallery.images[0], window.gallery.images[0]],
      }));
      assert.equal(await page.locator('#root [data-variant=tile]').count(), 2);

      await page.evaluate(() => {
        window.previewCalls = 0;
        window.render('ImageGallery', {
          ...window.gallery,
          images: [{ preview: { url: window.imageURL, width: 800, height: 100, name: 'Local' } }],
          load: () => { window.previewCalls++; throw Error('Preview must not load'); },
        });
      });
      await page.waitForFunction(() => document.querySelector('#root img')?.naturalWidth === 80);
      assert.equal(await page.evaluate(() => window.previewCalls), 0);
      assert.deepEqual(await page.locator('#root button').evaluate(el => [el.style.width, el.style.height]),
        ['240px', '60px']);
      assert.equal(await page.locator('#root img').evaluate(el => el.style.objectPosition), 'left center');
      await page.evaluate(() => {
        window.cachedLoad = Object.assign(() => new Promise(() => {}), { peek: () => window.imageURL });
        window.render('ImageGallery', { ...window.gallery, load: window.cachedLoad });
      });
      assert.equal(await page.locator('#root img').count(), 1);
      assert.equal(await page.locator('#root').textContent(), '');

      await page.evaluate(() => {
        window.attempts = 0;
        window.render('ImageGallery', { ...window.gallery, load: () =>
          ++window.attempts === 1 ? Promise.reject(Error('offline')) : Promise.resolve(window.imageURL) });
      });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#root img')?.naturalWidth === 80);
      assert.equal(await page.evaluate(() => window.attempts), 2);
      await page.evaluate(() => {
        window.render('ImageGallery', { ...window.gallery, load: () =>
          new Promise(resolve => { window.resolveStale = resolve; }) });
        window.render('ImageGallery', { ...window.gallery,
          images: [{ preview: { url: window.imageURL, name: 'Replacement' } }] });
        window.resolveStale('stale-invalid-url');
      });
      assert.equal(await page.locator('#root img').getAttribute('alt'), 'Replacement');
      assert.equal(await page.locator('#root img').getAttribute('src'), await page.evaluate(() => window.imageURL));
      await page.evaluate(() => window.render('ImageGallery', { ...window.gallery, images: [] }));
      assert.equal(await page.locator('#root > *').count(), 0);
      await page.evaluate(() => window.cleanups[0]());
      assert.equal(await page.locator('style[data-plugin="dsh-aio-ui-compat"]').count(), 1);
      await page.evaluate(() => { window.cleanups[0](); window.cleanups[1](); });
      assert.equal(await page.locator('style[data-plugin="dsh-aio-ui-compat"]').count(), 0);
      await page.evaluate(() => window.enable());
      assert.equal(await page.locator('style[data-plugin="dsh-aio-ui-compat"]').count(), 1);
      await page.evaluate(() => { window.root.unmount(); window.cleanups[2](); });
      assert.equal(await page.locator('style[data-plugin="dsh-aio-ui-compat"]').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
