import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { migrateWebuiInputChatToolShapes } from '../scripts/webui-input-chat-tool-compat.mjs';
import { migrateWebuiChatRenderers } from '../scripts/webui-chat-compat.mjs';

const original = execFileSync('tar', ['-xOf',
  'H:/CODEX/build-inputs/aio-v1.1.0-local-packages/dsh-external-dsh-webui-0.5.1.tgz',
  'package/lib/client.js'], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }).replace(/\r\n/g, '\n');
const upstream = 'H:/CODEX/deepseek-harness-upstream-20260908/packages/';
const readOwner = relative => fs.readFileSync(upstream + relative, 'utf8');
const migrated = migrateWebuiInputChatToolShapes(original);
const section = (source, startMarker, endMarker = '//#endregion') => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
};
const icon = () => null;
const primitives = new Proxy({
  Tooltip: ({ children }) => children,
  MessageText: ({ text }) => React.createElement('span', null, text),
  Button: ({ children, onClick, disabled }) => React.createElement('button', { onClick, disabled }, children),
}, { get: (target, key) => target[key] ?? icon });

// Real React SSR checks the reviewed component bodies. The deterministic hook
// harness below additionally exposes callbacks without a browser, DOM or profile.
function hooks() {
  const values = [];
  let index = 0;
  return {
    reset() { index = 0; },
    react: {
      ...React, memo: fn => fn,
      useState(initial) {
        const i = index++;
        if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
        return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
      },
      useRef(initial) {
        const i = index++;
        return values[i] ??= { current: initial };
      },
      useMemo: fn => fn(), useCallback: fn => fn,
      useReducer: (_, initial) => [initial, () => {}],
      useEffect() {},
      useSyncExternalStore: (_, get) => get(),
    },
  };
}
function load(source, type, extra = {}, hookRuntime) {
  const segments = type === 'browser'
    ? section(source, 'const BrowserSeat = ')
    : type === 'rewind'
      ? section(source, 'function contentParts(content) {')
      : section(source, '//#region src/client/tool-summary/tool-stats.ts',
        '//#region src/client/tool-summary/reasoning-classify.ts')
        + section(source, '//#region src/client/tool-summary/ToolGroupNodeView.tsx');
  const names = type === 'browser' ? 'BrowserSeat' : type === 'rewind' ? 'UserRewindNodeView'
    : 'ToolEntry,SimpleToolRow,ToolCallTreeList,ToolGroupNodeView,classifyKind,classifyActivity,commandText';
  return vm.runInNewContext(segments + `\n({${names}})`, {
    react: hookRuntime?.react ?? {
      ...React,
      useSyncExternalStore: (subscribe, get) => React.useSyncExternalStore(subscribe, get, get),
    },
    react_jsx_runtime: jsx,
    _deepseek_ai_dsh_client_ui_primitives: primitives,
    _dsh_aio_ui_compat: primitives,
    GlobeIcon$1: icon, IconUndoOutline16: icon, IconRefreshOutline16: icon,
    IconEditOutline16: icon,
    BrowserDrawer: 'browser-drawer',
    browserActivityStore: () => ({ active: new Map(), subscribe: () => () => {} }),
    buildSummary: info => info.text,
    activityStore: () => ({ setTools() {}, setHandlers() {}, open() {} }),
    fetch() { throw new Error('Network forbidden'); },
    console, setTimeout, clearTimeout,
    ...extra,
  });
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !tree.props) return [];
  return [tree, ...elements(tree.props.children)];
}
const button = (tree, label) => {
  const found = elements(tree).find(el => el.props['aria-label'] === label);
  assert.ok(found, `Missing action: ${label}`);
  return found;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const node = {
  key: 'user:9', kind: 'user', anchorSeq: 9,
  location: { kind: 'turn', turn: { turn: 2 } },
  data: { time: 0, content: [{ type: 'text', text: 'Synthetic retry text' }] },
};
function rewindProps(running = false) {
  return {
    node, sessionId: 'fixture-session', renderMessageImages: () => null,
    useSession: select => select({ running }),
    useChat: select => select({ legacy: { turnEnds: new Map([[1, 8]]) } }),
  };
}
const runningTool = (name = 'bash', args = { command: 'git status' }) => ({
  callId: 'call-1', name, argsRaw: JSON.stringify(args), time: Date.now() - 2000,
  turn: 2, step: 1, subCalls: [],
});
const settledTool = (name = 'bash', args = { command: 'git status' }) => ({
  kind: 'tool-result', callId: 'call-2', seq: 12, time: 2000, callTime: 1000,
  call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text: 'fixture output' }],
  isError: false, subCalls: [],
});
const toolNode = (root, i = 1) => ({
  key: `tool:${i}`, kind: 'tool-call', location: { kind: 'step', turn: { turn: 2 } }, data: { root },
});

test('owner contracts: input hook, Chat legacy boundary, and raw-only tool records', () => {
  assert.match(readOwner('client/ui-conversation/src/client/contract/slots.ts'),
    /useInput: SnapshotSelectorHook<InputState>/);
  assert.match(readOwner('client/ui-conversation/src/client/contract/input.ts'), /readonly draft: string/);
  assert.match(readOwner('client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'),
    /turnEnds: this\.turnEnds/);
  const records = readOwner('client/ui-conversation/src/client/contract/records.ts');
  assert.match(records, /call: \{ name: string; argsRaw: string \} \| null/);
  assert.match(records, /export interface RunningToolCall/);
  assert.doesNotMatch(records, /callView/);
  const installed = fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js', import.meta.url), 'utf8');
  assert.match(installed, /function toolRowModel\(toolName, block, cwd, home\)/);
  assert.match(installed, /done \? block\.call\?\.argsRaw : block\.argsRaw/);
});

test('actual reviewed components reproduce all three alpha.2 crashes', () => {
  const browser = load(original, 'browser').BrowserSeat;
  assert.throws(() => renderToStaticMarkup(React.createElement(browser, {
    sessionId: 'fixture', useInput: fn => fn({ draft: '' }), inputActions: {},
  })), /draft/);
  const rewind = load(original, 'rewind').UserRewindNodeView;
  assert.throws(() => renderToStaticMarkup(React.createElement(rewind, rewindProps())), /get/);
  const tools = load(original, 'tools').ToolEntry;
  assert.throws(() => renderToStaticMarkup(React.createElement(tools, {
    nodes: [toolNode(runningTool())], turn: 2,
  })), /card/);
});

test('BrowserSeat renders, opens drawer, and appends picks to the current hooked draft', () => {
  const runtime = hooks();
  const component = load(migrated, 'browser', {}, runtime).BrowserSeat;
  let draft = 'First draft';
  const props = {
    sessionId: 'fixture', useInput: select => select({ draft }),
    inputActions: { setDraft: next => { draft = next; } },
  };
  const render = () => { runtime.reset(); return component(props); };
  let tree = render();
  assert.match(renderToStaticMarkup(tree), /dsh-browser-seat/);
  elements(tree).find(el => el.props.className === 'dsh-browser-seat').props.onClick();
  draft = 'Updated draft';
  tree = render();
  const drawer = elements(tree).find(el => el.type === 'browser-drawer');
  assert.ok(drawer);
  drawer.props.onPickElement({ selector: '#fixture', text: 'Chosen element' });
  assert.equal(draft, 'Updated draft\n[#fixture] Chosen element');
  draft = '';
  render();
  drawer.props.onPickElement({ selector: '#fixture', text: 'Chosen element' });
  assert.equal(draft, '[#fixture] Chosen element');
  const real = load(migrated, 'browser').BrowserSeat;
  assert.match(renderToStaticMarkup(React.createElement(real, props)), /dsh-browser-seat/);
});

test('rewind renders with separate Chat and Session stores; running still disables retry/edit', () => {
  const component = load(migrated, 'rewind').UserRewindNodeView;
  const idle = renderToStaticMarkup(React.createElement(component, rewindProps()));
  assert.match(idle, /Synthetic retry text/);
  assert.match(idle, /aria-label="修改该对话"/);
  assert.match(idle, /aria-label="重新生成回复"/);
  const busy = renderToStaticMarkup(React.createElement(component, rewindProps(true)));
  assert.doesNotMatch(busy, /aria-label="修改该对话"|aria-label="重新生成回复"/);
});

test('actual retry callback forks at the Chat boundary, sends, opens child then archives original', async () => {
  const calls = [];
  const runtime = hooks();
  const component = load(migrated, 'rewind', {}, runtime).UserRewindNodeView;
  const props = {
    ...rewindProps(),
    sessions: {
      async fork(opts) { calls.push(['fork', JSON.parse(JSON.stringify(opts))]); return 'child'; },
      binding(id) { assert.equal(id, 'child'); return { session: {
        async prompt(content, mode) { calls.push(['prompt', JSON.parse(JSON.stringify(content)), mode]); return { ok: true }; },
      } }; },
      list: { getSnapshot: () => ({ ids: ['child'], byId: {} }) },
      open(id) { calls.push(['open', id]); },
    },
    workspaces: { async archiveSession(id) { calls.push(['archive', id]); } },
  };
  button(component(props), '重新生成回复').props.onClick();
  await flush();
  assert.deepEqual(calls, [
    ['fork', { sessionId: 'fixture-session', atSeq: 8 }],
    ['prompt', [{ type: 'text', text: 'Synthetic retry text' }], 'queue'],
    ['open', 'child'], ['archive', 'fixture-session'],
  ]);
});

test('in-place rewind retains diff confirmation and the exact session/anchor request', async () => {
  const calls = [];
  const runtime = hooks();
  const component = load(migrated, 'rewind', {
    async fetch(url, options) {
      calls.push([url, options && JSON.parse(options.body)]);
      return { json: async () => url.includes('/diff?')
        ? { ok: true, changed: true, summary: { modified: 1, added: 0, deleted: 0 },
          modified: ['fixture.js'], added: [], deleted: [] }
        : { ok: true } };
    },
  }, runtime).UserRewindNodeView;
  const props = rewindProps();
  const render = () => { runtime.reset(); return component(props); };
  button(render(), '退回到这条消息之前').props.onClick();
  await flush();
  const modal = elements(render()).find(el => el.props.title === '退回确认');
  assert.equal(modal.props.open, true);
  assert.equal(calls.length, 1, 'must not rewind before confirmation');
  assert.match(renderToStaticMarkup(modal.props.children), /fixture\.js/);
  elements(modal.props.footer).find(el => el.props.children === '退回').props.onClick();
  await flush();
  assert.deepEqual(calls, [
    ['/api/webui-rewind/diff?sessionId=fixture-session&seq=9', undefined],
    ['/api/webui-rewind/rewind', { sessionId: 'fixture-session', seq: 9 }],
  ]);
  assert.equal(elements(render()).find(el => el.props.title === '退回确认').props.open, false);
});

test('tool capsules and expanded rows render running, settled, failed, nested and windowless records', () => {
  const api = load(migrated, 'tools');
  const blocks = [runningTool(), settledTool(), { ...settledTool('read', { path: '/fixture.js' }),
    isError: true, error: { name: 'Error', code: 'failed' } },
  { ...settledTool(), call: null, callTime: null },
  { ...settledTool('workflow', {}), subCalls: [runningTool('read', { path: '/child.js' })] }];
  for (const block of blocks) {
    const html = renderToStaticMarkup(React.createElement(api.ToolEntry, {
      nodes: [toolNode(block)], turn: 2,
    }));
    assert.match(html, /dts__entry/);
    assert.match(renderToStaticMarkup(React.createElement(api.ToolCallTreeList, { block })), /dts__call/);
  }
  assert.equal(api.commandText(runningTool()), 'git status');
  assert.equal(api.classifyKind(settledTool()).key, 'git');
  assert.equal(api.classifyActivity(runningTool()), 'command');
  assert.equal(api.classifyKind(runningTool('read', { path: '/fixture.js' })).key, 'read');
  assert.equal(api.commandText({ ...settledTool(), call: null }), '');
});

test('capsule click opens the tools drawer and raw call inspection remains wired', () => {
  const calls = [];
  const runtime = hooks();
  const api = load(migrated, 'tools', {
    activityStore: () => ({ open: (...args) => calls.push(args) }),
  }, runtime);
  const tree = api.ToolEntry({ nodes: [toolNode(settledTool())], turn: 2 });
  elements(tree).find(el => el.props.className === 'dts__entry').props.onClick();
  assert.deepEqual(calls, [[2, 'tools']]);
  const rowRuntime = hooks();
  const row = load(migrated, 'tools', {}, rowRuntime).SimpleToolRow;
  const props = { block: settledTool(), inspectCall: id => calls.push(['inspect', id]) };
  const render = () => { rowRuntime.reset(); return row(props); };
  let rowTree = render();
  button(rowTree, '在轨迹中查看 bash').props.onClick({ stopPropagation() {} });
  assert.deepEqual(calls.at(-1), ['inspect', 'call-2']);
  elements(rowTree).find(el => el.props.onClick && el.props.role === 'button').props.onClick();
  rowTree = render();
  assert.match(renderToStaticMarkup(rowTree), /fixture output/);
  assert.match(renderToStaticMarkup(rowTree), /git status/);
});

test('bounded transform is idempotent, composes with chat helper and preserves unrelated bytes', () => {
  assert.equal(migrateWebuiInputChatToolShapes(migrated), migrated);
  assert.equal(migrateWebuiChatRenderers(migrated),
    migrateWebuiInputChatToolShapes(migrateWebuiChatRenderers(original)));
  for (const marker of ['const BrowserSeat = ', 'const UserRewindNodeView = ',
    'function classifyActivity(block) {', 'function commandText(block) {']) {
    assert.throws(() => migrateWebuiInputChatToolShapes(original.replace(marker, 'unknown shape')), /Unknown/);
  }
  assert.throws(() => migrateWebuiInputChatToolShapes(original.replace(
    'snapshot.turnEnds.get(turnNumber - 1)', 'snapshot.other.get(turnNumber - 1)')), /Unknown/);
  assert.throws(() => migrateWebuiInputChatToolShapes(original.replace(
    'view.card === "terminal"', 'view.card === "different-card"')), /Unknown/);
  const withoutOwnedRegions = source => {
    for (const marker of ['const BrowserSeat = ', 'const UserRewindNodeView = ',
      'function classifyActivity(block) {', 'function commandText(block) {']) {
      source = source.replace(section(source, marker), marker);
    }
    return source;
  };
  assert.equal(withoutOwnedRegions(migrated), withoutOwnedRegions(original));
  const crlf = original.replace(/\n/g, '\r\n');
  assert.equal(migrateWebuiInputChatToolShapes(crlf), migrated.replace(/\n/g, '\r\n'));
});

test('public r6 seed code is independently migratable without touching its files', () => {
  const source = fs.readFileSync(
    'H:/CODEX/build-inputs/aio-1.2.0-public-seed-20260908-r6/profiles/web-desktop/node_modules/@dsh-external/dsh-webui/lib/client.js', 'utf8');
  const output = migrateWebuiInputChatToolShapes(source);
  assert.equal(migrateWebuiInputChatToolShapes(output), output);
  assert.ok(output.includes('snapshot.legacy.turnEnds.get'));
});
