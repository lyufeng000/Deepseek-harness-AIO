import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { Context, Service } from '@deepseek-ai/cordis';
import { renderToStaticMarkup } from 'react-dom/server';
import { migrateWebuiPromptOptimize } from '../scripts/webui-prompt-optimize-compat.mjs';

const require = createRequire(import.meta.url);
const seed = process.env.DSH_PUBLIC_R6 ||
  'H:/CODEX/build-inputs/aio-1.2.0-public-seed-20260908-r6';
const modules = path.join(seed, 'profiles/web-desktop/node_modules');

// Entire published factories/apply functions and real Cordis registries run.
// DOM roots/timers and remote transport are inert: this is not a browser test.
for (const mode of ['original', 'locale-only', 'without-remote-capability', 'repaired']) test(
  `full r6 WebUI with official ui-skill: ${mode}`, async () => {
  const callbacks = [];
  const elements = new Map();
  const element = () => ({
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(child) { if (child.id) elements.set(child.id, child); return child; },
    append() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  });
  const document = {
    compatMode: 'CSS1Compat',
    head: element(), body: element(), documentElement: element(),
    createElement: element, createElementNS: element,
    getElementById: id => elements.get(id) ?? null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const flags = require('js-yaml').load(fs.readFileSync(path.join(seed, 'settings.yaml'), 'utf8'))['webui-modules'];
  storage.set('dsh-webui.modules', JSON.stringify(flags));
  const noopObserver = class { observe() {} disconnect() {} };
  const warnings = [];
  let registered;
  const sandbox = vm.createContext({
    console: { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) },
    document, localStorage, navigator: { userAgent: 'node audit', platform: 'Win32', language: 'en-US' },
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1' },
    URL, URLSearchParams, AbortController, TextDecoder, TextEncoder,
    MutationObserver: noopObserver, ResizeObserver: noopObserver,
    HTMLElement: class {}, HTMLTextAreaElement: class {},
    requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
    cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    fetch: async url => {
      assert.equal(url, '/api/webui-modules');
      return { ok: true, json: async () => ({ ok: true, modules: flags }) };
    },
  });
  sandbox.window = { document, localStorage, navigator: sandbox.navigator, location: sandbox.location,
    innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: sandbox.setTimeout, clearTimeout() {}, setInterval: sandbox.setInterval, clearInterval() {},
    __ModuleLoader__: { load(value) { registered = value; } },
  };
  const cache = new Map();
  function load(id) {
    if (cache.has(id)) return cache.get(id);
    if (['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots'].includes(id)) return require(id);
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
    const client = path.join(modules, id.replace(/\/client$/, ''), 'lib/client.js');
    if (!fs.existsSync(client)) {
      const entry = path.join(modules, id, 'lib/index.js');
      if (!fs.existsSync(entry)) return require(id);
      const built = require('../tauri-app/node_modules/esbuild').buildSync({
        entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'browser',
        external: ['react', 'react-dom', '@deepseek-ai/cordis'],
        loader: { '.css': 'empty', '.module.css': 'empty' }, logLevel: 'silent',
      }).outputFiles[0].text;
      const module = { exports: {} };
      vm.runInContext(`(function(require,module,exports){${built}\n})`, sandbox)(load, module, module.exports);
      cache.set(id, module.exports);
      return module.exports;
    }
    let source = fs.readFileSync(client, 'utf8').replace(/\r\n/g, '\n');
    if (id === '@dsh-external/dsh-webui') {
      if (mode === 'repaired' || mode === 'without-remote-capability') {
        source = migrateWebuiPromptOptimize(source);
        if (mode === 'without-remote-capability') source = source.replace(
          '"modelDirectories",\n\t\t\t\t"remote.session",\n\t\t\t\t"sessions"',
          '"modelDirectories",\n\t\t\t\t"sessions"');
      }
      if (mode === 'locale-only') source = source.replace('NS$1 = "skill";', 'NS$1 = "webui.skill";');
    }
    vm.runInContext(source, sandbox, { filename: client });
    const factory = registered.factory;
    const exports = factory(load);
    cache.set(id, exports);
    return exports;
  }
  const webui = load('@dsh-external/dsh-webui');
  const ctx = new Context();
  try {
    await ctx.plugin(load('@deepseek-ai/dsh-client-ui-renderer').SlotRegistry);
    // An independently declared real slot ledger, without rendering a browser.
    ctx.slots.register({ name: 'root', children: {
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'global' },
      'settings.plugin.item': { kind: 'keyed', scope: 'global' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    } }, () => null);
    class Remote extends Service {
      constructor(context) { super(context, 'remote'); }
      $on() { return () => {}; }
    }
    new Remote(ctx);
    const scope = load('@deepseek-ai/dsh-api-session-controller').createScope(ctx, 'regular-test');
    const projected = load('@deepseek-ai/dsh-client-store').createSnapshotStore({ lastUsed: null, next: null });
    const sessionRemote = {
      modelCatalog: async () => ({ ok: true, value: {
        default: { provider: 'local', model: 'keyless' }, routableProviders: ['local'],
        groups: [{ id: 'local', name: 'Local', models: [{ id: 'keyless', name: 'Keyless' }] }], failures: [],
      } }),
    };
    // A sibling owner is essential: root.provide would grant this capability
    // through ancestor inheritance and conceal the native access failure.
    const remoteOwner = ctx.plugin({ name: 'test-session-remote', apply(owner) {
      owner.provide('remote.session', sessionRemote);
    } });
    await remoteOwner;
    const services = {
      settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) },
      connection: { rpc: { call: async () => ({}) } },
      uiConversation: { events: { register: () => () => {} } },
      locale: new (load('@deepseek-ai/dsh-client-locale').LocaleRuntime)(ctx),
      sessions: { subagentAddress: () => undefined,
        scope: () => scope.ctx,
        binding: () => ({ session: { projections: { faceOf: () => projected } }, ctx: scope.ctx }),
        list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, order: [], current: null }) } },
      workspaces: { store: { subscribe: () => () => {}, getSnapshot: () => ({}) } },
      layout: {}, theme: {},
    };
    for (const [name, value] of Object.entries(services)) {
      ctx.provide(name, value);
    }
    ctx.provide('remote.skills', { list: async () => ({ ok: true, value: { skills: [] } }) });
    await ctx.plugin(load('@deepseek-ai/dsh-client-ui-input-trigger').InputTriggerService);
    await ctx.plugin(load('@deepseek-ai/dsh-client-ui-skill'));
    if (mode === 'original' || mode === 'locale-only') {
      const expected = mode === 'original' ? /locale namespace "skill" already has locale "zh"/
        : /keyed slot "tool.call.toolview" already has an entry for key "skill"/;
      await assert.rejects(async () => { await ctx.plugin(webui); }, expected);
      assert.ok(!ctx.slots.entriesOfSlot('conversation.input.right')
        .some(entry => entry.options.id === 'webui-prompt-optimize'));
      return;
    }
    await ctx.plugin(webui);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!ctx.slots.entriesOfSlot('conversation.input.right')
      .some(entry => entry.options.id === 'webui-prompt-optimize'));
    // Prove real deferred Cordis injection, not a callback-forcing mock.
    await ctx.plugin(load('@deepseek-ai/dsh-client-ui-model-selection').ModelDirectoryResolver,
      { blockReason: () => 'Select model' });
    await new Promise(resolve => setImmediate(resolve));
    const optimizer = ctx.slots.entriesOfSlot('conversation.input.right')
      .find(entry => entry.options.id === 'webui-prompt-optimize');
    assert.ok(optimizer);
    if (mode === 'without-remote-capability') {
      assert.throws(() => optimizer.inject('regular-test'),
        /cannot get property "remote.session" without inject/);
      return;
    }
    const face = optimizer.inject('regular-test');
    assert.equal(face.directory.getSnapshot().current.model, 'keyless');
    const html = renderToStaticMarkup(require('react').createElement(optimizer.component, {
      ...face, useInput: select => select({ draft: '', phase: 'plain' }),
      inputActions: { setDraft() {}, submit() {} },
    }));
    assert.match(html, /webui-po-trigger/);
    assert.equal(ctx.slots.entriesOfSlot('tool.call.toolview')
      .find(entry => entry.options.key === 'skill').options.priority, -100);
    assert.ok(warnings.some(text => text.includes('slash source "/skill" is already registered')),
      'WebUI contains its slash collision and retains the official slash source');
    await remoteOwner.dispose();
    await new Promise(resolve => setImmediate(resolve));
    const remaining = ctx.slots.entriesOfSlot('conversation.input.right').map(entry => entry.options.id);
    assert.ok(!remaining.includes('webui-prompt-optimize'), 'capability loss releases dependent slot');
    assert.ok(remaining.includes('webui-continue-btn'), 'dependent-scope disposal does not tear down WebUI');
  } finally { await ctx.fiber.dispose(); }
});
