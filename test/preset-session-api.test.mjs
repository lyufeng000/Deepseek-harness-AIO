import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents, { assembleContextFor } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as bootstrap from '../assets/agent-presets/anchored-standard/tool-bootstrap.mjs';

const dirs = ['router-standard', 'router-spec', 'router-spec/router-spec'];
const asset = relative => new URL(`../assets/agent-presets/${relative}`, import.meta.url);
const appendCall = (session, name = 'str_replace_editor', args = {}) =>
  session.append('tool/call', {
    turn: 1, step: 1, callId: `call-${session.seq}`, name, arguments: JSON.stringify(args),
  });
const appendUser = (session, text) => session.append('user/message',
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  { surfaceOp: 'append' });

// In-memory production services and agent ownership, with no adapter, files,
// user configuration or running turns. Catalog-only tools must never execute.
async function harness(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents]) {
    await ctx.plugin(plugin);
  }
  await ctx.plugin(AgentLoop, { agents: [] });
  const names = ['bash', 'pwsh', 'str_replace_editor', 'read', 'write', 'edit', 'glob', 'grep',
    'dev_tool_search', 'skill_search', 'skill_load', 'web_search'];
  for (const name of names) {
    ctx.tools.register({
      name, description: name, parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { throw Error('Catalog fixture should not execute'); },
    });
  }
  const create = async id => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id) });
    t.after(() => handle.dispose());
    return handle.agent;
  };
  return { ctx, create, tools: async agent =>
    (await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name).sort() };
}

for (const dir of dirs) {
  test(`${dir}: routing reads the immutable current Session snapshot`, async () => {
    const { sessionMode } = await import(asset(`${dir}/router-core.mjs`));
    const session = Session.create(SessionId(`routing-${dir}`));
    assert.equal(session.events, undefined, 'never install a compatibility property on Session');
    assert.equal(sessionMode(session), 'weak');
    appendUser(session, 'fix a broken parser');
    const snapshot = session.snapshotEvents();
    appendUser(session, 'build a new app');
    assert.equal(sessionMode(session), 0, 'first durable user request controls routing');
    assert.equal(snapshot.length, 1, 'earlier snapshots remain immutable');
  });
}

for (const dir of ['anchored-standard', '_preset']) {
  test(`${dir}: promotion and compaction cold replay use the real session API`, async () => {
    const { createEpochPromotion } = await import(asset(`${dir}/compaction-epoch.mjs`));
    const session = Session.create(SessionId(`epoch-${dir}`));
    const agent = { session };
    const tracker = createEpochPromotion(['tool/call']);
    assert.deepEqual(tracker.status(agent), { boundary: -1, promoted: false });
    const call = appendCall(session);
    tracker.observe(session, call);
    assert.equal(tracker.status(agent).promoted, true);
    assert.equal(createEpochPromotion(['tool/call']).status(agent).promoted, true);
    const compact = session.append('compaction/end', {});
    tracker.observe(session, compact);
    assert.deepEqual(tracker.status(agent), { boundary: compact.seq, promoted: false });
    assert.deepEqual(createEpochPromotion(['tool/call']).status(agent), tracker.status(agent));
    const next = appendCall(session);
    tracker.observe(session, next);
    assert.equal(tracker.status(agent).promoted, true);
  });
}

test('anchored: exact bootstrap, resident promotion, discovery unlock and compaction reset', async t => {
  const { ctx, create, tools } = await harness(t);
  const mounted = await ctx.plugin(bootstrap, {
    bootstrapTools: ['bash', 'str_replace_editor'], compactionTools: ['read'],
  });
  const agent = await create('anchored-snapshot');
  assert.deepEqual(await tools(agent), ['bash', 'str_replace_editor']);
  const first = appendCall(agent.session);
  // SessionStore dispatches this event to the actual mounted plugin.
  assert.equal(first.type, 'tool/call');
  assert.deepEqual(await tools(agent), ['bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor']);
  appendCall(agent.session, 'dev_tool_search', { toolNames: ['web_search'] });
  assert.ok((await tools(agent)).includes('web_search'));
  agent.session.append('compaction/end', {});
  assert.deepEqual(await tools(agent), ['bash', 'read', 'str_replace_editor']);
  await mounted.dispose();
  await ctx.plugin(bootstrap, { bootstrapTools: ['bash', 'str_replace_editor'], compactionTools: ['read'] });
  assert.deepEqual(await tools(agent), ['bash', 'read', 'str_replace_editor'], 'cold replay remains controlled');
  appendCall(agent.session);
  assert.ok((await tools(agent)).includes('web_search'), 'durable discovery survives reload');
});

for (const dir of dirs) {
  for (const file of ['router-bootstrap-v1.mjs', 'router-bootstrap.mjs']) {
    test(`${dir}/${file}: promotion and explicit execution ownership`, async t => {
      const { ctx, create, tools } = await harness(t);
      await ctx.plugin(await import(asset(`${dir}/${file}`)), { routerMode: 'standard' });
      const first = await create('router-first');
      const second = await create('router-second');
      appendUser(first.session, 'fix a broken parser');
      appendUser(second.session, 'build a new app');
      assert.deepEqual(await tools(first), ['pwsh', 'str_replace_editor']);
      assert.deepEqual(await tools(second), ['pwsh', 'str_replace_editor']);
      const status = ctx.tools.get('dev_router_status');
      const mode = ctx.tools.get('dev_router_mode');
      assert.match(await status.execute({}, { agent: first }), /mode=0\.00/);
      assert.match(await status.execute({}, { agent: second }), /mode=1\.00/);
      await mode.execute({ mode: 'react' }, { agent: first });
      await mode.execute({ mode: 'spec' }, { agent: second });
      assert.match(await status.execute({}, { agent: first }), /mode=1\.00/);
      assert.match(await status.execute({}, { agent: second }), /mode=0\.00/);
      assert.equal(await status.execute({}, {}), 'no agent session');
      assert.equal(await mode.execute({ mode: 'react' }, {}), 'no agent session');
      assert.equal(await ctx.tools.get('dev_mode_subagent').execute({ mode: 'spec', task: 'unused' }, {}),
        'no agent route available');
      appendCall(first.session);
      assert.ok((await tools(first)).includes('dev_router_mode'));
      assert.deepEqual(await tools(second), ['pwsh', 'str_replace_editor'], 'promotion stays session-owned');
    });
  }
}

test('shipped bootstrap mirrors remain identical and contain no removed session.events reads', () => {
  const canonical = fs.readFileSync(asset('router-standard/router-bootstrap-v1.mjs'), 'utf8');
  for (const dir of dirs) {
    for (const name of ['router-bootstrap-v1.mjs', 'router-bootstrap.mjs']) {
      const source = fs.readFileSync(asset(`${dir}/${name}`), 'utf8');
      assert.equal(source, canonical);
      assert.doesNotMatch(source, /session\.events\b/);
    }
  }
  assert.equal(fs.readFileSync(asset('_preset/compaction-epoch.mjs'), 'utf8'),
    fs.readFileSync(asset('anchored-standard/compaction-epoch.mjs'), 'utf8'));
});
