'use strict';

// 客户端更新事务（sidecar/dist/lib/update-transaction.js）的校验、边界与恢复测试。
// 覆盖路径越界、事务清单校验、备份恢复的可重复性，以及事务准备的前置条件。
// 不触发真实安装器/助手子进程。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  alive, copyTree, boundedRemove, validateTransaction, isWithin, installerInvocation,
  prepareTransaction, restoreProgram, executeTransaction,
} = require('../sidecar/dist/lib/update-transaction.js');

test('installerInvocation 逐字传递未加引号的 /D= 且启用 verbatim', () => {
  const invocation = installerInvocation('D:\\Program Files\\Development Tools\\DSHEAC AIO', 'C:\\stage\\update-setup.exe');
  assert.deepEqual(invocation.args, ['/S', '/D=D:\\Program Files\\Development Tools\\DSHEAC AIO']);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(invocation.file, 'C:\\stage\\update-setup.exe');
});

function tmpDir(t, label = 'tx') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-' + label + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

function makeTransaction(userData, overrides = {}) {
  const directory = path.join(userData, 'client-update', 'transaction');
  const tx = {
    id: randomUUID(),
    root: path.join(userData, 'install'),
    userData,
    dshHome: path.join(userData, 'dsh-home'),
    directory,
    file: path.join(userData, 'update.exe'),
    sha256: sha256('update-package'),
    version: '1.2.1',
    edition: 'portable',
    parentPid: process.pid,
    phase: 'prepared',
    swapped: [],
    original: [],
    hadData: [],
    ...overrides,
  };
  return tx;
}

test('alive 正确识别进程存在性', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(2147483647), false);
});

test('boundedRemove 拒绝越界与根目录本身', t => {
  const root = tmpDir(t, 'bounded');
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'inside', 'a.txt'), 'x');
  const outside = tmpDir(t, 'outside');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  assert.throws(() => boundedRemove(root, outside), /越界/);
  assert.throws(() => boundedRemove(root, root), /越界/);
  boundedRemove(root, path.join(root, 'inside'));
  assert.ok(!fs.existsSync(path.join(root, 'inside')));
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
});

test('copyTree 复制目录并拒绝链接类条目', t => {
  const source = tmpDir(t, 'copy-src');
  const target = path.join(tmpDir(t, 'copy-dst'), 'out');
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'nested', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(source, 'b.txt'), 'world');
  copyTree(source, target, new Set(['b.txt']));
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'a.txt'), 'utf8'), 'hello');
  assert.ok(!fs.existsSync(path.join(target, 'b.txt')), '排除项不复制');
  const linkSource = tmpDir(t, 'copy-link');
  fs.symlinkSync(target, path.join(linkSource, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyTree(path.join(linkSource, 'link'), path.join(linkSource, 'dest')), /链接/);
});

test('isWithin 识别嵌套、并列与相等路径', () => {
  assert.equal(isWithin('C:/data', 'C:/data/dsh-home'), true);
  assert.equal(isWithin('C:/data', 'C:/data'), true);
  assert.equal(isWithin('C:/data', 'C:/data-other/x'), false);
  assert.equal(isWithin('C:/data', 'C:/elsewhere'), false);
});

test('copyTree 默认拒绝链接，数据策略可原样保留', t => {
  const source = tmpDir(t, 'link-src');
  const target = path.join(source, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.txt'), 'linked');
  fs.symlinkSync(target, path.join(source, 'junction'), 'junction');
  const dest = path.join(tmpDir(t, 'link-dst'), 'copy');
  assert.throws(() => copyTree(source, dest), /链接/);
  copyTree(source, dest, new Set(), { links: 'preserve' });
  const copied = path.join(dest, 'junction');
  assert.ok(fs.lstatSync(copied).isSymbolicLink(), '链接被保留');
  assert.equal(fs.readFileSync(path.join(copied, 'a.txt'), 'utf8'), 'linked');
});

test('validateTransaction 拒绝非法标识、路径与清单', t => {
  const userData = tmpDir(t, 'validate');
  const directory = path.join(userData, 'client-update', 'transaction');
  const valid = makeTransaction(userData);
  assert.doesNotThrow(() => validateTransaction(valid, directory));
  const cases = [
    [{ id: 'not-a-uuid' }, /无效/],
    [{ directory: path.join(userData, 'elsewhere') }, /无效/],
    [{ edition: 'zip' }, /无效/],
    [{ version: '1.2' }, /无效/],
    [{ sha256: 'xyz' }, /无效/],
    [{ root: path.parse(path.resolve(userData)).root }, /根目录/],
    [{ swapped: ['..\\escape'] }, /清单无效/],
    [{ original: ['resources', 'arbitrary.txt'] }, /清单无效/],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => validateTransaction({ ...valid, ...override }, directory), expected, JSON.stringify(override));
  }
});

test('restoreProgram 可重复执行并撤回非原始的程序文件', t => {
  const userData = tmpDir(t, 'restore');
  const root = path.join(userData, 'install');
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DSHEAC AIO.exe'), 'new-exe');
  fs.writeFileSync(path.join(root, 'resources', 'app.txt'), 'new-app');
  fs.writeFileSync(path.join(root, 'uninstall.exe'), 'failed-install-leftover');
  const backup = path.join(userData, 'client-update', 'transaction', 'backup', 'program');
  fs.mkdirSync(path.join(backup, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'DSHEAC AIO.exe'), 'old-exe');
  fs.writeFileSync(path.join(backup, 'resources', 'app.txt'), 'old-app');
  const tx = makeTransaction(userData, {
    root, original: ['resources', 'DSHEAC AIO.exe'],
    swapped: ['resources', 'DSHEAC AIO.exe', 'uninstall.exe', '.dsh-portable'],
  });
  restoreProgram(tx);
  assert.equal(fs.readFileSync(path.join(root, 'DSHEAC AIO.exe'), 'utf8'), 'old-exe');
  assert.equal(fs.readFileSync(path.join(root, 'resources', 'app.txt'), 'utf8'), 'old-app');
  assert.ok(!fs.existsSync(path.join(root, 'uninstall.exe')), '非原始残留被清除');
  assert.doesNotThrow(() => restoreProgram(tx), '恢复可重复执行');
});

test('prepareTransaction 复制助手组件并拒绝缺失可执行文件', async t => {
  const userData = tmpDir(t, 'prepare');
  const appRoot = tmpDir(t, 'app');
  fs.mkdirSync(path.join(appRoot, 'sidecar', 'dist', 'lib'), { recursive: true });
  for (const name of ['update-helper.js', 'update-transaction.js', 'client-update.js']) {
    fs.writeFileSync(path.join(appRoot, 'sidecar', 'dist', 'lib', name), `// ${name}`);
  }
  fs.mkdirSync(path.join(appRoot, 'assets', 'update'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'assets', 'update', 'expand-update.ps1'), '# expand');
  const nodeExe = path.join(appRoot, 'node.exe');
  fs.writeFileSync(nodeExe, 'node-binary');

  const installRoot = path.join(userData, 'install');
  fs.mkdirSync(installRoot, { recursive: true });
  const update = path.join(userData, 'update.exe');
  fs.writeFileSync(update, 'update-package');

  const missing = { root: path.join(userData, 'absent'), userData, dshHome: path.join(userData, 'dsh'),
    file: update, sha256: sha256('update-package'), version: '1.2.1', edition: 'portable', parentPid: 1 };
  await assert.rejects(prepareTransaction(missing, nodeExe, appRoot), /仅打包后的 Windows AIO/);

  fs.writeFileSync(path.join(installRoot, 'DSHEAC AIO.exe'), 'app-binary');
  const tx = await prepareTransaction({ root: installRoot, userData, dshHome: path.join(userData, 'dsh'),
    file: update, sha256: sha256('update-package'), version: '1.2.1', edition: 'portable', parentPid: 42 }, nodeExe, appRoot);
  assert.equal(tx.phase, 'prepared');
  assert.equal(tx.parentPid, 42);
  for (const name of ['node.exe', 'helper.exe', 'update-helper.js', 'update-transaction.js', 'client-update.js', 'expand-update.ps1']) {
    assert.ok(fs.existsSync(path.join(tx.directory, name)), name + ' 应复制进事务目录');
  }
  assert.equal(fs.readFileSync(path.join(tx.directory, 'node.exe'), 'utf8'), 'node-binary');

  // 文件在准备阶段被改动后必须拒绝（独立 userData，避免复用未完成事务）。
  const otherUserData = tmpDir(t, 'prepare-tampered');
  const otherInstall = path.join(otherUserData, 'install');
  fs.mkdirSync(otherInstall, { recursive: true });
  fs.writeFileSync(path.join(otherInstall, 'DSHEAC AIO.exe'), 'app-binary');
  const tampered = path.join(otherUserData, 'update.exe');
  fs.writeFileSync(tampered, 'other-package');
  await assert.rejects(prepareTransaction({ root: otherInstall, userData: otherUserData, dshHome: path.join(otherUserData, 'dsh'),
    file: tampered, sha256: sha256('update-package'), version: '1.2.1', edition: 'portable', parentPid: 42 }, nodeExe, appRoot),
  /更新包已变化/);
});

test('prepareTransaction 拒绝存在未完成事务时再次开始', async t => {
  const userData = tmpDir(t, 'pending');
  const appRoot = tmpDir(t, 'pending-app');
  fs.mkdirSync(path.join(appRoot, 'sidecar', 'dist', 'lib'), { recursive: true });
  for (const name of ['update-helper.js', 'update-transaction.js', 'client-update.js']) {
    fs.writeFileSync(path.join(appRoot, 'sidecar', 'dist', 'lib', name), `// ${name}`);
  }
  fs.mkdirSync(path.join(appRoot, 'assets', 'update'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'assets', 'update', 'expand-update.ps1'), '# expand');
  const nodeExe = path.join(appRoot, 'node.exe');
  fs.writeFileSync(nodeExe, 'node');
  const installRoot = path.join(userData, 'install');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'DSHEAC AIO.exe'), 'app');
  const update = path.join(userData, 'update.exe');
  fs.writeFileSync(update, 'pkg');
  const directory = path.join(userData, 'client-update', 'transaction');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'transaction.json'), JSON.stringify({ phase: 'applying' }));
  await assert.rejects(prepareTransaction({ root: installRoot, userData, dshHome: path.join(userData, 'dsh'),
    file: update, sha256: sha256('pkg'), version: '1.2.1', edition: 'portable', parentPid: 1 }, nodeExe, appRoot),
  /存在未完成的更新/);
});

test('executeTransaction 从失败安装恢复程序文件并标记 rolled-back', async t => {
  const userData = tmpDir(t, 'recover');
  const directory = path.join(userData, 'client-update', 'transaction');
  const root = path.join(userData, 'install');
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DSHEAC AIO.exe'), 'new-exe');
  fs.writeFileSync(path.join(root, 'resources', 'app.txt'), 'new-app');
  fs.mkdirSync(path.join(directory, 'backup', 'program', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'backup', 'program', 'DSHEAC AIO.exe'), 'old-exe');
  fs.writeFileSync(path.join(directory, 'backup', 'program', 'resources', 'app.txt'), 'old-app');
  const tx = makeTransaction(userData, {
    root, phase: 'verifying', edition: 'portable',
    original: ['resources', 'DSHEAC AIO.exe'],
    swapped: ['resources', 'DSHEAC AIO.exe', 'uninstall.exe', '.dsh-portable'],
  });
  fs.writeFileSync(path.join(directory, 'transaction.json'), JSON.stringify(tx));
  await executeTransaction(directory);
  const after = JSON.parse(fs.readFileSync(path.join(directory, 'transaction.json'), 'utf8'));
  assert.equal(after.phase, 'rolled-back');
  assert.equal(fs.readFileSync(path.join(root, 'DSHEAC AIO.exe'), 'utf8'), 'old-exe');
  assert.equal(fs.readFileSync(path.join(root, 'resources', 'app.txt'), 'utf8'), 'old-app');
  assert.ok(!fs.existsSync(path.join(directory, 'worker.lock')), '恢复后释放工作锁');
});

test('executeTransaction 对终态事务直接返回且不产生副作用', async t => {
  const userData = tmpDir(t, 'terminal');
  const directory = path.join(userData, 'client-update', 'transaction');
  fs.mkdirSync(directory, { recursive: true });
  for (const phase of ['complete', 'rolled-back', 'aborted']) {
    fs.writeFileSync(path.join(directory, 'transaction.json'), JSON.stringify(makeTransaction(userData, { phase })));
    await executeTransaction(directory);
    assert.ok(!fs.existsSync(path.join(directory, 'worker.lock')), '终态事务不创建锁');
  }
});
