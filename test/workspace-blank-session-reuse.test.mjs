'use strict';

// 「新对话」在首轮 prompt 被拒后的空白会话上无反应的回归测试。
//
// 上游 @deepseek-ai/dsh-client-ui-workspace 的 connectWorkspace 只按 Host 摘要
// （summary.blank）挑选可复用的空白会话；首轮 prompt 被拒（例如模型不支持图片，
// Host 在 admission 阶段抛 session/attachment-invalid）时会话日志仍为空，于是
// 「新对话」每次都会打开同一个已经 engaged 的会话，界面停在空对话不动。
//
// 受控补丁要求候选会话从未 engaged（客户端 promptAttempted）才允许复用；这里加载
// 审核快照里真实的 navigation.js 区段，对补丁前后的选择结果逐条对账。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applySeedPatches, SEED_PATCHES } from '../scripts/seed-kernel-patches.mjs';
import { publicSeed } from './fixture-paths.mjs';

const PATCH_ID = 'workspace-blank-session-skip-engaged';
const SEGMENTS = ['profiles', 'web-desktop', 'node_modules', '@deepseek-ai',
  'dsh-client-ui-workspace', 'lib', 'client.js'];
const MARKER = 'this.sessions.binding(summary.id)?.session?.promptAttempted === true';
const NAVIGATION_REGION = '//#region lib/types/client/navigation.js';

/** 审核快照 / 环境变量 / 本机 profile 中的未补丁 client.js。 */
function locateUpstream() {
  const roots = [
    process.env.DSH_WORKSPACE_TEST_PACKAGE,
    publicSeed,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'com.deepseek.dsh.desktop.aio',
      'dsh-home', 'profiles', 'web-desktop') : '',
  ].filter((value) => typeof value === 'string' && value !== '');
  for (const root of roots) {
    const file = path.join(root, ...SEGMENTS);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(MARKER)) return { file, text };
  }
  return null;
}

const upstream = locateUpstream();

/** 复制上游客户端到临时 seed 并执行受控补丁。 */
function patchedSeed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-blank-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ...SEGMENTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, upstream.text);
  const applied = applySeedPatches(root).find((row) => row.id === PATCH_ID);
  return { root, file, applied };
}

/** 从客户端源码里取 navigation.js 区段，在最小沙箱里求值 UiWorkspaceService。 */
function loadUiWorkspaceService(clientSource) {
  const source = clientSource.replace(/\r\n/g, '\n');
  const from = source.indexOf(NAVIGATION_REGION);
  const to = source.indexOf('//#endregion', from);
  assert.ok(from >= 0 && to > from, 'navigation.js region present');
  const sandbox = {
    console, Number, Date, Math, Error, Promise, Set, Map, JSON, Array, Object, String, Boolean,
    _deepseek_ai_cordis: {
      Service: class Service {
        constructor(ctx, name) { this.ctx = ctx; this.name = name; }
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(from, to)}\n;this.__uiWorkspace = UiWorkspaceService;`, sandbox,
    { filename: 'ui-workspace-navigation.js' });
  return sandbox.__uiWorkspace;
}

/** 一个 workspace、一个空白会话；按入参给出会话的客户端 engaged 事实。 */
function harness(UiWorkspaceService, { promptAttempted = false } = {}) {
  const workspace = {
    workspaceId: 'ws1', path: 'F:\proj', title: 'proj',
    createdAt: new Date(0).toISOString(), sessionIds: ['s-blank'],
  };
  const created = [];
  const opened = [];
  const sessions = {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        ids: ['s-blank'],
        byId: { 's-blank': { id: 's-blank', sessionId: 's-blank', blank: true, cwd: 'F:\proj', updatedAt: 1 } },
        current: 's-blank',
      }),
    },
    create: ({ workspaceId }) => { created.push(workspaceId); return Promise.resolve('s-fresh'); },
    open: (id) => { opened.push(id); },
    clear: () => { opened.push('<clear>'); },
    binding: (id) => (id === 's-blank'
      ? { sessionId: id, session: { sessionId: id, promptAttempted } }
      : undefined),
  };
  const workspaces = {
    list: { getSnapshot: () => ({ phase: 'ready', items: [workspace], archivedSessionIds: [] }) },
  };
  const ctx = { effect: () => () => {}, remote: { directoryPicker: {} } };
  return {
    service: new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions),
    created,
    opened,
  };
}

test('受控补丁命中审核快照并保持幂等', { skip: upstream === null }, (t) => {
  const patch = SEED_PATCHES.find((row) => row.id === PATCH_ID);
  assert.ok(patch, `${PATCH_ID} present`);
  assert.deepEqual(patch.file, SEGMENTS);
  const first = patchedSeed(t);
  assert.equal(first.applied.applied, true);
  const patched = fs.readFileSync(first.file, 'utf8');
  assert.ok(patched.includes(MARKER));
  assert.ok(!patched.includes(patch.from));
  const second = applySeedPatches(first.root).find((row) => row.id === PATCH_ID);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(first.file, 'utf8'), patched);
});

test('已 engaged 的空白会话不再是「新对话」的复用目标', { skip: upstream === null }, async (t) => {
  const { file } = patchedSeed(t);
  const UiWorkspaceService = loadUiWorkspaceService(fs.readFileSync(file, 'utf8'));

  const engaged = harness(UiWorkspaceService, { promptAttempted: true });
  assert.equal(await engaged.service.connectWorkspace('ws1'), 's-fresh');
  assert.deepEqual(engaged.created, ['ws1']);

  engaged.service.startSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(engaged.opened, ['s-fresh'], '「新对话」必须落到新的空白会话（回到选择项目状态）');
});

test('未 engaged 的空白会话仍按原语义复用', { skip: upstream === null }, async (t) => {
  const { file } = patchedSeed(t);
  const UiWorkspaceService = loadUiWorkspaceService(fs.readFileSync(file, 'utf8'));

  const fresh = harness(UiWorkspaceService, { promptAttempted: false });
  assert.equal(await fresh.service.connectWorkspace('ws1'), 's-blank');
  assert.deepEqual(fresh.created, [], '未 engaged 的空白会话不额外创建');

  fresh.service.startSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fresh.opened, ['s-blank']);
});
