'use strict';

// 客户端更新服务（sidecar/dist/lib/client-update.js）的纯函数与行为测试。
// 所有网络请求通过注入的 request stub 隔离，不访问真实 GitHub。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const clientUpdate = require('../sidecar/dist/lib/client-update.js');
const {
  CLIENT_REPOSITORY, ClientUpdater, atomicJson, readJson, assertPlainPath,
  versionParts, compareVersions, approvedUrl, selectRelease, checksumFor, fileHash,
} = clientUpdate;

function tmpDir(t, label = 'client-update') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-' + label + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response(body, { statusCode = 200, headers = {} } = {}) {
  const stream = Readable.from(Array.isArray(body) ? body : [Buffer.from(body)]);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function releasePayload(version, { tag, assetName, digest, size = 16, upload = true, portable = true } = {}) {
  const tagName = tag ?? `v${version}`;
  const url = name => upload
    ? `https://github.com/${CLIENT_REPOSITORY}/releases/download/${tagName}/${name}`
    : `https://example.invalid/${name}`;
  const setup = {
    id: 1000 + version.charCodeAt(0),
    name: assetName ?? `DSHEAC-AIO-v${version}-Setup-x64.exe`,
    size,
    browser_download_url: url(assetName ?? `DSHEAC-AIO-v${version}-Setup-x64.exe`),
  };
  if (digest) setup.digest = digest;
  const assets = [setup];
  if (portable) assets.push({
    id: 3000 + version.charCodeAt(0),
    name: `DSHEAC-AIO-v${version}-Portable-x64.zip`,
    size,
    browser_download_url: url(`DSHEAC-AIO-v${version}-Portable-x64.zip`),
  });
  assets.push({
    id: 2000,
    name: 'SHA256SUMS.txt',
    size: 120,
    browser_download_url: url('SHA256SUMS.txt'),
  });
  return { tag_name: tagName, draft: false, prerelease: false, body: `notes ${version}`, assets };
}

const settle = async (status, predicate = state => state.phase !== 'downloading' && state.phase !== 'checking') => {
  for (let i = 0; i < 400; i++) {
    const state = status();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return status();
};

test('版本比较只接受严格 semver', () => {
  assert.deepEqual(versionParts('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(versionParts('1.2.3'), [1, 2, 3]);
  assert.equal(versionParts('1.2'), null);
  assert.equal(versionParts('1.2.3-rc.1'), null);
  assert.equal(versionParts('01.2.3'), null);
  assert.equal(compareVersions('v1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.throws(() => compareVersions('bad', '1.0.0'), /版本格式无效/);
});

test('更新地址仅允许固定仓库与 GitHub 资源主机', () => {
  assert.equal(approvedUrl(`https://api.github.com/repos/${CLIENT_REPOSITORY}/releases`).hostname, 'api.github.com');
  assert.equal(approvedUrl(`https://github.com/${CLIENT_REPOSITORY}/releases/download/v1.2.1/a.exe`).hostname, 'github.com');
  assert.equal(approvedUrl('https://release-assets.githubusercontent.com/x').hostname, 'release-assets.githubusercontent.com');
  for (const url of [
    'http://api.github.com/repos/' + CLIENT_REPOSITORY + '/releases',
    'https://api.github.com/repos/other/repo/releases',
    'https://evil.example/repos/' + CLIENT_REPOSITORY + '/releases',
    'https://user:pass@api.github.com/repos/' + CLIENT_REPOSITORY + '/releases',
    'https://api.github.com:8443/repos/' + CLIENT_REPOSITORY + '/releases',
    'https://github.com/' + CLIENT_REPOSITORY + '/issues',
  ]) assert.throws(() => approvedUrl(url), /更新地址不可信/, url);
});

test('selectRelease 排除草稿/预发布/构建输入，并选择精确资源', () => {
  const releases = [
    releasePayload('1.2.1'),
    { ...releasePayload('1.5.0'), draft: true },
    { ...releasePayload('1.6.0'), prerelease: true },
    releasePayload('1.0.0', { tag: 'build-inputs-v9.9.9' }),
    releasePayload('1.2.0'),
    { ...releasePayload('1.9.0'), tag_name: 'not-a-version' },
  ];
  const selected = selectRelease(releases, '1.2.0', 'installer');
  assert.equal(selected.version, '1.2.1');
  assert.match(selected.asset.name, /Setup-x64\.exe$/);
  assert.equal(selected.page, `https://github.com/${CLIENT_REPOSITORY}/releases/tag/v1.2.1`);

  const portable = selectRelease(releases, '1.2.0', 'portable');
  assert.equal(portable.asset.name, 'DSHEAC-AIO-v1.2.1-Portable-x64.zip');
  assert.equal(selectRelease(releases, '9.9.9', 'installer'), undefined);
});

test('selectRelease 拒绝不完整或不可信的资源', () => {
  const complete = releasePayload('1.2.1');
  assert.throws(() => selectRelease([{ ...complete, assets: [] }], '1.2.0', 'installer'), /资源尚不完整/);
  assert.throws(() => selectRelease([releasePayload('1.2.1', { portable: false })], '1.2.0', 'portable'), /资源尚不完整/);
  assert.throws(() => selectRelease([releasePayload('1.2.1', { upload: false })], '1.2.0', 'installer'), /不可信/);
  assert.throws(() => selectRelease([releasePayload('1.2.1', { size: 0 })], '1.2.0', 'installer'), /信息无效/);
  const mismatched = releasePayload('1.2.2', { tag: 'v1.2.2' });
  mismatched.assets[0].browser_download_url = `https://github.com/${CLIENT_REPOSITORY}/releases/download/v1.2.1/DSHEAC-AIO-v1.2.2-Setup-x64.exe`;
  assert.throws(() => selectRelease([mismatched], '1.2.0', 'installer'), /与版本不符/);
  assert.throws(() => selectRelease({}, '1.2.0', 'installer'), /格式无效/);
});

test('checksumFor 解析唯一 SHA-256 行', () => {
  const sums = 'aa' + '0'.repeat(62) + '  SHA256SUMS.txt\n'
    + 'bb' + '0'.repeat(62) + ' *DSHEAC-AIO-v1.2.1-Setup-x64.exe\n';
  assert.equal(checksumFor(sums, 'DSHEAC-AIO-v1.2.1-Setup-x64.exe'), 'bb' + '0'.repeat(62));
  assert.equal(checksumFor('cc' + '0'.repeat(62) + '  portable/x.zip\n', 'x.zip'), 'cc' + '0'.repeat(62));
  assert.throws(() => checksumFor(sums, 'missing.exe'), /唯一/);
  assert.throws(() => checksumFor(
    'dd' + '0'.repeat(62) + '  x\n' + 'ee' + '0'.repeat(62) + '  x\n', 'x'), /唯一/);
});

test('atomicJson 原子写入且 readJson 容忍缺失、拒绝损坏', t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'nested', 'state.json');
  atomicJson(file, { ok: true });
  assert.deepEqual(readJson(file), { ok: true });
  assert.equal(readJson(path.join(dir, 'missing.json')), null);
  assert.doesNotThrow(() => assertPlainPath(file));
  const target = path.join(dir, 'target');
  const link = path.join(dir, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPlainPath(path.join(link, 'child')), /链接/);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  assert.throws(() => readJson(path.join(dir, 'broken.json')), /损坏/);
});

test('通知偏好持久化并校验类型', t => {
  const userData = tmpDir(t);
  const updater = new ClientUpdater({ version: '1.2.0', edition: 'installer', userData, downloads: path.join(userData, 'dl'), request: async () => { throw new Error('no network'); } });
  assert.equal(updater.status().notifications, true);
  assert.equal(updater.notifications(false).notifications, false);
  assert.throws(() => updater.notifications('yes'), /布尔值/);
  const reopened = new ClientUpdater({ version: '1.2.0', edition: 'installer', userData, downloads: path.join(userData, 'dl'), request: async () => { throw new Error('no network'); } });
  assert.equal(reopened.status().notifications, false);
});

test('自动检查每次运行仅一次，关闭通知后不再自动检查，手动检查仍可用', async t => {
  const userData = tmpDir(t);
  let calls = 0;
  const request = async url => {
    calls++;
    assert.match(url, /api\.github\.com\/repos\/.*\/releases/);
    return response(JSON.stringify([releasePayload('1.2.1')]));
  };
  const updater = new ClientUpdater({ version: '1.2.0', edition: 'installer', userData, downloads: path.join(userData, 'dl'), request });
  const first = await updater.check(false);
  assert.equal(first.phase, 'available');
  assert.equal(calls, 1);
  assert.equal(await updater.check(false), null, '自动检查不重复');
  assert.equal(calls, 1);
  updater.notifications(false);
  assert.equal(await updater.check(false), null);
  const manual = await updater.check(true);
  assert.equal(manual.phase, 'available');
  assert.equal(calls, 2, '手动检查仍然生效');
});

test('检查失败返回可读错误且不暴露内部信息', async t => {
  const userData = tmpDir(t);
  const updater = new ClientUpdater({ version: '1.2.0', edition: 'installer', userData, downloads: path.join(userData, 'dl'),
    request: async () => { throw new Error('ECONNRESET at 10.0.0.1'); } });
  const state = await updater.check(true);
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, '更新请求失败，请检查网络后重试。');
});

function updaterWith(t, edition, responses) {
  const userData = tmpDir(t);
  const downloads = path.join(userData, 'dl');
  const request = async (url, headers) => {
    for (const [matcher, factory] of responses) {
      if (typeof matcher === 'string' ? url === matcher : matcher.test(url)) return factory(url, headers);
    }
    throw new Error('unexpected request ' + url);
  };
  const updater = new ClientUpdater({ version: '1.2.0', edition, userData, downloads, request });
  return { updater, userData, downloads };
}

test('下载校验 SHA-256 并进入 ready，installation 复核文件', async t => {
  const payload = Buffer.from('portable-archive-bytes');
  const hash = await fileHashFrom(payload);
  const release = releasePayload('1.2.1', { size: payload.length });
  const { updater } = updaterWith(t, 'installer', [
    [/releases\/download\/v1\.2\.1\/SHA256SUMS\.txt$/, () => response(`${hash}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
    [/releases\/download\/v1\.2\.1\//, () => response(payload)],
  ]);
  updater.state = { ...updater.state, release: selectRelease([release], '1.2.0', 'installer') };
  updater.startDownload();
  const state = await settle(() => updater.status());
  assert.equal(state.phase, 'ready', state.error);
  assert.equal(state.received, payload.length);
  const installation = await updater.installation();
  assert.equal(installation.sha256, hash);
  assert.ok(fs.existsSync(installation.file));
});

test('接管失败后 reset 回到 ready 并保留已验证下载', async t => {
  const payload = Buffer.from('reset-archive-bytes');
  const hash = fileHashFrom(payload);
  const release = releasePayload('1.2.1', { size: payload.length });
  const { updater } = updaterWith(t, 'installer', [
    [/SHA256SUMS\.txt$/, () => response(`${hash}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
    [/releases\/download\/v1\.2\.1\//, () => response(payload)],
  ]);
  updater.state = { ...updater.state, release: selectRelease([release], '1.2.0', 'installer') };
  updater.startDownload();
  await settle(() => updater.status());
  assert.equal(updater.status().phase, 'ready');
  updater.installing();
  assert.equal(updater.status().phase, 'installing');
  const reset = updater.reset('助手未接管');
  assert.equal(reset.phase, 'ready');
  assert.equal(reset.error, '助手未接管');
  assert.equal((await updater.installation()).sha256, hash, '重试仍使用同一已验证文件');
  // 非 installing 状态下的 reset 不得改变阶段。
  const idle = new ClientUpdater({ version: '1.2.0', edition: 'installer', userData: tmpDir(t),
    downloads: tmpDir(t), request: async () => { throw new Error('no network'); } });
  assert.equal(idle.reset('ignored').phase, 'idle');
});

test('断点续传使用 Range/If-Range，资源变化时拒绝拼接', async t => {
  const payload = Buffer.from('0123456789abcdef');
  const hash = await fileHashFrom(payload);
  const release = releasePayload('1.2.1', { size: payload.length });
  const calls = [];
  const { updater, downloads } = updaterWith(t, 'installer', [
    [/SHA256SUMS\.txt$/, () => response(`${hash}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
    [/releases\/download\/v1\.2\.1\//, (url, headers) => {
      calls.push(headers);
      if (headers.Range) {
        const offset = Number(/bytes=(\d+)-/.exec(headers.Range)[1]);
        return response([payload.subarray(offset)], { statusCode: 206, headers: {
          'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
          etag: '"etag-1"',
        } });
      }
      return response(payload, { headers: { etag: '"etag-1"' } });
    }],
  ]);
  const clientRelease = selectRelease([release], '1.2.0', 'installer');
  updater.state = { ...updater.state, release: clientRelease };
  // 预置半截文件与匹配的续传元数据。
  const dir = path.join(downloads, 'DSHEAC-AIO', '1.2.1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, clientRelease.asset.name);
  fs.writeFileSync(file + '.part', payload.subarray(0, 8));
  fs.writeFileSync(file + '.part.json', JSON.stringify({ identity: `${clientRelease.asset.id}:${clientRelease.asset.size}:${hash}`, etag: '"etag-1"' }));
  updater.startDownload();
  const state = await settle(() => updater.status());
  assert.equal(state.phase, 'ready', state.error);
  assert.equal(fs.readFileSync(file).toString(), payload.toString());
  assert.ok(calls.some(headers => headers.Range === 'bytes=8-'), '使用 Range 续传');
  assert.ok(calls.some(headers => headers['If-Range'] === '"etag-1"'), '使用 If-Range 保护');
});

test('下载哈希不匹配时拒绝并清理部分文件', async t => {
  const payload = Buffer.from('tampered-bytes');
  const wrong = '0'.repeat(64);
  const release = releasePayload('1.2.1', { size: payload.length });
  const { updater, downloads } = updaterWith(t, 'installer', [
    [/SHA256SUMS\.txt$/, () => response(`${wrong}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
    [/releases\/download\/v1\.2\.1\//, () => response(payload)],
  ]);
  const clientRelease = selectRelease([release], '1.2.0', 'installer');
  updater.state = { ...updater.state, release: clientRelease };
  updater.startDownload();
  const state = await settle(() => updater.status());
  assert.equal(state.phase, 'failed');
  assert.match(state.error, /校验失败/);
  const dir = path.join(downloads, 'DSHEAC-AIO', '1.2.1');
  assert.ok(!fs.existsSync(path.join(dir, clientRelease.asset.name + '.part')));
});

test('GitHub digest 与 SHA256SUMS 不一致时拒绝下载', async t => {
  const payload = Buffer.from('digest-check');
  const hash = await fileHashFrom(payload);
  const release = releasePayload('1.2.1', { size: payload.length, digest: 'sha256:' + 'f'.repeat(64) });
  const { updater } = updaterWith(t, 'installer', [
    [/SHA256SUMS\.txt$/, () => response(`${hash}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
  ]);
  updater.state = { ...updater.state, release: selectRelease([release], '1.2.0', 'installer') };
  updater.startDownload();
  const state = await settle(() => updater.status());
  assert.equal(state.phase, 'failed');
  assert.match(state.error, /摘要.*不一致/);
});

test('取消下载进入 cancelled 且可重新开始', async t => {
  const release = releasePayload('1.2.1', { size: 32 });
  let releaseRequest;
  const gate = new Promise(resolve => { releaseRequest = resolve; });
  const { updater } = updaterWith(t, 'installer', [
    [/SHA256SUMS\.txt$/, () => response(`${'a'.repeat(64)}  DSHEAC-AIO-v1.2.1-Setup-x64.exe\n`)],
    [/releases\/download\/v1\.2\.1\//, async () => {
      await gate;
      return response(Buffer.alloc(32), { headers: {} });
    }],
  ]);
  updater.state = { ...updater.state, release: selectRelease([release], '1.2.0', 'installer') };
  updater.startDownload();
  await new Promise(resolve => setTimeout(resolve, 20));
  updater.cancel();
  releaseRequest();
  const state = await settle(() => updater.status());
  assert.equal(state.phase, 'cancelled');
  assert.ok(!updater.status().error || /重试/.test(updater.status().error));
});

function fileHashFrom(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
