// TDD regression test: verify that a persona row mounted under an agent scope
// lands in the SCOPED layer (shadowing the global persona prefix) rather
// than colliding with the global registration.
//
// This reproduces the bug where mounting the "standard" agent preset fails
// with a duplicate deployment persona section registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import * as persona from '@deepseek-ai/dsh-persona';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';

test('persona row mounted in a scope shadows the global deployment persona', async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'deployment persona' });

  // Simulate what dsh-agent-presets does: mint a standing scope, then mount
  // the persona row (a plugin with inject: ["systemPrompt"]) inside it.
  const agentKey = { agent: 'standard' };
  const scope = createScope(ctx, agentKey);
  t.after(() => scope.dispose());
  const { ctx: scoped } = scope;
  assert.notEqual(scopeOf(scoped), undefined, 'scoped ctx must carry a scope key');

  await scoped.plugin(persona, { prefix: 'per-agent persona' });

  // Assembling for that scope must see the per-agent persona shadowing the
  // global one.
  const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(scoped) });
  const personaSection = assembly.sections.find((s) => s.name === PERSONA_PREFIX_SECTION);
  assert.equal(personaSection.text, 'per-agent persona', 'scoped persona must shadow the global deployment persona');

  await scope.dispose();
});

test('global assembly still sees the deployment persona', async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'deployment persona' });

  const assembly = await ctx.systemPrompt.assemble({});
  const personaSection = assembly.sections.find((s) => s.name === PERSONA_PREFIX_SECTION);
  assert.equal(personaSection.text, 'deployment persona');
});
