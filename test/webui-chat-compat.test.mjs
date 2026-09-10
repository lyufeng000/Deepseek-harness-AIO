import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { migrateWebuiChatRenderers } from '../scripts/webui-chat-compat.mjs';

function fixture(name, count) {
  return `const ${name} = ({ useSession }) => {
    ${Array.from({ length: count }, (_, i) => `const value${i} = useSession(snapshot => ({
      nodes: snapshot.chat.locations.getTurn(1).map(key => snapshot.chat.nodes.get(key)),
      timing: snapshot.turnTimings.get(1)
    }));`).join('\n')}
    return value0;
  };
  //#endregion
`;
}

test('both capsule renderers read current ChatSnapshot rather than session state', () => {
  const input = fixture('BetterAssistantNodeView', 3) + fixture('ToolGroupNodeView', 2);
  const migrated = migrateWebuiChatRenderers(input);
  assert.doesNotMatch(migrated, /useSession|snapshot\.chat\.|snapshot\.turnTimings/);
  const result = Function(`${migrated}; return { BetterAssistantNodeView, ToolGroupNodeView };`)();
  const node = { key: 'tool:1', kind: 'tool-call' };
  const timing = { startTime: 10, endTime: 20 };
  const snapshot = {
    locations: { getTurn: () => ['tool:1'] },
    nodes: new Map([['tool:1', node]]),
    legacy: { turnTimings: new Map([[1, timing]]) },
  };
  for (const render of Object.values(result)) {
    assert.deepEqual(render({ useChat: selector => selector(snapshot) }), { nodes: [node], timing });
  }
  assert.equal(migrateWebuiChatRenderers(migrated), migrated);
});

test('unknown renderer shapes fail closed and unrelated session hooks stay unchanged', () => {
  const input = fixture('BetterAssistantNodeView', 3) + fixture('ToolGroupNodeView', 2);
  assert.throws(() => migrateWebuiChatRenderers(input.replaceAll('snapshot.turnTimings', 'snapshot.other')));
  assert.throws(() => migrateWebuiChatRenderers(input.replace('const ToolGroupNodeView', 'const Other')));
  const outside = '\nconst unrelated = useSession(snapshot => snapshot.running);';
  assert.ok(migrateWebuiChatRenderers(input + outside).endsWith(outside));
});

test('reviewed WebUI components render one reasoning and tool capsule per turn', async t => {
  const { webuiArchive: archive, requireFixture } = await import('./fixture-paths.mjs');
  requireFixture(archive);
  const source = execFileSync('tar', ['-xOf', archive, 'package/lib/client.js'],
    { encoding: 'utf8', maxBuffer: 30 * 1024 ** 2 });
  const migrated = migrateWebuiChatRenderers(source);
  assert.equal(migrateWebuiChatRenderers(migrated), migrated);
  const functions = ['BetterAssistantNodeView', 'ToolGroupNodeView'].map(name => {
    const start = migrated.indexOf(`const ${name} = `);
    return migrated.slice(start, migrated.indexOf('//#endregion', start));
  }).join('\n');
  const renderers = new Script(`${functions}\n({ BetterAssistantNodeView, ToolGroupNodeView })`)
    .runInNewContext({
      react: { memo: fn => fn, useMemo: fn => fn() },
      react_jsx_runtime: { jsx: (type, props) => ({ type, props }) },
      EMPTY_STEPS: [], EMPTY: [],
      BetterAssistantMarkdown: 'markdown', ReasoningEntry: 'reasoning', ToolEntry: 'tools',
      turnNumber: node => node.location.turn.turn,
    });
  const turn = { turn: 1, status: 'running' };
  const assistant = {
    key: 'a1', kind: 'assistant-step', location: { kind: 'step', turn },
    data: { status: 'running', time: 10, blocks: [{ kind: 'reasoning', text: 'Inspecting fixture' }] },
  };
  const sibling = { ...assistant, key: 'a2' };
  const tool = { key: 't1', kind: 'tool-call', location: { kind: 'step', turn } };
  const secondTool = { ...tool, key: 't2' };
  const nodes = new Map([assistant, tool, sibling, secondTool].map(node => [node.key, node]));
  const snapshot = {
    nodes, locations: { getTurn: () => [...nodes.keys()] },
    legacy: { turnTimings: new Map([[1, { startTime: 10 }]]) },
  };
  const props = { useChat: select => select(snapshot), useTurnData: () => undefined };
  const first = renderers.BetterAssistantNodeView({ ...props, node: assistant });
  assert.equal(first.props.group.type, 'reasoning');
  assert.equal(first.props.group.props.running, true);
  assert.equal(first.props.group.props.items.length, 2);
  assert.equal(renderers.BetterAssistantNodeView({ ...props, node: sibling }).props.group, undefined);
  const tools = renderers.ToolGroupNodeView({ ...props, node: tool });
  assert.equal(tools.type, 'tools');
  assert.equal(tools.props.nodes.length, 2);
  assert.equal(tools.props.turnStart, 10);
  assert.equal(renderers.ToolGroupNodeView({ ...props, node: secondTool }), null);
});
