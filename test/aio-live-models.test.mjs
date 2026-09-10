'use strict';

// DeepSeek 实时模型发现内置插件的行为测试。全部通过注入的 ctx 与 stub 的
// global.fetch 隔离，不访问真实网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../', import.meta.url));
const pluginFile = fileURLToPath(new URL('../assets/plugins/dsh-aio-live-models/lib/index.js', import.meta.url));

async function pluginModule() {
  return import(pathToFileURL(pluginFile).href);
}

function registryWith({ settings = {}, credentialValue } = {}) {
  const discoveries = new Map();
  const resolves = [];
  const ctx = {
    llm: {
      registerModelDiscovery(ns, discover) {
        assert.ok(!discoveries.has(ns), 'a discovery is registered once');
        discoveries.set(ns, discover);
        return () => discoveries.delete(ns);
      },
    },
    get(name) {
      if (name === 'settings') return { get: (ns) => (ns === 'llm-deepseek' ? settings : undefined) };
      if (name === 'credentials') {
        return { resolve: async (ref) => { resolves.push(ref); return credentialValue === undefined ? undefined : { value: credentialValue }; } };
      }
      return undefined;
    },
  };
  return { ctx, discoveries, resolves };
}

async function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  try { return { result: await fn(calls), calls }; } finally { global.fetch = original; }
}

const ok = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

test('插件导出 host 契约并注册 llm-deepseek 发现', async () => {
  const mod = await pluginModule();
  assert.equal(mod.name, 'dsh-aio-live-models');
  assert.deepEqual(mod.inject, ['llm']);
  const { ctx, discoveries } = registryWith({});
  mod.apply(ctx);
  assert.ok(discoveries.has('llm-deepseek'));
});

test('发现请求 provider /models 并映射、去重、补 256k 默认', async () => {
  const mod = await pluginModule();
  const { ctx, discoveries } = registryWith({ settings: { baseURL: 'https://api.deepseek.com/', apiKeyEnv: 'DEEPSEEK_API_KEY' }, credentialValue: 'cred-from-store' });
  mod.apply(ctx);
  const discover = discoveries.get('llm-deepseek');
  const { result, calls } = await withFetch(() => ok({ object: 'list', data: [
    { id: 'deepseek-v4-pro', object: 'model' },
    { id: 'deepseek-v4-pro' },
    { id: 'deepseek-v5', name: 'DeepSeek V5', max_tokens: 8192 },
  ] }), async () => discover({}));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(calls[0].init.headers.authorization, 'Bearer cred-from-store');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.deepEqual(result, [
    { id: 'deepseek-v4-pro', contextWindow: 262144 },
    { id: 'deepseek-v5', contextWindow: 262144, name: 'DeepSeek V5', maxTokens: 8192 },
  ]);
});

test('baseURL 优先级：请求 > 设置 > 默认；请求 apiKey 优先于凭据库', async () => {
  const mod = await pluginModule();
  const { ctx, discoveries, resolves } = registryWith({ settings: {}, credentialValue: 'store-key' });
  mod.apply(ctx);
  const discover = discoveries.get('llm-deepseek');
  const direct = await withFetch(() => ok({ data: [{ id: 'x' }] }), async () => discover({ baseURL: 'https://relay.example/v1/', apiKey: 'request-key' }));
  assert.equal(direct.calls[0].url, 'https://relay.example/v1/models');
  assert.equal(direct.calls[0].init.headers.authorization, 'Bearer request-key');
  assert.equal(resolves.length, 0, '请求自带 key 时不读凭据库');
  const fallback = await withFetch(() => ok({ data: [{ id: 'x' }] }), async () => discover({}));
  assert.equal(fallback.calls[0].url, 'https://api.deepseek.com/models', '缺省回退官方端点');
});

test('发现失败以可读错误上抛，不做静态回退', async () => {
  const mod = await pluginModule();
  const { ctx, discoveries } = registryWith({});
  mod.apply(ctx);
  const discover = discoveries.get('llm-deepseek');
  await assert.rejects(() => withFetch(() => ({ ok: false, status: 401, text: async () => '' }), async () => discover({})),
    /HTTP 401[\s\S]*API Key/);
  await assert.rejects(() => withFetch(() => ok({ data: [] }), async () => discover({})), /未返回任何模型/);
  await assert.rejects(() => withFetch(() => { throw new Error('offline'); }, async () => discover({})), /无法连接/);
});

test('内置插件已注册进 desktop-core 伴随清单且包内容齐全', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { createDesktopCore } = require('../sidecar/dist/desktop-core.js');
  const registry = createDesktopCore({
    appRoot: repo, userDataDir: '', logsDir: '', dshHome: '',
    nodeExe() { throw new Error('inventory only'); }, npmCli() { throw new Error('inventory only'); },
  });
  const entry = registry.COMPANION_PLUGINS.find((p) => p.name === 'dsh-aio-live-models');
  assert.ok(entry, 'companion entry present');
  assert.equal(entry.dir, 'dsh-aio-live-models');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'assets/plugins/dsh-aio-live-models/package.json'), 'utf8'));
  assert.equal(pkg.name, entry.name);
  assert.equal(pkg.dsh.runtime, 'host');
  assert.equal(pkg.main, 'lib/index.js');
});
