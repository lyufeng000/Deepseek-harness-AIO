// DeepSeek 账户余额查询（sidecar 模块，供对话统计栏小部件 / chrome 菜单使用）。
// 忠实移植自legacy/electron/balance.js。
//
// 密钥来源：环境变量 DEEPSEEK_API_KEY > DSH_HOME/.credentials.yaml。
// 端点：https://api.deepseek.com/user/balance；可用环境变量覆盖：
//   DEEPSEEK_BALANCE_URL —— 完整端点 URL（自定义代理/镜像）
//   DEEPSEEK_API_BASE    —— API 基址（自动拼接 /user/balance）

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.deepseek.com';

export interface TierPrice {
  cacheMiss: number;
  cacheHit: number;
  output: number;
}

export type TierMap = Record<string, TierPrice>;

// 官方峰谷定价（2026-08-17 生效）：高峰 9:00-12:00、14:00-18:00（UTC+8），
// 其余为空闲时段，空闲价格为高峰的一半。各模型档位/时段价格（¥/百万 token）。
export const DEFAULT_PRICES: Record<string, { peak: TierPrice; offpeak: TierPrice }> = {
  'deepseek-v4-flash': {
    peak: { cacheMiss: 3, cacheHit: 0.1, output: 9 },
    offpeak: { cacheMiss: 1.5, cacheHit: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 },
    offpeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 },
  },
  'deepseek-chat': { peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 } },
  'deepseek-reasoner': { peak: { cacheMiss: 4, cacheHit: 1, output: 16 }, offpeak: { cacheMiss: 4, cacheHit: 1, output: 16 } },
};
export const FALLBACK_PRICES: { peak: TierPrice; offpeak: TierPrice } = { peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 } };

// 默认高峰时段（UTC+8）：9:00-12:00、14:00-18:00。可在 settings.json 的
// pricing.peakWindows 覆盖（数组的数组，支持跨午夜段）。
export const DEFAULT_PEAK_WINDOWS: string[][] = [['09:00', '12:00'], ['14:00', '18:00']];

function parseHHMM(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mn = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
}

/// 规范化高峰时段配置 → [[startMin, endMin], ...]（按开始时间升序）。
/// 配置非法时回退官方默认；每段 [start, end)，start > end 表示跨午夜。
export function normalizePeakWindows(raw: unknown): [number, number][] {
  const arr = raw as unknown;
  const valid =
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.every(
      (w: unknown) =>
        Array.isArray(w) &&
        (w as unknown[]).length === 2 &&
        parseHHMM((w as unknown[])[0]) !== null &&
        parseHHMM((w as unknown[])[1]) !== null &&
        parseHHMM((w as unknown[])[0]) !== parseHHMM((w as unknown[])[1]),
    );
  const src: string[][] = valid ? (arr as string[][]) : DEFAULT_PEAK_WINDOWS;
  return src
    .map(([a, b]) => [parseHHMM(a) ?? 0, parseHHMM(b) ?? 0] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function atMinutes(date: Date, minutes: number, dayOffset = 0): Date {
  const t = new Date(date);
  t.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (dayOffset) t.setDate(t.getDate() + dayOffset);
  return t;
}

function inWindow(nowMin: number, [start, end]: [number, number]): boolean {
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

export interface PricingState {
  period: 'peak' | 'offpeak';
  windows: [string, string][];
  nextAt: number;
}

/// 当前峰谷状态（nextAt 为毫秒时间戳）。用于余额小部件的时段提示与计费档位切换。
export function computePricingState(peakWindows: unknown, now: Date = new Date()): PricingState {
  const windows = normalizePeakWindows(peakWindows);
  const nowMin = minutesOfDay(now);
  const peak = windows.some((w) => inWindow(nowMin, w));
  let next: Date;
  if (peak) {
    const found = windows.find((w) => inWindow(nowMin, w)) as [number, number];
    const [, end] = found;
    const [start] = found;
    const dayOffset = start < end ? 0 : nowMin >= start ? 1 : 0;
    next = atMinutes(now, end, dayOffset);
  } else {
    // 离 nowMin 最近的下一段起点（跨天则折入 +1440 的单值比较）。
    let best: number | null = null;
    for (const [start] of windows) {
      const cand = start > nowMin ? start : start + 1440;
      if (best === null || cand < best) best = cand;
    }
    next = atMinutes(now, best as number, 0);
  }
  return {
    period: peak ? 'peak' : 'offpeak',
    windows: windows.map(([s, e]) => [fmtHHMM(s), fmtHHMM(e)] as [string, string]),
    nextAt: next.getTime(),
  };
}

export function readApiKey(dshHome: string): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey.trim();
  try {
    const text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)/);
      if (m) return m[1] as string;
    }
  } catch { /* 无凭据文件 */ }
  return '';
}

/// 当前默认模型（~/.dsh/settings.yaml 的 agent-default-model.model），
/// 决定按哪一档价格估算本轮费用。
export function readActiveModel(dshHome: string): string {
  try {
    const text = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
    const m = text.match(/^\s*model\s*:\s*(\S+)/m);
    if (m) return m[1] as string;
  } catch { /* 无 settings.yaml */ }
  return '';
}

function balanceEndpoint(): string {
  if (process.env.DEEPSEEK_BALANCE_URL) return process.env.DEEPSEEK_BALANCE_URL as string;
  const base = (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return base + '/user/balance';
}

function fetchJson(url: string, apiKey: string, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': 'DSH-Desktop' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const hint = body.slice(0, 200).trim();
            return reject(new Error('HTTP ' + res.statusCode + (hint ? '：' + hint : '')));
          }
          try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 解析失败')); }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

type PriceOverride = Record<string, unknown>;

/// 单档价格合并：回退档 <- 模型默认档 <- 用户覆盖（双档 {peak,offpeak} 或旧
/// 扁平覆盖），供 refreshBalance 与自定义价格 UI 共用。
export function tierPrices(base: PriceOverride | null | undefined, override: PriceOverride | null | undefined, tier: string): TierPrice {
  const ovDual =
    !!override &&
    typeof override.peak === 'object' &&
    override.peak !== null &&
    typeof override.offpeak === 'object' &&
    override.offpeak !== null;
  const src = ovDual ? ((override as Record<string, PriceOverride>)[tier] || {}) : (override || {});
  const fallbackTier = (FALLBACK_PRICES as Record<string, TierPrice>)[tier] || FALLBACK_PRICES;
  const baseTier = base && (base[tier] as PriceOverride | undefined) ? (base[tier] as PriceOverride) : base || {};
  return { ...fallbackTier, ...baseTier, ...(src || {}) } as TierPrice;
}

/// 自定义价格清洗（dsh:balance-prices-set）：三字段必须全部是 0~1000 的有限
/// 数字，档位必须存在；否则抛错（防 NaN/负数/超大值/畸形结构写进 settings.json）。
export function sanitizePrices(prices: unknown): { peak: TierPrice; offpeak: TierPrice } {
  const p = prices as PriceOverride | null;
  const tier = (src: unknown, label: string): TierPrice => {
    if (!src || typeof src !== 'object') throw new Error(label + ' 档位缺失');
    const rec = src as Record<string, unknown>;
    const out: TierPrice = { cacheMiss: 0, cacheHit: 0, output: 0 };
    for (const key of ['cacheMiss', 'cacheHit', 'output'] as const) {
      const v = Number(rec[key]);
      if (!Number.isFinite(v) || v < 0 || v > 1000) {
        throw new Error(label + ' 的 ' + key + ' 必须是 0~1000 的数字');
      }
      out[key] = v;
    }
    return out;
  };
  return { peak: tier(p && p.peak, '高峰'), offpeak: tier(p && p.offpeak, '空闲') };
}

export interface BalanceInfo {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface BalanceResult {
  ok: boolean;
  isAvailable?: boolean;
  balances: BalanceInfo[];
  error?: string;
  prices: Record<string, { peak: TierPrice; offpeak: TierPrice }>;
}

interface RawBalanceResponse {
  is_available?: unknown;
  balance_infos?: Array<Record<string, unknown>>;
}

/// 返回 { ok, isAvailable?, balances: [{currency,total,granted,toppedUp}], error?, prices }
export async function queryBalance(dshHome: string): Promise<BalanceResult> {
  const key = readApiKey(dshHome);
  if (!key) return { ok: false, error: 'no-key', balances: [], prices: DEFAULT_PRICES };
  try {
    const data = (await fetchJson(balanceEndpoint(), key)) as RawBalanceResponse;
    const balances = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((b) => ({
          currency: String(b.currency || ''),
          total: Number(b.total_balance) || 0,
          granted: Number(b.granted_balance) || 0,
          toppedUp: Number(b.topped_up_balance) || 0,
        }))
      : [];
    return { ok: true, isAvailable: !!data.is_available, balances, prices: DEFAULT_PRICES };
  } catch (err) {
    return { ok: false, error: String((err instanceof Error && err.message) || err), balances: [], prices: DEFAULT_PRICES };
  }
}
