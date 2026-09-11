'use strict';

// dsh-aio-sound 内置插件的行为测试：host 契约、音效清单、配置校验与事件监听。
// 全部用注入的 ctx 与假的 req/res 隔离；不 spawn PowerShell（播放成功路径靠
// 「找不到音效」的日志分支间接断言，真实发声由打包后的手动验证覆盖）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const pluginFile = fileURLToPath(new URL('../assets/plugins/dsh-aio-sound/lib/index.js', import.meta.url));
let caseNo = 0;

/** 每个用例拿到独立模块实例：插件内部有 ctxRef/scope 单例状态。 */
async function pluginModule() {
  caseNo += 1;
  return import(pathToFileURL(pluginFile).href + '?case=' + caseNo);
}

function settingsStub() {
  const store = new Map();
  return {
    store,
    register(namespace) {
      return {
        get: () => store.get(namespace),
        update: async (next) => { store.set(namespace, JSON.parse(JSON.stringify(next))); },
      };
    },
  };
}

function makeCtx(settings) {
  const routes = new Map();
  const events = new Map();
  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec);
        return () => routes.delete(spec.path);
      },
    },
    on(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    get(name) {
      return name === 'settings' ? settings : undefined;
    },
  };
  return { ctx, routes, events, disposers };
}

function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(text) { res.body = text === undefined ? '' : String(text); },
  };
  return res;
}

async function call(route, method, body) {
  const res = makeRes();
  await route.handler(makeReq(method, body), res);
  return { status: res.statusCode, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
}

/** 采集 console.log，用于断言「事件确实触发了播放尝试」。 */
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (message) => { lines.push(String(message)); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('host 契约：注册音效路由与会话完成监听', async () => {
  const mod = await pluginModule();
  assert.equal(mod.name, 'dsh-aio-sound');
  assert.deepEqual(mod.inject, ['webServer']);
  const { ctx, routes, events, disposers } = makeCtx(settingsStub());
  mod.apply(ctx);
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/aio-sound/config',
    '/api/aio-sound/preview',
    '/api/aio-sound/state',
  ]);
  assert.ok(events.has('session/event'));
  assert.ok(events.has('user-questions/request'));
  for (const dispose of disposers) dispose();
  assert.equal(routes.size, 0);
});

test('state 路由返回内置音效清单与默认配置', async () => {
  const mod = await pluginModule();
  const { ctx, routes } = makeCtx(settingsStub());
  mod.apply(ctx);
  const state = await call(routes.get('/api/aio-sound/state'), 'GET');
  assert.equal(state.status, 200);
  assert.equal(state.headers['Cache-Control'], 'no-store');
  assert.deepEqual(state.json.config, { enabled: true, volume: 100, sound: 'task-done.wav', customDir: '' });
  assert.equal(state.json.customDirIsDefault, true);
  const files = state.json.sounds.filter((row) => row.source === 'builtin').map((row) => row.file);
  assert.deepEqual(files, ['bell.wav', 'chime-bright.wav', 'chime-soft.wav', 'drop.wav', 'pulse.wav', 'task-done.wav']);
  assert.equal(state.json.sounds.find((row) => row.file === 'task-done.wav').label, '默认（当前音效）');
});

test('config 路由校验音量、音效名与开关类型', async () => {
  const mod = await pluginModule();
  const settings = settingsStub();
  const { ctx, routes } = makeCtx(settings);
  mod.apply(ctx);
  const route = routes.get('/api/aio-sound/config');
  assert.equal((await call(route, 'GET')).status, 405);
  assert.equal((await call(route, 'POST', { volume: 101 })).status, 400);
  assert.equal((await call(route, 'POST', { volume: -1 })).status, 400);
  assert.equal((await call(route, 'POST', { volume: 'loud' })).status, 400);
  assert.equal((await call(route, 'POST', { sound: '../evil.wav' })).status, 400);
  assert.equal((await call(route, 'POST', { sound: 'sub/dir.wav' })).status, 400);
  assert.equal((await call(route, 'POST', { enabled: 'yes' })).status, 400);
  assert.equal((await call(route, 'POST', { customDir: 7 })).status, 400);
  const ok = await call(route, 'POST', { enabled: false, volume: 42.6, sound: 'bell.wav', customDir: ' C:\sounds ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.config, { enabled: false, volume: 43, sound: 'bell.wav', customDir: 'C:\sounds' });
  const state = await call(routes.get('/api/aio-sound/state'), 'GET');
  assert.equal(state.json.customDirIsDefault, false);
  assert.equal(state.json.config.enabled, false);
});

test('自定义目录里的 wav 进入清单，未知音效试听返回 404', async (t) => {
  const mod = await pluginModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'custom-a.wav'), 'RIFF');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'nope');
  const { ctx, routes } = makeCtx(settingsStub());
  mod.apply(ctx);
  await call(routes.get('/api/aio-sound/config'), 'POST', { customDir: dir });
  const state = await call(routes.get('/api/aio-sound/state'), 'GET');
  const custom = state.json.sounds.filter((row) => row.source === 'custom').map((row) => row.file);
  assert.deepEqual(custom, ['custom-a.wav']);
  const preview = await call(routes.get('/api/aio-sound/preview'), 'POST', { sound: 'missing.wav' });
  assert.equal(preview.status, 404);
  assert.match(preview.json.error, /找不到音效文件/);
  assert.equal((await call(routes.get('/api/aio-sound/preview'), 'GET')).status, 405);
});

test('会话完成事件触发播放尝试，关闭开关后不再尝试', async () => {
  const mod = await pluginModule();
  const { ctx, routes, events } = makeCtx(settingsStub());
  mod.apply(ctx);
  await call(routes.get('/api/aio-sound/config'), 'POST', { sound: 'missing.wav' });
  const sessionEvents = events.get('session/event');
  const logs = await captureLogs(async () => {
    for (const handler of sessionEvents) handler({ id: 's1' }, { type: 'turn/end' });
    for (const handler of sessionEvents) handler({ id: 's1' }, { type: 'approval/asked' });
    for (const handler of events.get('user-questions/request')) handler({ agent: 'a' });
    for (const handler of sessionEvents) handler({ id: 's1' }, { type: 'user/message' });
  });
  const attempts = logs.filter((line) => line.includes('play failed'));
  assert.equal(attempts.length, 3, JSON.stringify(logs));
  assert.ok(attempts.every((line) => line.includes('missing.wav')));

  await call(routes.get('/api/aio-sound/config'), 'POST', { enabled: false });
  const off = await captureLogs(async () => {
    for (const handler of sessionEvents) handler({ id: 's1' }, { type: 'turn/end' });
  });
  assert.equal(off.filter((line) => line.includes('play failed')).length, 0);
});

test('内置插件已注册进 desktop-core 伴随清单且包内容齐全', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const { createDesktopCore } = require('../sidecar/dist/desktop-core.js');
  const registry = createDesktopCore({
    appRoot: repo, userDataDir: '', logsDir: '', dshHome: '',
    nodeExe() { throw new Error('inventory only'); }, npmCli() { throw new Error('inventory only'); },
  });
  const entry = registry.COMPANION_PLUGINS.find((p) => p.name === 'dsh-aio-sound');
  assert.ok(entry, 'companion entry present');
  assert.equal(entry.dir, 'dsh-aio-sound');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'assets/plugins/dsh-aio-sound/package.json'), 'utf8'));
  assert.equal(pkg.name, entry.name);
  assert.equal(pkg.main, 'lib/index.js');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-slots']);
  for (const file of ['lib/index.js', 'lib/client.js', 'assets/play-sound.ps1', 'assets/sounds/task-done.wav', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(repo, 'assets/plugins/dsh-aio-sound', file)), file + ' present');
  }
});
