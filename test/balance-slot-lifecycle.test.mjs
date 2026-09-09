import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../assets/plugins/dsh-balance/lib/client.js', import.meta.url), 'utf8');

function loadClient({ react = require('react'), bridge, document } = {}) {
  let plugin;
  const forbidden = () => { throw new Error('Settings-only balance client must not poll or subscribe to balance'); };
  const window = {
    __ModuleLoader__: { load(value) {
      plugin = value.factory(id => id === 'react' ? react : require(id));
    } },
    dshDesktop: { balancePrices: bridge, refreshBalance: forbidden },
    addEventListener: forbidden,
  };
  vm.runInNewContext(source, { window, document, setInterval: forbidden, fetch: forbidden });
  return plugin;
}

test('balance registers only pricing settings and releases the registration with its owner', () => {
  const styles = [];
  const document = {
    querySelector: () => styles[0],
    createElement: () => ({ dataset: {} }),
    head: { appendChild: tag => styles.push(tag) },
  };
  const plugin = loadClient({ document });
  const pending = new Map();
  const active = new Set();
  const slots = {
    inject(name, callback) { pending.set(name, callback); },
    register({ name, id, label }, component) {
      assert.ok(pending.has(name), 'slot must be declared before registering');
      assert.equal(id, 'pricing');
      assert.equal(label(), '价格设置');
      assert.equal(component.name, 'PricingSection');
      active.add(name);
      return () => active.delete(name);
    },
  };
  assert.doesNotThrow(() => plugin.apply({ slots }));
  assert.equal(active.size, 0);
  assert.deepEqual([...pending.keys()], ['settings.section']);
  const disposers = [...pending.values()].map(callback => callback());
  assert.equal(active.size, 1);
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.dsh-balance-pr/);
  assert.doesNotMatch(styles[0].textContent, /dsh-balance-dock/);
  for (const dispose of disposers) dispose();
  assert.equal(active.size, 0);
});

test('removed bottom balance pill has no component, subscription, price fallback or CSS left', () => {
  for (const token of ['BalanceDock', 'function money', 'sessionCost', 'hasUsage',
    'useBalanceData', 'FALLBACK_PRICES', 'dsh-balance-dock', 'conversation.composer.dock',
    'dsh-balance-changed', 'refreshBalance', 'setInterval', 'tokenUsage']) {
    assert.ok(!source.includes(token), `obsolete bottom-pill code: ${token}`);
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('../assets/plugins/dsh-balance/package.json', import.meta.url)));
  assert.equal(pkg.name, '@deepseek-ai/dsh-balance');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots']);
  assert.match(pkg.description, /仅提供设置界面/);
  assert.ok(source.includes('function PricingSection'));
});

test('actual pricing component still loads, saves, resets and switches models through balancePrices', async () => {
  const state = [];
  const effects = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let component;
  const pendingEffects = [];
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value;
      }];
    },
    useEffect(callback, deps) {
      const index = effectIndex++;
      if (!effects[index] || deps.some((value, i) => value !== effects[index][i])) {
        effects[index] = deps;
        pendingEffects.push(callback);
      }
    },
  };
  const prices = {
    peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 },
    offpeak: { cacheMiss: 1, cacheHit: 0.25, output: 4 },
  };
  const calls = [];
  const bridge = {
    async get(model) { calls.push(['get', model]); return { ok: true, defaults: prices }; },
    async set(model, value) { calls.push(['set', model, JSON.parse(JSON.stringify(value))]); return { ok: true }; },
    async reset(model) { calls.push(['reset', model]); return { ok: true }; },
  };
  const plugin = loadClient({ react, bridge });
  plugin.apply({ slots: {
    inject(name, callback) { assert.equal(name, 'settings.section'); callback(); },
    register(_, value) { component = value; return () => {}; },
  } });
  function render() {
    stateIndex = effectIndex = 0;
    const tree = component();
    for (const effect of pendingEffects.splice(0)) effect();
    return tree;
  }
  function elements(tree) {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object') return [];
    return [tree, ...elements(tree.props?.children)];
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));
  render();
  await settle();
  let tree = render();
  assert.deepEqual(calls, [['get', 'deepseek-v4-flash']]);
  const inputs = elements(tree).filter(node => node.type === 'input');
  assert.equal(inputs.length, 6, 'both price tiers retain all three fields');
  inputs[0].props.onChange({ target: { value: '4.5' } });
  tree = render();
  const button = (label) => elements(tree).find(node => node.type === 'button' && node.props.children === label);
  assert.equal(button('保存').props.disabled, false);
  button('保存').props.onClick();
  await settle();
  assert.deepEqual(calls[1], ['set', 'deepseek-v4-flash', {
    ...prices, peak: { ...prices.peak, cacheMiss: 4.5 },
  }]);
  tree = render();
  assert.equal(button('保存').props.disabled, true);
  button('恢复默认').props.onClick();
  await settle();
  assert.deepEqual(calls.slice(2), [['reset', 'deepseek-v4-flash'], ['get', 'deepseek-v4-flash']]);
  tree = render();
  assert.equal(elements(tree).find(node => node.type === 'input').props.value, 2);
  button('V4 Pro').props.onClick();
  render();
  await settle();
  assert.deepEqual(calls.at(-1), ['get', 'deepseek-v4-pro']);
});
