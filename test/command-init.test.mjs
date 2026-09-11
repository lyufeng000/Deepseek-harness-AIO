import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INIT_MARKER,
  collectAgentFiles,
  formatInitBlock,
  prependInitBlock,
  messageHasMarker,
  name,
  inject,
  apply,
} from '../assets/plugins/dsh-command-init/lib/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('插件元数据：name / inject 与 /init 注册面', () => {
  assert.equal(name, 'command-init');
  assert.deepEqual(inject, ['commands']);
  const src = fs.readFileSync(path.join(root, 'sidecar/src/desktop-core.ts'), 'utf8');
  assert.match(src, /id: 'command-init'/);
  assert.match(src, /name: 'dsh-command-init'/);
});

test('collectAgentFiles 读取 user-global 与项目链，cwd 覆盖更具体', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-init-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-init-cwd-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'global-agents\n');
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'project-agents\n');
  fs.writeFileSync(path.join(cwd, 'AGENTS.local.md'), 'local-agents\n');
  const files = await collectAgentFiles({ cwd, dshHome: home });
  assert.deepEqual(files.map((f) => f.text.trim()), ['global-agents', 'project-agents', 'local-agents']);
});

test('formatInitBlock / prependInitBlock 写入 marker，且不改原对象', () => {
  const block = formatInitBlock([{ path: '/tmp/AGENTS.md', text: 'hello' }]);
  assert.ok(block.startsWith(INIT_MARKER));
  assert.match(block, /hello/);
  const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] };
  const next = prependInitBlock(original, block);
  assert.notEqual(next, original);
  assert.equal(original.content[0].text, 'hi');
  assert.equal(next.content[0].text, `${block}\n\n`);
  assert.equal(next.content[1].text, 'hi');
  assert.equal(messageHasMarker(next), true);
  assert.equal(messageHasMarker(original), false);
});

test('apply 注册 /init，并在首条用户消息上注入', async () => {
  const registered = [];
  const listeners = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    commands: { register(def) { registered.push(def); return () => {}; } },
    on(event, handler) { listeners.push({ event, handler }); },
  };
  apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'init');
  const pre = listeners.find((item) => item.event === 'agent/pre-step');
  assert.ok(pre);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-init-apply-'));
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'injected-body\n');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] };
    const agent = { session: { header: { cwd: home }, snapshotEvents() { return []; } } };
    const decision = await pre.handler({ agent }, async () => ({ kind: 'accept', messages: [message] }));
    assert.equal(messageHasMarker(decision.messages[0]), true);
    assert.match(decision.messages[0].content[0].text, /injected-body/);
    assert.equal(decision.messages[0].content[1].text, 'first');
    const result = registered[0].handler({ agent });
    assert.equal(result.kind, 'success');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
