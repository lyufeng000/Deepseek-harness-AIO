// koffi FFI 预检与目录选择器降级（integrated from upstream dsh_desktop）。
// 忠实移植自legacy/electron/koffi-preflight.js：本模块只做纯逻辑与文件管理，
// 进程/文件系统依赖全部注入（DI），便于单元测试。

import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

/// 自动生成的 overlay 文件首行 marker：clear 时只删自己写的文件，
/// 用户手工维护的同名 overlay 永不触碰。
export const PICKER_BROWSE_OVERLAY_MARKER = '# DSH-DESKTOP-AUTO: picker browse fallback';

export interface SyncSpawnResult {
  stdout?: string;
  stderr?: string;
  error?: { message: string } | null;
  status: number | null;
}

export interface SyncPreflightDeps {
  spawnSync: (exe: string, args: string[], opts: { timeout: number; windowsHide: boolean; encoding: string }) => SyncSpawnResult;
  nodeExe: string;
  script: string;
  existsSync?: (p: string) => boolean;
  log?: (m: string) => void;
  timeout?: number;
}

/// 运行 koffi 冒烟探针（同步版，保留给脚本/测试场景）。
/// 返回 true=通过（或跳过），false=失败（应启用降级 overlay）。
export function runKoffiPreflight(deps: SyncPreflightDeps): boolean {
  const {
    spawnSync, nodeExe, script,
    existsSync: exists = fs.existsSync,
    log = () => {},
    timeout = 20000,
  } = deps;
  if (!exists(script)) {
    log('koffi 预检脚本不存在，跳过（视为通过）');
    return true;
  }
  try {
    const r = spawnSync(nodeExe, [script], { timeout, windowsHide: true, encoding: 'utf8' });
    const output = String((r.stdout || '') + (r.stderr || '')).trim();
    if (r.error) {
      log('koffi 预检无法执行: ' + r.error.message);
      return false;
    }
    if (r.status === 0) {
      log('koffi 预检通过');
      return true;
    }
    log(`koffi 预检失败（退出码 0x${((r.status ?? 0) >>> 0).toString(16)}）: ${output.slice(0, 400)}`);
    return false;
  } catch (err) {
    log('koffi 预检异常: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

export interface AsyncChild {
  stdout: { on: (ev: string, cb: (c: unknown) => void) => void };
  stderr: { on: (ev: string, cb: (c: unknown) => void) => void };
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  kill: () => unknown;
}

export interface AsyncPreflightDeps {
  spawn: (exe: string, args: string[], opts: { windowsHide: boolean; stdio: string[] }) => AsyncChild;
  nodeExe: string;
  script: string;
  existsSync?: (p: string) => boolean;
  log?: (m: string) => void;
  timeout?: number;
}

/// V4：异步版探针（spawn 而非 spawnSync），语义与同步版一致。
export function runKoffiPreflightAsync(deps: AsyncPreflightDeps): Promise<boolean> {
  const {
    spawn, nodeExe, script,
    existsSync: exists = fs.existsSync,
    log = () => {},
    timeout = 20000,
  } = deps;
  return new Promise((resolve) => {
    if (!exists(script)) {
      log('koffi 预检脚本不存在，跳过（视为通过）');
      return resolve(true);
    }
    let settled = false;
    const finish = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    let child: AsyncChild;
    try {
      child = spawn(nodeExe, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log('koffi 预检无法执行: ' + (err instanceof Error ? err.message : String(err)));
      return resolve(false);
    }
    let output = '';
    const onData = (c: unknown): void => { output += String(c); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log('koffi 预检超时，按失败处理');
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, timeout);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as Error;
      log('koffi 预检无法执行: ' + (e instanceof Error ? e.message : String(e)));
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const c = code as number | null;
      if (c === 0) {
        log('koffi 预检通过');
        return finish(true);
      }
      log(`koffi 预检失败（退出码 0x${((c ?? 0) >>> 0).toString(16)}）: ${output.trim().slice(0, 400)}`);
      finish(false);
    });
  });
}

/// 降级 overlay 的完整内容（纯函数，便于测试）。
export function buildPickerOverlayContent(): string {
  return [
    PICKER_BROWSE_OVERLAY_MARKER,
    '# koffi 预检未通过：禁用 native 目录选择器，改用浏览器内 browse 选择器。',
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: directory-picker-browse-client',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n');
}

export interface OverlayFs {
  readFileSync: (p: string, enc: string) => string;
  writeFileSync: (p: string, data: string) => void;
  existsSync: (p: string) => boolean;
  rmSync: (p: string, opts: { force: boolean }) => void;
}

export interface OverlayDeps {
  file: string;
  fs?: OverlayFs;
  log?: (m: string) => void;
}

/// 写入降级 overlay（幂等：内容相同不重写）。返回 overlay 路径，失败返回 null。
export function enablePickerBrowseOverlay({ file, fs: fsys = fs as unknown as OverlayFs, log = () => {} }: OverlayDeps): string | null {
  const content = buildPickerOverlayContent();
  try {
    let prev = '';
    try { prev = fsys.readFileSync(file, 'utf8'); } catch { /* 不存在 */ }
    if (prev !== content) fsys.writeFileSync(file, content);
    log('已启用目录选择器降级 overlay: ' + file);
    return file;
  } catch (err) {
    log('写入目录选择器降级 overlay 失败: ' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

/// 移除自动生成的 overlay（预检恢复后调用）。只删带 marker 的文件；
/// 返回是否实际删除。
export function clearAutoPickerBrowseOverlay({ file, fs: fsys = fs as unknown as OverlayFs, log = () => {} }: OverlayDeps): boolean {
  try {
    if (!fsys.existsSync(file)) return false;
    const text = fsys.readFileSync(file, 'utf8');
    if (!text.includes(PICKER_BROWSE_OVERLAY_MARKER)) return false;
    fsys.rmSync(file, { force: true });
    log('koffi 预检已恢复，移除目录选择器降级 overlay');
    return true;
  } catch (err) {
    log('移除目录选择器降级 overlay 失败: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}
