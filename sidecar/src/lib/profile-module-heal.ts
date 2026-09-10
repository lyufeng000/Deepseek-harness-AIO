// Profile node_modules shadowing heal.
// 忠实移植自legacy/electron/profile-module-heal.js（背景见原文件头注释）：
// 移除 profile node_modules 中遮蔽 fallback junction 的真实目录拷贝与
// profile 内部 .pnpm 链接，让模块解析回落到唯一实例；无 fallback 对应的
// 本地包与指向外部 store 的 link: 开发链接不动。返回被移除的包名。

import fs from 'node:fs';
import path from 'node:path';

type LogFn = (m: string) => void;

function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

export function healProfileModuleShadowing(
  home: string,
  profile = 'web',
  log: LogFn = () => {},
): string[] {
  const fallbackDir = path.join(home, 'profiles', 'node_modules');
  const profileModulesDir = path.join(home, 'profiles', profile, 'node_modules');

  // Collect every package name the fallback exposes (scoped + unscoped).
  const names: { full: string; rel: string }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fallbackDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      names.push({ full: entry.name, rel: entry.name });
    } else if (entry.isDirectory()) {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
      }
    }
  }

  const removed: string[] = [];
  for (const { full, rel } of names) {
    // Issue #7 guard：fallback 链接不健康（目标缺 package.json / 悬空）时
    // 保留 shadow 拷贝 —— 它可能是最后一份健康副本。
    const fallbackEntry = path.join(fallbackDir, rel);
    let fallbackHealthy = false;
    try {
      const st = fs.lstatSync(fallbackEntry);
      const target = st.isSymbolicLink() ? fs.realpathSync(fallbackEntry) : fallbackEntry;
      fallbackHealthy = fs.existsSync(path.join(target, 'package.json'));
    } catch {
      fallbackHealthy = false;
    }
    if (!fallbackHealthy) {
      log('fallback entry unhealthy, keeping shadow copy: ' + full);
      continue;
    }
    const shadow = path.join(profileModulesDir, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(shadow);
    } catch {
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // Real directory copy (pnpm nodeLinker: hoisted) shadows the fallback.
      fs.rmSync(shadow, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      removed.push(full);
      log('removed shadowing copy: ' + full);
      continue;
    }
    if (stat.isSymbolicLink()) {
      // pnpm-managed link whose store lives INSIDE this profile's own .pnpm
      // also shadows the fallback with a second instance. Deliberate link:
      // dev installs point elsewhere — those stay (report only).
      // Windows junctions need unlink (rmSync force-only throws EISDIR).
      const target = safeReadlink(shadow);
      if (!target) continue;
      const norm = (p: string): string => String(p).replace(/\//g, '\\').toLowerCase();
      const storeRoot = norm(path.join(profileModulesDir, '.pnpm'));
      if (norm(path.resolve(path.dirname(shadow), target)).startsWith(storeRoot)) {
        try {
          fs.unlinkSync(shadow);
        } catch {
          fs.rmSync(shadow, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
        }
        removed.push(full);
        log('removed shadowing pnpm link: ' + full);
      }
    }
  }
  return removed;
}
