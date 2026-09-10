import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, assertPlainPath, fileHash, type Edition } from './client-update';

export interface Transaction {
  id: string; root: string; userData: string; dshHome: string; directory: string;
  file: string; sha256: string; version: string; edition: Edition; parentPid: number;
  phase: string; swapped: string[]; original: string[]; hadData: string[];
  candidatePid?: number; error?: string;
}
const managed = ['resources', 'DSHEAC AIO.exe', 'uninstall.exe', '.dsh-portable'];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export type LinkPolicy = 'reject' | 'preserve';
function copyEntry(source: string, destination: string, exclude: Set<string>, links: LinkPolicy): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    // Program trees must never carry links. Backups of live user data may
    // contain legitimate junctions/symlinks, so those are preserved verbatim.
    if (links === 'reject') throw new Error('更新目录包含链接，已拒绝。');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const target = fs.readlinkSync(source);
    let directory = false;
    try { directory = fs.statSync(source).isDirectory(); } catch { /* dangling link is copied as a file link */ }
    fs.symlinkSync(target, destination, directory ? (path.isAbsolute(target) ? 'junction' : 'dir') : 'file');
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (!exclude.has(name)) copyEntry(path.join(source, name), path.join(destination, name), exclude, links);
    }
  } else if (stat.isFile()) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
  else throw new Error('更新目录包含不支持的文件。');
}
export function copyTree(source: string, destination: string, exclude = new Set<string>(), options: { links?: LinkPolicy } = {}): void {
  assertPlainPath(source); assertPlainPath(destination);
  copyEntry(source, destination, exclude, options.links ?? 'reject');
}
function assertPlainAncestors(file: string): void {
  let current = path.resolve(path.dirname(file));
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('更新路径不能包含链接。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function boundedRemove(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝越界清理。');
  // The entry itself may be a preserved data link; only its ancestors must be plain.
  assertPlainAncestors(target); fs.rmSync(target, { recursive: true, force: true });
}
function save(tx: Transaction): void { atomicJson(path.join(tx.directory, 'transaction.json'), tx); }
export function validateTransaction(tx: Transaction, directory: string): void {
  if (!/^[a-f0-9-]{36}$/.test(tx.id) || path.resolve(tx.directory) !== path.resolve(directory)
    || path.resolve(directory) !== path.join(path.resolve(tx.userData), 'client-update', 'transaction')
    || !['installer', 'portable'].includes(tx.edition) || !/^\d+\.\d+\.\d+$/.test(tx.version)
    || !/^[a-f0-9]{64}$/.test(tx.sha256)) throw new Error('更新事务无效。');
  for (const item of [tx.root, tx.userData, tx.dshHome, directory, tx.file]) assertPlainPath(item);
  if (path.parse(tx.root).root === path.resolve(tx.root)) throw new Error('拒绝根目录更新。');
  if (!tx.swapped.every(name => managed.includes(name)) || !tx.original.every(name => managed.includes(name))) throw new Error('更新清单无效。');
}

export async function prepareTransaction(input: Omit<Transaction, 'id' | 'directory' | 'phase' | 'swapped' | 'original' | 'hadData'>, nodeExe: string, appRoot: string): Promise<Transaction> {
  const directory = path.join(input.userData, 'client-update', 'transaction');
  assertPlainPath(directory);
  const previous = readJson(path.join(directory, 'transaction.json')) as Transaction | null;
  if (previous && !['complete', 'rolled-back', 'aborted'].includes(previous.phase)) throw new Error('存在未完成的更新，请先恢复。');
  if (fs.existsSync(directory)) {
    // Keep the last transaction report rather than deleting recovery evidence.
    fs.renameSync(directory, path.join(input.userData, 'client-update', 'history-' + randomUUID()));
  }
  const tx: Transaction = { ...input, id: randomUUID(), directory, phase: 'prepared', swapped: [], original: [], hadData: [] };
  validateTransaction(tx, directory);
  const executable = path.join(tx.root, 'DSHEAC AIO.exe');
  if (!fs.existsSync(executable)) throw new Error('仅打包后的 Windows AIO 支持自动安装。');
  if ((await fileHash(tx.file)) !== tx.sha256) throw new Error('更新包已变化。');
  fs.mkdirSync(directory, { recursive: true });
  copyTree(nodeExe, path.join(directory, 'node.exe'));
  copyTree(executable, path.join(directory, 'helper.exe'));
  // Self-contained helper code, outside the installation tree and its process Job.
  for (const name of ['update-helper.js', 'update-transaction.js', 'client-update.js']) {
    copyTree(path.join(appRoot, 'sidecar', 'dist', 'lib', name), path.join(directory, name));
  }
  copyTree(path.join(appRoot, 'assets', 'update', 'expand-update.ps1'), path.join(directory, 'expand-update.ps1'));
  save(tx); return tx;
}

function powershell(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env, maxBuffer: 1024 * 1024 });
}
function matchingPids(root: string): number[] {
  const value = powershell('$p=$env:AIO_TARGET_EXE; @(Get-CimInstance Win32_Process -Filter "Name=\'DSHEAC AIO.exe\'" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$p,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress', [], { ...process.env, AIO_TARGET_EXE: path.join(root, 'DSHEAC AIO.exe') }).trim();
  return value ? ([] as number[]).concat(JSON.parse(value)) : [];
}
function terminateCandidate(tx: Transaction): void {
  for (const pid of matchingPids(tx.root)) execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
  if (matchingPids(tx.root).length) throw new Error('更新进程仍在运行，保留备份并停止恢复。');
}

function startupRecovery(tx: Transaction, remove = false): void {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
  const name = 'DSHEAC-AIO-Update-' + tx.id;
  if (remove) {
    try { execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* absent is safe */ }
  } else {
    const command = `"${path.join(tx.directory, 'helper.exe')}" --aio-update-helper`;
    execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true, stdio: 'ignore' });
  }
}

function snapshot(tx: Transaction): void {
  const backup = path.join(tx.directory, 'backup'); fs.mkdirSync(backup);
  for (const name of managed) if (fs.existsSync(path.join(tx.root, name))) {
    copyTree(path.join(tx.root, name), path.join(backup, 'program', name)); tx.original.push(name);
  }
  // Full data snapshot; the transaction folder and logs are excluded to avoid
  // recursion. When DSH_HOME lives inside userData it is already captured by the
  // userData snapshot, so backing it up twice would double disk usage and race
  // the restore. Live data links are preserved, unlike program trees.
  const dshInsideUserData = Boolean(tx.dshHome) && isWithin(tx.userData, tx.dshHome);
  for (const [name, source] of [['userdata', tx.userData], ['dsh-home', tx.dshHome]] as const) {
    if (!source || !fs.existsSync(source)) continue;
    if (name === 'dsh-home' && dshInsideUserData) continue;
    const exclude = name === 'userdata' ? new Set(['client-update', 'logs']) : new Set<string>();
    copyTree(source, path.join(backup, name), exclude, { links: 'preserve' });
    tx.hadData.push(name);
  }
  save(tx);
}

export function restoreProgram(tx: Transaction): void {
  // Restoration is repeatable even if a previous recovery was interrupted.
  for (const name of managed) {
    const source = path.join(tx.directory, 'backup', 'program', name);
    if (fs.existsSync(source)) {
      boundedRemove(tx.root, path.join(tx.root, name)); copyTree(source, path.join(tx.root, name));
    } else if (!tx.original.includes(name) && tx.swapped.includes(name)) boundedRemove(tx.root, path.join(tx.root, name));
  }
}
function restoreData(tx: Transaction): void {
  const dshInsideUserData = Boolean(tx.dshHome) && isWithin(tx.userData, tx.dshHome);
  for (const [name, target] of [['userdata', tx.userData], ['dsh-home', tx.dshHome]] as const) {
    if (!target || !tx.hadData.includes(name)) continue;
    if (name === 'dsh-home' && dshInsideUserData && tx.hadData.includes('userdata')) continue;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    for (const item of fs.readdirSync(target)) if (!['client-update', 'logs'].includes(item)) boundedRemove(target, path.join(target, item));
    copyTree(path.join(tx.directory, 'backup', name), target, new Set(), { links: 'preserve' });
  }
}

async function runInstaller(tx: Transaction): Promise<void> {
  // Current AIO NSIS scope is currentUser. /D must be the last argument.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tx.file, ['/S', `/D=${tx.root}`], { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('安装超时，请检查恢复日志。')); }, 15 * 60_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('安装器未成功完成。')); });
  });
}

function launch(tx: Transaction, checking: boolean): number {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP_USERDATA: tx.userData, DSH_HOME: tx.dshHome };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  if (checking) Object.assign(env, { AIO_UPDATE_HEALTH_DIR: tx.directory, AIO_UPDATE_TOKEN: tx.id, DSH_DESKTOP_SKIP_PLUGIN_UPDATE: '1' });
  else { delete env.AIO_UPDATE_HEALTH_DIR; delete env.AIO_UPDATE_TOKEN; }
  try {
    const child = spawn(path.join(tx.root, 'DSHEAC AIO.exe'), [], { cwd: tx.root, env, detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref(); return child.pid || 0;
  } catch { return 0; }
}

export async function executeTransaction(directory: string): Promise<void> {
  const tx = readJson(path.join(directory, 'transaction.json')) as Transaction;
  validateTransaction(tx, directory);
  if (['complete', 'rolled-back', 'aborted'].includes(tx.phase)) return;
  const lock = path.join(directory, 'worker.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8')); if (alive(pid)) throw new Error('更新助手正在运行。');
    fs.rmSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    if (tx.phase !== 'prepared') {
      // Never resume a partly applied installer: restore the last working tree.
      if (['applying', 'verifying', 'restoring'].includes(tx.phase)) {
        terminateCandidate(tx); tx.phase = 'restoring'; save(tx); restoreProgram(tx); restoreData(tx);
        tx.phase = 'rolled-back'; save(tx); startupRecovery(tx, true); launch(tx, false); return;
      }
      tx.phase = 'aborted'; save(tx); startupRecovery(tx, true); return;
    }
    if (await fileHash(tx.file) !== tx.sha256) throw new Error('更新包校验失败。');
    startupRecovery(tx);
    atomicJson(path.join(directory, 'accepted.json'), { id: tx.id, pid: process.pid });
    const waitUntil = Date.now() + 60_000;
    while (alive(tx.parentPid) && Date.now() < waitUntil) await pause(250);
    if (alive(tx.parentPid) || matchingPids(tx.root).length) throw new Error('原程序尚未退出，更新已停止。');
    tx.phase = 'backing-up'; save(tx); snapshot(tx);
    const stage = path.join(directory, 'stage');
    if (tx.edition === 'portable') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'expand-update.ps1'), '-Archive', tx.file, '-Destination', stage, '-Version', tx.version], { windowsHide: true, timeout: 5 * 60_000, stdio: 'ignore' });
    }
    tx.phase = 'applying'; tx.swapped = [...managed]; save(tx);
    if (tx.edition === 'installer') await runInstaller(tx);
    else for (const name of managed) {
      const source = path.join(stage, name);
      if (!fs.existsSync(source)) continue;
      boundedRemove(tx.root, path.join(tx.root, name)); copyTree(source, path.join(tx.root, name));
    }
    const installed = readJson(path.join(tx.root, 'resources', 'app', 'package.json'));
    if (installed?.version !== tx.version) throw new Error('安装后版本与目标不符。');
    tx.phase = 'verifying'; save(tx); tx.candidatePid = launch(tx, true); save(tx);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const healthy = readJson(path.join(directory, 'healthy.json'));
      if (healthy?.id === tx.id && healthy.version === tx.version && healthy.pid === tx.candidatePid && healthy.ok === true) {
        tx.phase = 'complete'; save(tx); atomicJson(path.join(directory, 'committed.json'), { id: tx.id });
        startupRecovery(tx, true);
        boundedRemove(directory, path.join(directory, 'backup')); boundedRemove(directory, stage); return;
      }
      if (!tx.candidatePid || !alive(tx.candidatePid)) throw new Error('新版启动失败。');
      await pause(500);
    }
    throw new Error('新版健康检查超时。');
  } catch (error) {
    tx.error = error instanceof Error ? error.message : '更新失败';
    if (['applying', 'verifying', 'restoring'].includes(tx.phase)) {
      tx.phase = 'restoring'; save(tx);
      try {
        terminateCandidate(tx); restoreProgram(tx); restoreData(tx);
        tx.phase = 'rolled-back'; save(tx); startupRecovery(tx, true); launch(tx, false);
      } catch { tx.error = '自动恢复未完成，请保留更新目录和备份。'; save(tx); }
    } else if (['complete', 'rolled-back', 'aborted'].includes(tx.phase)) { save(tx); }
    else { tx.phase = 'aborted'; save(tx); startupRecovery(tx, true); }
  } finally { fs.rmSync(lock, { force: true }); }
}
