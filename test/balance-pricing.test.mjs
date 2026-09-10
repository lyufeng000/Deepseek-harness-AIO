import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const balance = require('../legacy/electron/balance.js');

// 用固定日期验证 computePricingState 的时段判定与倒计时边界
// （2026-08-19 是星期三，日期本身不影响，分钟换算即可）。
const at = (h, m) => new Date(2026, 7, 19, h, m, 0, 0);

test('computePricingState：高峰时段判定与 nextAt（默认窗口 09-12 / 14-18）', () => {
  const s = balance.computePricingState(undefined, at(10, 30));
  assert.equal(s.period, 'peak');
  assert.deepEqual(s.windows, [['09:00', '12:00'], ['14:00', '18:00']]);
  assert.equal(s.nextAt, at(12, 0).getTime(), '高峰中 nextAt 应为本段结束');

  const s2 = balance.computePricingState(undefined, at(16, 45));
  assert.equal(s2.period, 'peak');
  assert.equal(s2.nextAt, at(18, 0).getTime());
});

test('computePricingState：空闲时段 nextAt 为下一段高峰起点', () => {
  const s = balance.computePricingState(undefined, at(12, 30));
  assert.equal(s.period, 'offpeak');
  assert.equal(s.nextAt, at(14, 0).getTime());

  const s2 = balance.computePricingState(undefined, at(19, 0));
  assert.equal(s2.period, 'offpeak');
  assert.equal(s2.nextAt, new Date(2026, 7, 20, 9, 0).getTime(), '傍晚空闲下一段应为次日 09:00');
});

test('computePricingState：边界与跨夜窗口', () => {
  // 12:00 整 = 高峰结束时刻（[start, end) 语义，不属高峰）。
  assert.equal(balance.computePricingState(undefined, at(12, 0)).period, 'offpeak');
  assert.equal(balance.computePricingState(undefined, at(18, 0)).period, 'offpeak');
  assert.equal(balance.computePricingState(undefined, at(8, 59)).period, 'offpeak');

  // 跨夜窗口 23:00-08:00：夜间属高峰，早上 08:00 结束。
  const overnight = [['23:00', '08:00']];
  assert.equal(balance.computePricingState(overnight, at(0, 30)).period, 'peak');
  assert.equal(balance.computePricingState(overnight, at(7, 59)).period, 'peak');
  assert.equal(balance.computePricingState(overnight, at(8, 0)).period, 'offpeak');
  assert.equal(balance.computePricingState(overnight, at(22, 0)).period, 'offpeak');
  assert.equal(balance.computePricingState(overnight, at(0, 30)).nextAt, at(8, 0).getTime());
});

test('computePricingState：非法窗口回落官方默认', () => {
  assert.equal(balance.computePricingState('garbage', at(10, 0)).period, 'peak');
  assert.equal(balance.computePricingState([], at(10, 0)).period, 'peak');
  assert.equal(balance.computePricingState([['25:00', '26:00']], at(10, 0)).period, 'peak');
});

test('tierPrices：扁平覆盖整体生效，双档覆盖按档取值', () => {
  const base = balance.DEFAULT_PRICES['deepseek-v4-flash'];
  // 扁平覆盖（旧版单档结构）：整个 override 作为当前档覆盖。
  const flat = balance.tierPrices(base, { cacheMiss: 9, cacheHit: 1, output: 20 }, 'offpeak');
  assert.equal(flat.cacheMiss, 9);
  assert.equal(flat.cacheHit, 1);
  assert.equal(flat.output, 20);
  // 双档覆盖（新结构）：各档独立取值，未覆盖档回退基础档。
  const dual = { peak: { cacheMiss: 9, cacheHit: 1, output: 20 }, offpeak: { cacheMiss: 0.5, cacheHit: 0.05, output: 2 } };
  assert.deepEqual(balance.tierPrices(base, dual, 'peak'), { cacheMiss: 9, cacheHit: 1, output: 20 });
  assert.deepEqual(balance.tierPrices(base, dual, 'offpeak'), { cacheMiss: 0.5, cacheHit: 0.05, output: 2 });
  assert.deepEqual(balance.tierPrices(base, { peak: dual.peak }, 'offpeak').cacheMiss, 1.5, '缺 offpeak 档视为扁平覆盖，peak 键不生效');
});

test('sanitizePrices：非法值/缺失档位抛错，合法结构保留', () => {
  assert.throws(() => balance.sanitizePrices({ peak: { cacheMiss: -1, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 0, cacheHit: 0, output: 0 } }));
  assert.throws(() => balance.sanitizePrices({ peak: { cacheMiss: 3, cacheHit: 0.1, output: 9 } }), /空闲/);
  assert.throws(() => balance.sanitizePrices(null));
  assert.deepEqual(balance.sanitizePrices({ peak: { cacheMiss: '3', cacheHit: '0.1', output: 9 }, offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 } }), {
    peak: { cacheMiss: 3, cacheHit: 0.1, output: 9 },
    offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 },
  });
});
