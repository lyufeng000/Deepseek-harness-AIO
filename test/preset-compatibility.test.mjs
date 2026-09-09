import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { load } from 'js-yaml';
import { Context, resolveConfig } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import SystemPrompt, {
  PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION,
} from '@deepseek-ai/dsh-system-prompt';
import * as persona from '@deepseek-ai/dsh-persona';
import Tools from '@deepseek-ai/dsh-tools';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';

const root = fileURLToPath(new URL('../assets/agent-presets/', import.meta.url));
const deniedCalls = [];
before(() => {
  const deny = () => {
    deniedCalls.push('network attempt');
    throw new Error('Preset compatibility tests forbid network/model calls');
  };
  mock.method(globalThis, 'fetch', deny);
  mock.method(net.Socket.prototype, 'connect', deny);
  mock.method(tls, 'connect', deny);
  for (const transport of [http, https]) {
    mock.method(transport, 'request', deny);
    mock.method(transport, 'get', deny);
  }
});
after(() => {
  mock.restoreAll();
  assert.deepEqual(deniedCalls, [], 'no network/model calls are permitted');
});

function compositions(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? compositions(path)
      : entry.name === 'agent.cordis.yml' ? [path] : [];
  });
}

function* flatten(rows, prefix = '') {
  assert.ok(Array.isArray(rows), 'composition/group must contain rows');
  const ids = new Set();
  for (const row of rows) {
    assert.ok(row.id && row.name, 'every row needs an id and module');
    assert.ok(!ids.has(row.id), `duplicate row ${prefix}${row.id}`);
    ids.add(row.id);
    yield { row, id: `${prefix}${row.id}` };
    if (row.group) yield* flatten(row.config, `${prefix}${row.id}/`);
  }
}

const files = compositions(root);
assert.equal(files.length, 4, 'cover all shipped compositions, including the nested copy');
for (const file of files) {
  const label = relative(root, file);
  const rows = load(readFileSync(file, 'utf8'), { schema: entryListSchema });
  const entries = [...flatten(rows)];
  for (const { row, id } of entries) {
    test(`${label}: ${id} imports and validates (including disabled rows)`, async () => {
      const specifier = row.name === 'cordis:group'
        ? '@deepseek-ai/cordis-plugin-group'
        : row.name.startsWith('.') ? pathToFileURL(join(dirname(file), row.name)).href
          : row.name;
      const mod = await import(specifier);
      const plugin = mod.default ?? mod;
      assert.ok(typeof plugin === 'function' || typeof plugin.apply === 'function',
        `${row.name} must export a Cordis plugin`);
      if (row.group) return; // Child configs are checked individually.
      for (const platform of ['win32', 'linux', 'darwin']) {
        const context = { process: { platform, env: {}, cwd: () => dirname(file) } };
        const config = interpolate(context, row.config ?? {});
        const disabled = interpolate(context, row.disabled ?? false);
        assert.equal(typeof disabled, 'boolean');
        resolveConfig(plugin, structuredClone(config));
        // Schemastery can retain unknown keys; do not silently accept stale options.
        if (plugin.Config?.dict) {
          for (const key of Object.keys(config)) {
            assert.ok(Object.hasOwn(plugin.Config.dict, key), `${row.name}: unknown config key ${key}`);
          }
        }
        if (row.name === '@deepseek-ai/dsh-plan-mode') mod.resolveConfig(config);
        if (row.name.startsWith('.')) {
          // Local rows validate in apply(), not in a Config schema. Register
          // handlers/tools only: never execute a tool or dispatch an LLM event.
          const ctx = new Context();
          try {
            await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
            await ctx.plugin(Tools);
            await plugin.apply(ctx, config);
          } finally {
            await ctx.fiber.dispose();
          }
        }
      }
    });
  }

  test(`${label}: actual persona mounting preserves scope and prompt policy`, async (t) => {
    const config = entries.find(({ row }) => row.name === '@deepseek-ai/dsh-persona').row.config;
    assert.equal(config.prefix, 'You are a helpful software engineer assistant.');
    assert.ok(!Object.hasOwn(config, 'text'));
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      personaPrefix: 'host prefix',
      personaSuffix: 'host suffix',
    });
    ctx.systemPrompt.context({ name: 'test-runtime', order: 1, text: 'runtime context' });
    const scope = createScope(ctx, { preset: label });
    t.after(() => scope.dispose());
    const sibling = createScope(ctx, { preset: `${label}-sibling` });
    t.after(() => sibling.dispose());
    const mounted = await scope.ctx.plugin(persona, config);
    const assemble = (key) => ctx.systemPrompt.assemble({ scope: key });
    const text = (assembly, name) => assembly.sections.find((s) => s.name === name)?.text;
    const own = await assemble(scopeOf(scope.ctx));
    assert.equal(text(own, PERSONA_PREFIX_SECTION), config.prefix);
    assert.notEqual(text(own, PERSONA_SUFFIX_SECTION), 'host suffix');
    if (config.complete) {
      assert.deepEqual(own.sections.map((s) => s.text), [config.prefix]);
    }
    assert.equal(own.contexts.some((c) => c.name === 'test-runtime'),
      config.includeRuntimeContext !== false);
    for (const key of [undefined, scopeOf(sibling.ctx)]) {
      const assembly = await assemble(key);
      assert.equal(text(assembly, PERSONA_PREFIX_SECTION), 'host prefix');
      assert.equal(text(assembly, PERSONA_SUFFIX_SECTION), 'host suffix');
      assert.ok(assembly.contexts.some((c) => c.name === 'test-runtime'));
    }
    await mounted.dispose();
    const restored = await assemble(scopeOf(scope.ctx));
    assert.equal(text(restored, PERSONA_PREFIX_SECTION), 'host prefix');
    assert.equal(text(restored, PERSONA_SUFFIX_SECTION), 'host suffix');
    assert.ok(restored.contexts.some((c) => c.name === 'test-runtime'));
  });
}
