import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFRESH_SYMBOL,
  refreshSessions,
  name,
  inject,
  apply,
} from '../assets/plugins/dsh-command-init/lib/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('插件元数据：name / inject 与 /init 注册面', () => {
  assert.equal(name, 'command-init');
  assert.deepEqual(inject, ['commands']);
  assert.equal(REFRESH_SYMBOL, Symbol.for('dsh.eac.agent-instructions.refresh.v1'));
  const src = fs.readFileSync(path.join(root, 'sidecar/src/desktop-core.ts'), 'utf8');
  assert.match(src, /id: 'command-init'/);
  assert.match(src, /name: 'dsh-command-init'/);
});

test('/init 只标记官方隐藏投影刷新，不注册额外 pre-step 注入', () => {
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
  assert.deepEqual(listeners, []);

  const session = { id: 's1', header: { cwd: root } };
  const userMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '逐字保留' }] };
  const result = registered[0].handler({ agent: { session } });
  assert.equal(result.kind, 'success');
  assert.equal(refreshSessions().has(session), true);
  assert.equal(userMessage.content[0].text, '逐字保留');
  assert.deepEqual(registered[0].handler({}), { kind: 'error', text: '当前没有可刷新的会话。' });

  const preset = fs.readFileSync(path.join(root, 'assets/agent-presets/anchored-standard/agent.cordis.yml'), 'utf8');
  assert.match(preset, /suppressedContextSources: \[skill-catalog\]/);
  assert.doesNotMatch(preset, /- id: instruction-hint/);
  const patches = fs.readFileSync(path.join(root, 'scripts/seed-kernel-patches.mjs'), 'utf8');
  assert.match(patches, /id: 'agent-instructions-init-refresh'/);
  assert.match(patches, /dsh\.eac\.agent-instructions\.refresh\.v1/);
  assert.match(patches, /baselinePreparations\.delete\(agent\.session\)/);
  assert.match(patches, /instructionVersions\.delete\(agent\.session\)/);
});
