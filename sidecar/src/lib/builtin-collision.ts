// 内置插件 vs 市场安装的同名包迁移（v4.2）。
// 忠实移植自legacy/electron/builtin-collision.js：只动插件层/配置层（package.json /
// cordis.patch.yml），保留用户自建 link:/file: 本地链接；内部吞错记日志。

import fs from 'node:fs';
import path from 'node:path';

/// 解析一行块内的 name（跟随 id 行的缩进行里找 name:）。
function rowNameOf(lines: string[], startIdx: number): string | null {
  for (let j = startIdx + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (/^\s*-/.test(l)) break; // 下一个行项
    if (l.trim() === '') break; // 空行
    if (!/^\s+/.test(l)) break; // 顶层非缩进行（注释等）
    const m = /name:\s*['"]?([^'"\s]+)['"]?\s*/.exec(l);
    if (m) return m[1] as string;
  }
  return null;
}

/// 跳过一行块（id 行 + 其后的缩进配置行）；返回下一个要处理的下标。
function blockEnd(lines: string[], startIdx: number): number {
  let j = startIdx + 1;
  while (j < lines.length) {
    const l = lines[j] as string;
    if (/^\s*-/.test(l)) break;
    if (l.trim() === '') break;
    if (!/^\s+/.test(l)) break;
    j += 1;
  }
  return j;
}

export interface StripResult {
  patch: string;
  removed: string[];
}

/// 从 patch 文本里移除 name/id 匹配 target 的 patch 行（顶层 + insert 内层）。
export function stripPatchRows(patch: unknown, targetName: string, targetId: string): StripResult {
  const lines = String(patch || '').split(/\r?\n/);
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*id:\s*([\w.-]+)\s*$/.exec(lines[i] as string);
    if (m === null) {
      out.push(lines[i] as string);
      continue;
    }
    const id = m[2] as string;
    const name = rowNameOf(lines, i);
    if (id === targetId || (targetName !== '' && name === targetName)) {
      removed.push(id);
      i = blockEnd(lines, i) - 1;
      continue;
    }
    out.push(lines[i] as string);
  }
  let text = out.join('\n');
  if (!/^[\s\S]*\n$/.test(text)) text += '\n';
  text = text.replace(/\n{3,}/g, '\n\n');
  return { patch: text, removed };
}

export interface MarketDupOpts {
  log?: (m: string) => void;
}

export interface MarketDupResult {
  ok: boolean;
  changed: boolean;
  removedDep: string[];
  removedBundles: string[];
  removedRows: string[];
}

interface ProfilePackage {
  dependencies?: Record<string, unknown>;
  dsh?: { profile?: { bundles?: unknown } };
}

/// 移除 profile 里与内置插件同名的市场安装残留。
export function removeMarketDuplicate(profileDir: string, builtinName: string, opts: MarketDupOpts = {}): MarketDupResult {
  const log = opts.log || (() => {});
  const removedDep: string[] = [];
  const removedBundles: string[] = [];
  let removedRows: string[] = [];
  let changed = false;
  try {
    const pkgFile = path.join(profileDir, 'package.json');
    let dirty = false;
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as ProfilePackage;
      if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, builtinName)) {
        const spec = String(pkg.dependencies[builtinName] || '');
        // 用户自建 link:/file: 本地链接保留（fork/开发目录），只清市场版。
        if (!spec.startsWith('link:') && !spec.startsWith('file:')) {
          delete pkg.dependencies[builtinName];
          removedDep.push(builtinName);
          dirty = true;
        }
      }
      const bundles = pkg.dsh?.profile?.bundles;
      if (pkg.dsh && pkg.dsh.profile && Array.isArray(bundles) && bundles.includes(builtinName)) {
        pkg.dsh.profile.bundles = (bundles as string[]).filter((b) => b !== builtinName);
        removedBundles.push(builtinName);
        dirty = true;
      }
      if (dirty) {
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        changed = true;
        log(`移除市场版依赖残留 ${builtinName}（package.json）`);
      }
    }
    // 仅当确实移除了市场依赖/捆绑时才剥 patch 行：否则会把上一轮同步
    // 自己写回的内置行当成「市场残留」反复剥掉重写，导致接管通知每次启动都弹。
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    if (dirty && fs.existsSync(patchFile)) {
      const patch = fs.readFileSync(patchFile, 'utf8');
      const { patch: patched, removed } = stripPatchRows(patch, builtinName, builtinName.split('/').pop() ?? '');
      if (removed.length) {
        fs.writeFileSync(patchFile, patched, 'utf8');
        removedRows = removed;
        changed = true;
        log(`移除市场版 patch 残留行: ${removed.join(', ')}`);
      }
    }
    return { ok: true, changed, removedDep, removedBundles, removedRows };
  } catch (err) {
    log('内置插件同名迁移失败: ' + String((err instanceof Error && err.message) || err));
    return { ok: false, changed, removedDep, removedBundles, removedRows };
  }
}
