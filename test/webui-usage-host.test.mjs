import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { zipSync, strToU8 } from 'fflate';
import { installWebuiUsageHost } from '../scripts/webui-usage-host-compat.mjs';
import { removeBounded } from '../assets/webui-host/usage/filesystem.mjs';
import { commitSkill, deleteSkill } from '../assets/webui-host/usage/skills-host.mjs';
import { queryDeepseekBilling } from '../assets/webui-host/usage/deepseek-billing.mjs';
import { createUsageState, applyUsageDelta } from '../assets/webui-host/usage/usage.mjs';
import { unzipArchive } from '../assets/webui-host/usage/archive.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const publicWebui = resolve(repo, '../build-inputs/aio-1.2.0-public-seed-20260908-r6',
  'profiles/web-desktop/node_modules/@dsh-external/dsh-webui');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const base64 = text => Buffer.from(text).toString('base64');
const skillText = name => `---\nname: ${name}\ndescription: Public test fixture\n---\nBody\n`;

async function fixture(t, base = tmpdir()) {
  const directory = await fs.mkdtemp(join(base, 'webui-usage-'));
  t.after(() => removeBounded(base, directory));
  return directory;
}

async function packageFixture(t) {
  // Under test/ so normal module resolution reaches installed public dependencies.
  const root = await fixture(t, join(repo, 'test'));
  await fs.mkdir(join(root, 'lib'));
  for (const name of ['package.json', 'lib/usage-host.js']) {
    await fs.copyFile(join(publicWebui, name), join(root, name));
  }
  return root;
}

function dispatch(routes, url, method = 'GET', body, headers = {}, peer = '127.0.0.1') {
  const pathname = new URL(url, 'http://localhost').pathname;
  const route = routes.get(pathname) ?? [...routes.values()]
    .find(route => route.kind === 'prefix' && pathname.startsWith(route.path));
  assert.ok(route, `registered route for ${url}`);
  return new Promise((done, reject) => {
    const req = new PassThrough();
    Object.assign(req, { url, method, headers: { host: 'localhost', ...headers },
      socket: { remoteAddress: peer } });
    const timer = setTimeout(() => reject(new Error(`Route did not complete: ${url}`)), 4000);
    let status = 200;
    const res = {
      writeHead(code) { status = code; },
      end(text) {
        clearTimeout(timer);
        try { done({ status, body: JSON.parse(String(text)) }); } catch (error) { reject(error); }
      },
    };
    Promise.resolve(route.handler(req, res)).catch(error => { clearTimeout(timer); reject(error); });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function usageStream(inputTokens, outputTokens = 2) {
  return [{ type: 'chunk', time: Date.now(), chunk: {
    type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 1 },
  } }];
}

function appendUsage(session, input = 10, step = 1) {
  session.append('step/start', { turn: 1, step });
  session.append('assistant/message', {
    turn: 1, step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Synthetic answer' }],
      source: { provider: 'fixture', model: 'offline' },
    }),
    stream: usageStream(input),
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step });
}

test('installer accepts actual r6 wrapper, verifies payload, rejects drift and is idempotent', async t => {
  const publicBefore = await fs.readFile(join(publicWebui, 'lib/usage-host.js'));
  const root = await packageFixture(t);
  const original = await fs.readFile(join(root, 'lib/usage-host.js'));
  const result = await installWebuiUsageHost(root);
  assert.equal(result.changed, true);
  assert.equal(result.files.length, 11);
  assert.equal((await installWebuiUsageHost(root)).changed, false);
  assert.match(await fs.readFile(join(result.directory, 'LICENSE'), 'utf8'), /MIT License/);
  const provenance = JSON.parse(await fs.readFile(join(result.directory, 'PROVENANCE.json')));
  assert.equal(provenance.upstream.version, '0.3.0');
  assert.ok(result.files.every(name => !/client|package\.json|cordis/.test(name)));
  const module = await import(pathToFileURL(join(root, 'lib/usage-host.js')));
  assert.equal(typeof module.applyUsageHost, 'function');
  assert.deepEqual(Object.keys(module), ['applyUsageHost']);
  const host = join(result.directory, 'index.mjs');
  await fs.appendFile(host, '\n// drift\n');
  await assert.rejects(installWebuiUsageHost(root), /Installed usage host changed/);
  const second = await packageFixture(t);
  await fs.writeFile(join(second, 'lib/usage-host.js'), Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(installWebuiUsageHost(second), /Unrecognized/);
  assert.equal((await fs.readdir(join(second, 'lib'))).length, 1);
  const manifestPath = join(second, 'package.json');
  const pkg = JSON.parse(await fs.readFile(manifestPath));
  pkg.version = '0.5.2';
  await fs.writeFile(manifestPath, JSON.stringify(pkg));
  await assert.rejects(installWebuiUsageHost(second), /Unsupported WebUI/);
  assert.ok(publicBefore.equals(await fs.readFile(join(publicWebui, 'lib/usage-host.js'))));
});

test('installer rolls back generated directory when wrapper publication fails', async t => {
  const root = await packageFixture(t);
  const target = join(root, 'lib/usage-host.js');
  const original = await fs.readFile(target);
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (resolve(to) === resolve(target)) throw new Error('injected wrapper publication failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(installWebuiUsageHost(root), /injected wrapper/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(original.equals(await fs.readFile(target)));
  assert.deepEqual(await fs.readdir(join(root, 'lib')), ['usage-host.js']);
  assert.equal((await installWebuiUsageHost(root)).changed, true);
});

test('installer refuses unreviewed kernel version before any payload writes', async t => {
  const root = await packageFixture(t);
  const kernel = join(root, 'node_modules/@deepseek-ai/dsh-session');
  await fs.mkdir(kernel, { recursive: true });
  await fs.writeFile(join(kernel, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-session', version: '0.1.4', main: 'index.js',
  }));
  await fs.writeFile(join(kernel, 'index.js'), '');
  await assert.rejects(installWebuiUsageHost(root), /Unsupported kernel dependency/);
  assert.deepEqual(await fs.readdir(join(root, 'lib')), ['usage-host.js']);
});

test('migrated host routes run against real current Sessions and JSONL storage, offline', async t => {
  const home = await fixture(t);
  const env = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  process.env.DSH_HOME = join(home, 'dsh');
  process.env.DSH_AGENTS_HOME = join(home, 'agents');
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const root = await packageFixture(t);
  await installWebuiUsageHost(root);
  const { applyUsageHost } = await import(pathToFileURL(join(root, 'lib/usage-host.js')));
  const host = await import(pathToFileURL(join(root, 'lib/aio-usage-host/index.mjs')));
  const ctx = new Context();
  const routes = new Map();
  const values = new Map();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' });
  ctx.provide('webServer', { register(route) {
    assert.ok(!routes.has(route.path));
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  } });
  ctx.provide('settings', { get(namespace) {
    return namespace === 'llm-pi-ai' ? { providers: {
      openrouter: { displayName: 'Fixture router', apiKeyEnv: 'FIXTURE_ROUTER_KEY',
        baseURL: 'https://openrouter.ai' },
    } } : undefined;
  } });
  ctx.provide('credentials', {
    resolve: async key => values.has(key) ? { value: values.get(key) } : undefined,
    set: async (key, value) => values.set(key, value),
  });
  const fetchCalls = [];
  await ctx.plugin(async child => applyUsageHost(child, {}, {
    disableBackgroundRefresh: true,
    accountDeps: {
      homedir: () => home,
      readFile: async file => {
        assert.ok(resolve(file).startsWith(resolve(home) + sep));
        throw Object.assign(new Error('No fixture auth'), { code: 'ENOENT' });
      },
      fetch: async url => {
        fetchCalls.push(String(url));
        if (String(url) === 'https://api.z.ai/api/monitor/usage/quota/limit') {
          return Response.json({ data: { limits: [
            { type: 'TOKENS_LIMIT', percentage: 25, unit: 3, number: 5 },
            { type: 'TOKENS_LIMIT', percentage: 50, unit: 6, number: 1 },
          ] } });
        }
        if (String(url) === 'https://api.z.ai/api/biz/subscription/list') {
          return Response.json({ data: [{ plan_name: 'fixture' }] });
        }
        assert.equal(String(url), 'https://api.deepseek.com/user/balance');
        return new Response(JSON.stringify({ is_available: true, balance_infos: [
          { currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10' },
        ] }), { status: 200 });
      },
    },
  }));
  assert.equal(routes.size, 11, '10 exact usage routes and skill prefix');

  await t.test('all usage/account routes, balance response, provider discovery and credential writes', async () => {
    const providers = await dispatch(routes, '/api/usage-stats/providers');
    assert.equal(providers.status, 200);
    assert.ok(providers.body.providers.some(entry => entry.id === 'openrouter'));
    assert.equal((await dispatch(routes, '/api/usage-stats/balance')).body.error, 'no-credential');
    assert.equal((await dispatch(routes, '/api/usage-stats/account?provider=absent')).body.error, 'unknown-provider');
    assert.equal((await dispatch(routes, '/api/usage-stats/subscriptions')).status, 200);
    assert.equal((await dispatch(routes, '/api/usage-stats/deepseek-billing')).body.configured, false);
    assert.equal(fetchCalls.length, 0, 'unconfigured providers never fetch');
    values.set('DEEPSEEK_API_KEY', 'synthetic-fixture-key');
    const account = await dispatch(routes, '/api/usage-stats/account?provider=deepseek-official&refresh=1');
    assert.equal(account.body.account.status, 'ok');
    const balance = await dispatch(routes, '/api/usage-stats/balance?provider=deepseek-official');
    assert.equal(Number(balance.body.balance.total), 12.5);
    assert.equal(fetchCalls.length, 1, 'balance consumes actual account cache');
    values.set('ZAI_API_KEY', 'synthetic-zai-key');
    assert.equal((await dispatch(routes, '/api/usage-stats/account?provider=zai&refresh=1')).body.account.status, 'ok');
    const subscriptions = await dispatch(routes, '/api/usage-stats/subscriptions');
    assert.deepEqual(subscriptions.body.subscriptions.find(account => account.id === 'zai')
      .windows.map(window => window.usedPercent), [25, 50]);
    values.set('DEEPSEEK_USER_TOKEN', 'synthetic-billing-token');
    const billingFetch = t.mock.method(globalThis, 'fetch', async url => {
      assert.ok(String(url).startsWith('https://platform.deepseek.com/api/v0/usage/export?'));
      return new Response(zipSync({
        'cost-fixture.csv': strToU8('user_id,utc_date,model,wallet_type,cost,currency\nu,d,fixture,paid,2.50,CNY'),
      }));
    });
    try {
      const billing = await dispatch(routes, '/api/usage-stats/deepseek-billing?months=1');
      assert.equal(billing.body.months[0].totalCost, 2.5);
      assert.doesNotMatch(JSON.stringify(billing), /synthetic-billing-token/);
    } finally {
      billingFetch.mock.restore();
      values.delete('DEEPSEEK_USER_TOKEN');
    }
    const credential = await dispatch(routes, '/api/usage-stats/credentials', 'POST',
      { ref: 'SENSENOVA_USERNAME', value: 'synthetic-name' });
    assert.deepEqual(credential.body, { ok: true, ref: 'SENSENOVA_USERNAME' });
    assert.equal(values.get('SENSENOVA_USERNAME'), 'synthetic-name');
    assert.equal((await dispatch(routes, '/api/usage-stats/credentials', 'POST',
      { ref: 'ARBITRARY', value: 'no' })).status, 400);
    assert.equal((await dispatch(routes, '/api/usage-stats/credentials', 'POST',
      { ref: 'SENSENOVA_USERNAME', value: '' })).status, 400);
  });

  await t.test('real live/cold/append/reattach/fork usage with current read-only handles', async () => {
    const cacheFile = join(process.env.DSH_HOME, 'storages/usage-stats-cache.json');
    await fs.mkdir(join(process.env.DSH_HOME, 'storages'), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ version: 6, sessions: { obsolete: {} } }));
    const live = ctx.sessions.create(SessionId('usage-live'), { meta: { cwd: home } });
    appendUsage(live, 10);
    assert.equal(live.events, undefined);
    const cold = Session.create(SessionId('usage-cold'), [], {
      ...Session.create(SessionId('usage-cold')).header, cwd: home,
    });
    appendUsage(cold, 20);
    const writer = await ctx.sessionPersistence.create(cold.header);
    t.after(() => writer.close());
    await writer.append(cold.snapshotEvents());
    await writer.flush();
    const counts = response => response.body.total.inputTokens;
    let response = await dispatch(routes, '/api/usage-stats/usage');
    assert.equal(response.status, 200);
    assert.equal(counts(response), 30);
    assert.equal(JSON.parse(await fs.readFile(cacheFile)).version, 7);
    const coldOpen = t.mock.method(ctx.sessionPersistence, 'open');
    response = await dispatch(routes, '/api/usage-stats/usage');
    assert.equal(counts(response), 30);
    assert.equal(coldOpen.mock.callCount(), 0, 'unchanged cold revision avoids reopening');
    const previousEnd = cold.seq;
    appendUsage(cold, 5, 2);
    await writer.append(cold.snapshotEvents(previousEnd));
    await writer.flush();
    response = await dispatch(routes, '/api/usage-stats/usage');
    assert.equal(counts(response), 35);
    assert.equal(coldOpen.mock.calls[0].arguments[1], 'read');
    coldOpen.mock.restore();
    const resumed = ctx.sessions.prepare(cold.id, {
      seed: cold.snapshotEvents(), meta: cold.header,
    });
    const detachResumed = ctx.sessions.enter(resumed);
    assert.equal(counts(await dispatch(routes, '/api/usage-stats/usage')), 35, 'cold to live');
    detachResumed();
    assert.equal(counts(await dispatch(routes, '/api/usage-stats/usage')), 35, 'live to cold');
    let child;
    const childFiber = await ctx.plugin({ inject: ['sessions'], apply(childCtx) {
      child = childCtx.sessions.fork(live, undefined, SessionId('usage-fork'));
    } });
    appendUsage(child, 7, 2);
    assert.equal(counts(await dispatch(routes, '/api/usage-stats/usage')), 42,
      'fork prefix billed only in parent');
    const childWriter = await ctx.sessionPersistence.create(child.header,
      { inheritedEventCount: child.inheritedEventCount });
    await childWriter.append(child.snapshotEvents());
    await childWriter.close();
    assert.equal(counts(await dispatch(routes, '/api/usage-stats/usage')), 42,
      'live and persisted same id never double count');
    await childFiber.dispose();
    assert.ok(!ctx.sessions.list().some(session => session.id === child.id));
    assert.equal(counts(await dispatch(routes, '/api/usage-stats/usage')), 42,
      'cold fork read uses stored inheritedEventCount');
    const reloaded = await import(`${pathToFileURL(join(root, 'lib/aio-usage-host/index.mjs'))}?reload=1`);
    assert.equal((await reloaded.collectUsage(ctx)).total.inputTokens, 42,
      'persisted cache is rebuilt with fresh service revisions after module reload');
    const date = new Date().toLocaleDateString('sv-SE');
    assert.equal((await dispatch(routes, `/api/usage-stats/day-sessions?date=${date}`)).body.sessions.length, 3);
    assert.equal((await dispatch(routes, '/api/usage-stats/day-sessions?date=bad')).status, 400);
    assert.equal((await dispatch(routes, '/api/usage-stats/signal')).body.ok, true);
  });

  await t.test('budget CRUD, persisted reload and foreign caller/method fences', async () => {
    assert.equal((await dispatch(routes, '/api/usage-stats/budget')).body.budget, null);
    assert.equal((await dispatch(routes, '/api/usage-stats/budget', 'POST', { budget: '1,234' })).body.budget, 1234);
    assert.equal((await dispatch(routes, '/api/usage-stats/budget')).body.budget, 1234);
    const disk = JSON.parse(await fs.readFile(join(process.env.DSH_HOME, 'storages/usage-budget.json')));
    assert.equal(disk.budget, 1234);
    assert.equal((await dispatch(routes, '/api/usage-stats/budget', 'POST', { budget: -1 })).status, 400);
    assert.equal((await dispatch(routes, '/api/usage-stats/budget', 'POST', { budget: 0 })).body.budget, 0);
    for (const route of routes.values()) {
      const url = route.path;
      assert.equal((await dispatch(routes, url, 'GET', undefined, {}, '10.0.0.1')).status, 403);
      assert.equal((await dispatch(routes, url, 'POST', {}, { origin: 'https://foreign.invalid' })).status,
        url.endsWith('credentials') || url.endsWith('budget') || route.kind === 'prefix' ? 403 : 405);
    }
    assert.equal((await dispatch(routes, '/api/usage-stats/usage', 'PUT')).status, 405);
  });

  await t.test('skill files and bundles full CRUD, upload/archive, loose skills and concurrent writes', async () => {
    const call = (path, method, body) => dispatch(routes, `/api/skill-manager${path}`, method, body);
    assert.deepEqual((await call('/list')).body, { bundles: [], loose: [] });
    const created = await call('/bundles', 'POST', { name: 'Fixture Bundle' });
    assert.equal(created.status, 200);
    const id = created.body.id;
    assert.equal((await call('/bundles', 'POST', { name: 'Fixture Bundle' })).status, 400);
    assert.equal((await call(`/bundles/${id}`, 'PATCH', { name: 'Renamed' })).body.name, 'Renamed');
    const installed = await call('/skills', 'POST', {
      skillName: 'alpha', bundleId: id,
      files: [{ path: 'SKILL.md', data: base64(skillText('alpha')) },
        { path: 'references/note.txt', data: base64('first') }],
    });
    assert.equal(installed.status, 200);
    const provider = new FileSystemSkillProvider(ctx, {
      signal: new AbortController().signal, invalidate() {},
    }, {
      includeDefaultRoots: false, watch: false,
      dshHome: process.env.DSH_HOME, agentsHome: process.env.DSH_AGENTS_HOME,
      customSkillDirs: [join(process.env.DSH_AGENTS_HOME, 'skills')],
    });
    try {
      const discovered = await provider.list({});
      const candidate = discovered.find(entry => entry.name === 'alpha');
      assert.ok(candidate, 'current official skill provider discovers installed skill');
      assert.match((await provider.get(candidate, {})).content, /Body/);
    } finally {
      await provider.dispose();
    }
    assert.equal((await call('/skills/alpha/files/references%2Fnote.txt')).body.content, 'first');
    const archive = Buffer.from(zipSync({
      'beta/SKILL.md': strToU8(skillText('beta')), 'beta/readme.txt': strToU8('archive'),
    })).toString('base64');
    assert.equal((await call('/skills', 'POST', { archive })).status, 200);
    assert.equal((await call('/skills/beta/files/readme.txt')).body.content, 'archive');
    assert.equal((await call('/skills', 'POST', {
      skillName: 'beta', files: [{ path: 'new.txt', data: base64('overlay') }],
    })).status, 200);
    assert.equal((await call('/skills/beta/files/readme.txt')).body.content, 'archive',
      'overlay upload preserves untouched existing files');
    const dshSkill = join(process.env.DSH_HOME, 'skills/dsh-only');
    await fs.mkdir(dshSkill, { recursive: true });
    await fs.writeFile(join(dshSkill, 'SKILL.md'), skillText('dsh-only'));
    assert.equal((await call('/skills/dsh-only/files/SKILL.md')).body.content, skillText('dsh-only'));
    assert.equal((await call('/skills/dsh-only', 'DELETE')).status, 200);
    assert.equal((await call('')).body.loose[0].name, 'beta');
    const assigned = await call(`/bundles/${id}/skills`, 'PUT', { skillNames: ['alpha', 'beta'] });
    assert.equal(assigned.body.skillCount, 2);
    const before = await fs.readFile(join(process.env.DSH_AGENTS_HOME, 'skills/.bundles.json'));
    assert.equal((await call(`/bundles/${id}/skills`, 'PUT', { skillNames: ['unknown'] })).status, 400);
    assert.ok(before.equals(await fs.readFile(join(process.env.DSH_AGENTS_HOME, 'skills/.bundles.json'))));
    const parallel = await Promise.all(['One', 'Two'].map(name => call('/bundles', 'POST', { name })));
    assert.ok(parallel.every(result => result.status === 200));
    assert.equal((await call('/list')).body.bundles.length, 3);
    assert.equal((await call('/skills/alpha', 'DELETE')).status, 200);
    assert.equal((await call('/skills/alpha/files/SKILL.md')).status, 400);
    assert.equal((await call(`/bundles/${id}`, 'DELETE')).status, 200);
    assert.equal((await call('/list')).body.loose[0].name, 'beta', 'deleting group retains skills');
    assert.equal((await call('/unknown')).status, 404);
  });

  await t.test('skill traversal/Windows ADS/linked roots and files fail without writes', async () => {
    const call = (path, method, body) => dispatch(routes, `/api/skill-manager${path}`, method, body);
    const skillsRoot = join(process.env.DSH_AGENTS_HOME, 'skills');
    for (const path of ['../escape', '/absolute', 'C:/escape', 'file:stream', 'dir\\escape',
      'dir/../escape', 'NUL', 'trailing.']) {
      const response = await call('/skills', 'POST', {
        skillName: 'escape-test', files: [
          { path: 'SKILL.md', data: base64(skillText('escape-test')) },
          { path, data: base64('must-not-write') },
        ],
      });
      assert.equal(response.status, 400, path);
      await assert.rejects(fs.stat(join(skillsRoot, 'escape-test')), { code: 'ENOENT' });
    }
    assert.equal((await call('/skills/%2e%2e%2foutside/files/data.txt')).status, 400);
    assert.equal((await call('/skills/beta/files/..%2Foutside')).status, 400);
    const external = join(home, 'outside');
    await fs.mkdir(external);
    await fs.writeFile(join(external, 'sentinel'), 'untouched');
    await fs.symlink(external, join(skillsRoot, 'linked'), 'junction');
    assert.equal((await call('/skills/linked/files/sentinel')).status, 400);
    assert.equal((await call('/skills/linked', 'DELETE')).status, 400);
    assert.equal((await call('/skills', 'POST', { skillName: 'linked', description: 'no' })).status, 400);
    assert.equal(await fs.readFile(join(external, 'sentinel'), 'utf8'), 'untouched');
    await fs.unlink(join(skillsRoot, 'linked'));
    const invalidZip = Buffer.from(zipSync({
      'zipped/SKILL.md': strToU8(skillText('zipped')), 'zipped/../outside': strToU8('no'),
    })).toString('base64');
    assert.equal((await call('/skills', 'POST', { archive: invalidZip })).status, 400);
    await assert.rejects(fs.stat(join(skillsRoot, 'zipped')), { code: 'ENOENT' });
    assert.equal((await call('/skills', 'POST', { skillName: 'new', bundleId: 'missing' })).status, 400);
    await assert.rejects(fs.stat(join(skillsRoot, 'new')), { code: 'ENOENT' });
  });

  await t.test('install/delete rollback preserves exact prior skill and ledger bytes', async () => {
    const skillsRoot = join(process.env.DSH_AGENTS_HOME, 'skills');
    const oldFile = await fs.readFile(join(skillsRoot, 'beta/readme.txt'));
    const oldLedger = await fs.readFile(join(skillsRoot, '.bundles.json'));
    const failure = async () => { throw new Error('injected ledger write failure'); };
    await assert.rejects(commitSkill(skillsRoot, 'beta',
      [{ name: 'readme.txt', data: Buffer.from('replacement') }], '', failure), /injected/);
    assert.ok(oldFile.equals(await fs.readFile(join(skillsRoot, 'beta/readme.txt'))));
    assert.ok(oldLedger.equals(await fs.readFile(join(skillsRoot, '.bundles.json'))));
    await assert.rejects(deleteSkill('beta', failure), /injected/);
    assert.ok(oldFile.equals(await fs.readFile(join(skillsRoot, 'beta/readme.txt'))));
    assert.ok(oldLedger.equals(await fs.readFile(join(skillsRoot, '.bundles.json'))));
    assert.ok(!(await fs.readdir(skillsRoot)).some(name => name.startsWith('.webui-')));
    await fs.writeFile(join(skillsRoot, '.bundles.json'), 'invalid ledger');
    const result = await dispatch(routes, '/api/skill-manager/bundles', 'POST', { name: 'No overwrite' });
    assert.equal(result.status, 400);
    assert.equal(await fs.readFile(join(skillsRoot, '.bundles.json'), 'utf8'), 'invalid ledger');
    await fs.writeFile(join(skillsRoot, '.bundles.json'), oldLedger);
  });

  await t.test('failed cold read closes read handle and never commits partial cache', async () => {
    const before = await fs.readFile(join(process.env.DSH_HOME, 'storages/usage-stats-cache.json'));
    const persistence = ctx.sessionPersistence;
    const snapshots = await persistence.list();
    let closed = false;
    const open = t.mock.method(persistence, 'open', async () => ({
      inheritedEventCount: 0,
      read: async () => { throw new Error('fixture read failure'); },
      close: async () => { closed = true; },
    }));
    const list = t.mock.method(persistence, 'list', async () =>
      snapshots.map(snapshot => ({ ...snapshot, revision: 'changed-for-fault' })));
    await assert.rejects(host.collectUsage(ctx), /fixture read failure/);
    assert.equal(closed, true);
    assert.ok(before.equals(await fs.readFile(join(process.env.DSH_HOME, 'storages/usage-stats-cache.json'))));
    open.mock.restore();
    list.mock.restore();
  });
  await t.test('background refresh remains active and disposal stops subsequent ticks', async () => {
    let tick;
    let refreshed = 0;
    let cleared = false;
    const timer = { unref() {} };
    const stop = host.startBackgroundRefresh(ctx, { refreshAll: async () => { refreshed++; } }, {
      setInterval: callback => { tick = callback; return timer; },
      clearInterval: value => { assert.equal(value, timer); cleared = true; },
    });
    await stop.refreshNow();
    assert.equal(refreshed, 2);
    await stop();
    assert.equal(cleared, true);
    await tick();
    assert.equal(refreshed, 2);
  });
  await ctx.fiber.dispose();
  assert.equal(routes.size, 0, 'Cordis disposal removes every host route');
});

test('v2 embedded usage and retry boundaries preserve all billed attempts', () => {
  const state = createUsageState();
  const event = (type, data) => ({ seq: 0, time: Date.now(), type, data });
  applyUsageDelta(state, [
    event('assistant/attempt', { turn: 1, step: 1, stream: usageStream(10) }),
    event('llm/retry-started', { turn: 1, step: 1 }),
    event('assistant/message', { turn: 1, step: 1, stream: usageStream(20) }),
    event('assistant/message', { turn: 1, step: 1, stream: usageStream(99),
      usage: { inputTokens: 25, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 } }),
  ]);
  assert.equal([...state.days.values()][0].totals.inputTokens, 35);
});

test('v2 fold agrees with actual official tokenUsage projection', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjections);
  await ctx.plugin(TokenMeter);
  const session = ctx.sessions.create(SessionId('meter-parity'));
  session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(10) });
  session.append('llm/retry-started', { turn: 1, step: 1, attempt: 1, delayMs: 0 });
  appendUsage(session, 20);
  const state = createUsageState();
  applyUsageDelta(state, session.snapshotEvents());
  const totals = [...state.days.values()][0].totals;
  const official = ctx.sessionProjections.snapshot(session).values.tokenUsage;
  assert.ok(official);
  assert.equal(totals.inputTokens, official.uncachedInputTokens);
  assert.equal(totals.outputTokens, official.outputTokens);
  assert.equal(totals.cacheReadTokens, official.cacheReadTokens);
  assert.equal(totals.cacheWriteTokens, official.cacheWriteTokens);
});

test('billing ZIP parser returns modeled costs without exposing credential-bearing CSV columns', async () => {
  const archive = zipSync({
    'cost-fixture.csv': strToU8('user_id,utc_date,model,wallet_type,cost,currency\nu,d,fixture,paid,1.25,CNY'),
    'amount-fixture.csv': strToU8('user_id,utc_date,model,api_key_name,api_key,type,price,amount\nu,d,fixture,key,synthetic-secret,output_tokens,0,42'),
  });
  let calls = 0;
  const output = await queryDeepseekBilling({ resolve: async () => ({ value: 'synthetic-token' }) }, {
    months: 1,
    fetchImpl: async () => { calls++; return new Response(archive); },
  });
  assert.equal(calls, 1);
  assert.equal(output.months[0].totalCost, 1.25);
  assert.equal(output.months[0].models[0].outputTokens, 42);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret|synthetic-token/);
});

test('ZIP failures and declared decompression limits fail closed', () => {
  assert.throws(() => unzipArchive(Buffer.from('not a zip')));
  const forged = Buffer.from(zipSync({ 'file.txt': strToU8('small') }));
  const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  forged.writeUInt32LE(201 * 1024 * 1024, central + 24);
  assert.throws(() => unzipArchive(forged), /archive too large/);
});

test('reviewed account/balance/subscription adapters retain provenance after extension-only migration', async () => {
  const provenance = JSON.parse(await fs.readFile(new URL('../assets/webui-host/usage/PROVENANCE.json', import.meta.url)));
  for (const name of ['accounts', 'balance', 'subscriptions']) {
    const text = await fs.readFile(new URL(`../assets/webui-host/usage/${name}.mjs`, import.meta.url), 'utf8');
    assert.equal(digest(text.replace(/(from ["']\.\/[^"']+)\.mjs/g, '$1.js')),
      provenance.upstream.files[`lib/${name}.js`]);
  }
});
