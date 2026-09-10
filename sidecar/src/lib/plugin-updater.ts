// legacy/electron/plugin-updater.js — 内置插件上游更新引擎。
// 忠实移植自legacy/electron/plugin-updater.js（安全设计与覆盖层规则见原文件头注释）：
//   · checkPluginUpdates(ctx, sources)   —— 静默检测（镜像链+TTL+24h 节流）
//   · applyBuiltinPluginUpdate(ctx, ...) —— 下载到覆盖层并尽力拷入 profile
//   · autoApplyUpdates(ctx, sources)     —— 自动更新流程（默认关闭）

import path from 'node:path';
import fs from 'node:fs';

import * as updater from './updater.js';
import type { UpdaterCtx } from './updater.js';

/// 内存缓存：同一启动周期内重复查询（更新标签页刷新）不重复打 npm。
export const PLUGIN_CHECK_TTL_MS = 10 * 60 * 1000;
/// 落盘节流：跨启动的自动检查频率（settings.pluginUpdateCheckedAt）。
export const PLUGIN_CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const NPM_VIEW_TIMEOUT_MS = 45 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

let checkCache: { at: number; list: CheckItem[] | null } = { at: 0, list: null };

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export type UpdateSourceSpec = { npm?: string } | { github?: string };

export interface PluginUpdateCtx extends UpdaterCtx {
  runNpm?: typeof updater.runNpm;
  resolveLatest?: (ctx: PluginUpdateCtx, source: UpdateSourceSpec) => Promise<string | null>;
}

export interface PluginSource {
  id: string;
  name: string;
  assetsDir: string;
  update?: UpdateSourceSpec;
}

export function overlayRoot(ctx: PluginUpdateCtx): string {
  return path.join(ctx.userDataDir, 'builtin-plugin-updates');
}

export function overlayDirOf(ctx: PluginUpdateCtx, dir: string): string {
  return path.join(overlayRoot(ctx), dir);
}

export function stagingRoot(ctx: PluginUpdateCtx): string {
  return path.join(ctx.userDataDir, 'plugin-update-staging');
}

// ---------------------------------------------------------------------------
// 源解析（source = { npm: 包名 } | { github: 'owner/repo' }）
// ---------------------------------------------------------------------------

export function sourceKind(source: unknown): 'npm' | 'github' | null {
  const s = source as Record<string, unknown> | null;
  if (s && s.npm) return 'npm';
  if (s && s.github) return 'github';
  return null;
}

export function sourceName(source: unknown): string {
  const s = source as Record<string, unknown> | null;
  return s && s.npm ? (s.npm as string) : s && s.github ? (s.github as string) : '';
}

// ---------------------------------------------------------------------------
// 版本读取 / 判定
// ---------------------------------------------------------------------------

export function versionOfDir(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/// 当前实际加载版本：profile 副本优先，资产副本回退。
export function currentVersionOf(ctx: PluginUpdateCtx, assetsDir: string, source: unknown, profileDirP: string | null): string | null {
  void ctx;
  const name = sourceName(source);
  if (profileDirP && name) {
    const v = versionOfDir(path.join(profileDirP, 'node_modules', ...name.split('/')));
    if (v) return v;
  }
  return versionOfDir(assetsDir);
}

export function hasUpdateOf(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  return updater.compareVersions(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// npm / GitHub latest
// ---------------------------------------------------------------------------

/// npm 包最新版本（复用 updater 的镜像源链，主源失败自动切镜像）。
export async function npmLatest(ctx: PluginUpdateCtx, name: string): Promise<string> {
  const run = ctx.runNpm || updater.runNpm;
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const errors: string[] = [];
  for (const registry of chain) {
    const args = ['view', name, 'version'];
    if (registry) args.push('--registry=' + registry);
    try {
      const out = await run(ctx, args, { timeoutMs: NPM_VIEW_TIMEOUT_MS });
      const lines = String(out || '').trim().split(/\r?\n/).filter(Boolean);
      const v = (lines[lines.length - 1] as string).trim();
      if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('无法解析版本号: ' + JSON.stringify(v));
      return v;
    } catch (err) {
      errors.push((registry || '默认源') + ': ' + String((err instanceof Error && err.message) || err));
    }
  }
  throw new Error('无法获取 ' + name + ' 的最新版本（' + errors.join('；') + '）');
}

async function fetchJsonAny(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-eac' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/// GitHub 仓库最新发布（releases/latest 优先，tags 兜底）。
export async function githubLatest(ctx: PluginUpdateCtx, repo: string): Promise<string | null> {
  try {
    const rel = await fetchJsonAny('https://api.github.com/repos/' + encodeURIComponent(repo) + '/releases/latest');
    if (rel && typeof rel.tag_name === 'string' && rel.tag_name) return rel.tag_name.replace(/^v/, '');
  } catch (err) {
    ctx.log('plugin-update', 'GitHub releases/latest 失败（' + repo + '）: ' + String((err instanceof Error && err.message) || err));
  }
  try {
    const tags = await fetchJsonAny('https://api.github.com/repos/' + encodeURIComponent(repo) + '/tags');
    if (Array.isArray(tags) && tags.length > 0 && tags[0] && typeof tags[0].name === 'string') {
      return (tags[0].name as string).replace(/^v/, '');
    }
  } catch (err) {
    ctx.log('plugin-update', 'GitHub tags 失败（' + repo + '）: ' + String((err instanceof Error && err.message) || err));
  }
  return null;
}

export async function resolveLatest(ctx: PluginUpdateCtx, source: UpdateSourceSpec): Promise<string | null> {
  if (typeof ctx.resolveLatest === 'function') return ctx.resolveLatest(ctx, source);
  const s = source as Record<string, unknown> | null;
  if (s && s.npm) return npmLatest(ctx, s.npm as string);
  if (s && s.github) return githubLatest(ctx, s.github as string);
  return null;
}

// ---------------------------------------------------------------------------
// 节流 / 跳过版本
// ---------------------------------------------------------------------------

export function dueForCheck(ctx: PluginUpdateCtx, now: number): boolean {
  try {
    const s = updater.loadSettings(ctx);
    const at = s.pluginUpdateCheckedAt ? Date.parse(s.pluginUpdateCheckedAt as string) : 0;
    return !at || now - at >= PLUGIN_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function markChecked(ctx: PluginUpdateCtx): void {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginUpdateCheckedAt = new Date().toISOString();
    updater.saveSettings(ctx, s);
  } catch {
    /* 写失败不影响 */
  }
}

export function isVersionSkipped(ctx: PluginUpdateCtx, id: string, version: string): boolean {
  try {
    const s = updater.loadSettings(ctx);
    return ((s.pluginSkipVersions || {}) as Record<string, string>)[id] === version;
  } catch {
    return false;
  }
}

export function rememberSkip(ctx: PluginUpdateCtx, id: string, version: string): void {
  try {
    const s = updater.loadSettings(ctx);
    s.pluginSkipVersions = s.pluginSkipVersions || {};
    (s.pluginSkipVersions as Record<string, string>)[id] = version;
    updater.saveSettings(ctx, s);
  } catch {
    /* 写失败不影响 */
  }
}

export function isAutoUpdateEnabled(ctx: PluginUpdateCtx): boolean {
  try {
    const s = updater.loadSettings(ctx);
    return s.pluginAutoUpdate === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 兼容性门槛
// ---------------------------------------------------------------------------

/// engines.dsh 门槛：新包声明的最低内核要求高于当前生效 dsh 版本 → 拒绝。
/// 范围只取最低下界（>= / ^ 语义下的起点），保守可比。
/// 返回拒绝原因（null = 放行）。
export function enginesGate(manifest: unknown, activeDshVersion: string | null): string | null {
  try {
    const m0 = manifest as Record<string, any> | null;
    const eng = m0 && m0.engines;
    if (!eng || !eng.dsh) return null;
    const req = String(eng.dsh).trim();
    if (!req) return null;
    const m = /([<>]=?)?\s*(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(req);
    if (!m) return null;
    const min = m[2] as string;
    if (!activeDshVersion) return null;
    if (updater.compareVersions(min, activeDshVersion) > 0) {
      return '该插件新版本要求 dsh 内核 >= ' + min + '，当前内核为 ' + activeDshVersion + '，请先更新内核再更新此插件';
    }
  } catch {
    /* 解析失败按放行处理，交给守护启动兜底 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 全量检测
// ---------------------------------------------------------------------------

export interface CheckItem {
  id: string;
  name: string;
  source: 'npm' | 'github' | null;
  sourceName: string;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  skipped: boolean;
  error: string | null;
}

export interface CheckOpts {
  force?: boolean;
  profileDirP?: string;
}

/// 检查全部有更新源的内置插件。
export async function checkPluginUpdates(ctx: PluginUpdateCtx, sources: PluginSource[], opts: CheckOpts = {}): Promise<CheckItem[]> {
  const now = Date.now();
  if (!opts.force && checkCache.list && now - checkCache.at < PLUGIN_CHECK_TTL_MS) return checkCache.list;
  const list = await Promise.all(
    sources.map(async (s): Promise<CheckItem> => {
      const out: CheckItem = {
        id: s.id,
        name: s.name,
        source: sourceKind(s.update),
        sourceName: sourceName(s.update),
        current: null,
        latest: null,
        hasUpdate: false,
        skipped: false,
        error: null,
      };
      try {
        out.current = currentVersionOf(ctx, s.assetsDir, s.update, opts.profileDirP || null);
        out.latest = await resolveLatest(ctx, s.update as UpdateSourceSpec);
        out.hasUpdate = hasUpdateOf(out.current, out.latest);
        if (out.hasUpdate && isVersionSkipped(ctx, s.id, out.latest as string)) out.skipped = true;
      } catch (err) {
        out.error = String((err instanceof Error && err.message) || err);
      }
      return out;
    }),
  );
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  checkCache = { at: now, list };
  return list;
}

export function invalidateCache(): void {
  checkCache = { at: 0, list: null };
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

function copyTree(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyTree(s, d);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

/// GitHub 分发源下载候选：codeload tarball（tag 带不带 v 前缀都试）。
export function githubTarballCandidates(repo: string, latest: string): string[] {
  const base = 'https://codeload.github.com/' + encodeURIComponent(repo) + '/tar.gz/refs/tags/';
  return [base + 'v' + latest, base + latest];
}

/// 安装完成后定位包目录：npm 源按包名；GitHub 源扫描直子目录。
export function findInstalledDir(staging: string, update: UpdateSourceSpec): string | null {
  const nm = path.join(staging, 'node_modules');
  const u = update as Record<string, string>;
  if (u.npm) {
    const dir = path.join(nm, ...u.npm.split('/'));
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
  }
  if (!fs.existsSync(nm)) return null;
  const candidates = fs
    .readdirSync(nm, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(nm, e.name))
    .filter((dir) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
        return pkg.name === path.basename(dir);
      } catch {
        return false;
      }
    });
  if (candidates.length === 1) return candidates[0] as string;
  // 多个候选（异常结构）时选版本号与目标一致的。
  return candidates.find((dir) => versionOfDir(dir) !== null) || null;
}

export interface ApplyBuiltinOpts {
  latest?: string;
  profileDirP?: string;
  guard?: { snapshot: (reason: string) => { id: string } | null };
  copyIntoProfile?: (overlayDir: string, name: string) => void;
  bundledDshVersion?: string;
  log?: (tag: string, msg: string) => void;
}

export interface ApplyResult {
  ok: boolean;
  current: string | null;
  latest: string | null;
  noop?: boolean;
  profileCopied?: boolean;
  restartRequired?: boolean;
}

/// 把某个内置插件更新到 latest。
export async function applyBuiltinPluginUpdate(ctx: PluginUpdateCtx, source: PluginSource, opts: ApplyBuiltinOpts = {}): Promise<ApplyResult> {
  const log = opts.log || ctx.log;
  const update = source.update as UpdateSourceSpec;
  const name = sourceName(update);
  const latest = opts.latest || (await resolveLatest(ctx, update));
  if (!latest) throw new Error('无法获取 ' + name + ' 的最新版本');
  const current = currentVersionOf(ctx, source.assetsDir, update, opts.profileDirP || null);
  if (!hasUpdateOf(current, latest)) return { ok: true, current, latest, noop: true };

  // 1) 保护快照（失败即中止，保证可回滚）
  if (opts.guard) {
    const snap = opts.guard.snapshot('pre-update:builtin:' + source.id);
    if (!snap) throw new Error('更新前保护快照失败，已中止更新以保证可回滚');
  }

  // 2) 下载到 staging：npm 源走 registry（镜像链）；GitHub 源走 codeload
  //    tarball URL（npm 直接解包安装）。--ignore-scripts 绝不执行第三方脚本。
  const stagingRootDir = stagingRoot(ctx);
  fs.rmSync(stagingRootDir, { recursive: true, force: true });
  fs.mkdirSync(stagingRootDir, { recursive: true });
  const staging = path.join(stagingRootDir, 'pkg');
  const u = update as Record<string, string>;
  const candidates = u.npm ? [u.npm + '@' + latest] : githubTarballCandidates(u.github as string, latest);
  const chain = updater.registryChain(await updater.currentRegistry(ctx));
  const run = ctx.runNpm || updater.runNpm;
  const errors: string[] = [];
  let installed: string | null = null;
  outer: for (const spec of candidates) {
    for (const registry of chain) {
      const args = [
        'install', '--prefix', staging, spec,
        '--save-exact', '--omit=dev', '--ignore-scripts',
        '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error',
      ];
      if (registry) args.push('--registry=' + registry);
      try {
        await run(ctx, args, { timeoutMs: NPM_INSTALL_TIMEOUT_MS });
        const dir = findInstalledDir(staging, update);
        if (!dir) throw new Error('安装完成但未找到包目录');
        installed = dir;
        break outer;
      } catch (err) {
        errors.push((registry || '默认源') + ' × ' + spec + ': ' + String((err instanceof Error && err.message) || err));
      }
    }
  }
  if (!installed) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('下载失败（' + errors.join('；') + '）');
  }

  // 3) 校验：engines.dsh 门槛
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  if (!manifest) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('更新包缺少 package.json，已中止');
  }
  const activeDsh = opts.bundledDshVersion || updater.activeVersion(ctx);
  const gate = enginesGate(manifest, activeDsh);
  if (gate) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error(gate);
  }

  // 4) 合并进覆盖层：以当前资产副本为底（保留 EAC 附加文件），npm 包覆盖
  const merged = path.join(stagingRootDir, 'merged');
  fs.rmSync(merged, { recursive: true, force: true });
  copyTree(source.assetsDir, merged);
  copyTree(installed as string, merged);
  // 上游 bump 依赖时一并带上（仅顶层直依赖，绝不删除旧文件；主包已合并跳过）。
  const stagedNms = path.join(staging, 'node_modules');
  if (fs.existsSync(stagedNms)) {
    for (const e of fs.readdirSync(stagedNms, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === path.basename(installed as string)) continue;
      copyTree(path.join(stagedNms, e.name), path.join(merged, 'node_modules', e.name));
    }
  }
  const vNew = versionOfDir(merged);
  if (!vNew) {
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('更新包缺少版本号，已中止');
  }
  const overlay = overlayDirOf(ctx, path.basename(source.assetsDir));
  const bak = overlay + '.bak-' + Date.now();
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, bak);
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    fs.renameSync(merged, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(bak)) fs.renameSync(bak, overlay);
    } catch {
      /* 尽力回滚 */
    }
    fs.rmSync(stagingRootDir, { recursive: true, force: true });
    throw new Error('切换覆盖层失败: ' + String((err instanceof Error && err.message) || err));
  }
  if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });

  // 5) 拷入 profile（尽力而为：服务运行中撞文件锁时保留覆盖层，下次启动同步）
  let profileCopied = false;
  if (typeof opts.copyIntoProfile === 'function') {
    try {
      opts.copyIntoProfile(overlay, source.name);
      profileCopied = true;
    } catch (err) {
      log('plugin-update', '更新 ' + source.id + ' 已下载，但写 profile 失败（服务运行中？）: ' + String((err instanceof Error && err.message) || err));
    }
  }

  fs.rmSync(stagingRootDir, { recursive: true, force: true });
  invalidateCache();
  log('plugin-update', '内置插件已更新 ' + source.id + '（' + source.name + '）: ' + (current || '?') + ' → ' + vNew + (profileCopied ? '' : '（覆盖层已就绪，重启服务生效）'));
  return { ok: true, current, latest: vNew, profileCopied, restartRequired: !profileCopied };
}

export interface AutoApplyOpts extends CheckOpts, ApplyBuiltinOpts {}

export interface AutoApplyResult {
  done: { id: string; name: string; current: string | null; latest: string | null }[];
  failed: { id: string; name: string; error: string }[];
}

/// 自动更新流程（settings.pluginAutoUpdate 开启时由主进程调用）：
/// 逐个下载有更新的内置插件到覆盖层，失败不阻塞其余插件。
export async function autoApplyUpdates(ctx: PluginUpdateCtx, sources: PluginSource[], opts: AutoApplyOpts = {}): Promise<AutoApplyResult> {
  const list = await checkPluginUpdates(ctx, sources, opts);
  const done: AutoApplyResult['done'] = [];
  const failed: AutoApplyResult['failed'] = [];
  for (const item of list) {
    if (!item.hasUpdate || item.skipped) continue;
    const source = sources.find((s) => s.id === item.id);
    if (!source) continue;
    try {
      const r = await applyBuiltinPluginUpdate(ctx, source, { ...opts, latest: item.latest as string });
      if (r.noop) continue;
      done.push({ id: item.id, name: item.name, current: item.current, latest: r.latest });
    } catch (err) {
      failed.push({ id: item.id, name: item.name, error: String((err instanceof Error && err.message) || err) });
    }
  }
  return { done, failed };
}
