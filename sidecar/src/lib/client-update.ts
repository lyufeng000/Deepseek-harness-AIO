import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CLIENT_REPOSITORY = 'lyufeng000/Deepseek-harness-AIO';
export type Edition = 'installer' | 'portable';
export interface ReleaseAsset { id: number; name: string; size: number; browser_download_url: string; digest?: string }
export interface ClientRelease { version: string; notes: string; page: string; asset: ReleaseAsset; checksum: ReleaseAsset }
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'cancelled' | 'failed' | 'installing';
  currentVersion: string; release?: ClientRelease; received: number; error?: string; notifications: boolean;
}
export interface UpdateContext {
  version: string; edition: Edition; userData: string; downloads: string;
  request?: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<IncomingMessage>;
}

export function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('更新状态文件损坏，请保留文件并联系维护者。');
  }
}

export function assertPlainPath(file: string): void {
  let current = path.resolve(file);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('更新路径不能包含链接。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function versionParts(value: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('版本格式无效。');
  for (let i = 0; i < 3; i++) { const delta = left[i]! - right[i]!; if (delta) return Math.sign(delta); }
  return 0;
}

export function approvedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('更新地址不可信。');
  const root = '/repos/' + CLIENT_REPOSITORY + '/releases';
  const allowed = (url.hostname === 'api.github.com' && (url.pathname === root || url.pathname.startsWith(root + '/')))
    || (url.hostname === 'github.com' && url.pathname.startsWith('/' + CLIENT_REPOSITORY + '/releases/'))
    || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
  if (!allowed) throw new Error('更新地址不可信。');
  return url;
}

export async function githubRequest(value: string, headers: Record<string, string>, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
  const url = approvedUrl(value);
  if (redirects > 5) throw new Error('更新下载重定向过多。');
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'DSHEAC-AIO-Updater', ...headers }, signal }, resolve);
    request.setTimeout(30_000, () => request.destroy(new Error('更新连接超时。')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.resume();
    if (!response.headers.location) throw new Error('更新重定向缺少地址。');
    return githubRequest(new URL(response.headers.location, url).href, headers, signal, redirects + 1);
  }
  return response;
}

async function readBody(response: IncomingMessage, limit: number): Promise<Buffer> {
  if (response.statusCode !== 200) { response.resume(); throw new Error(`更新服务返回 HTTP ${response.statusCode}，请稍后重试。`); }
  const chunks: Buffer[] = []; let length = 0;
  for await (const item of response) {
    const chunk = Buffer.from(item); length += chunk.length;
    if (length > limit) { response.destroy(); throw new Error('更新响应超出大小限制。'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function selectRelease(releases: unknown, current: string, edition: Edition): ClientRelease | undefined {
  if (!Array.isArray(releases)) throw new Error('更新响应格式无效。');
  const eligible = releases.filter(r => r && !r.draft && !r.prerelease && typeof r.tag_name === 'string'
    && /^v\d+\.\d+\.\d+$/.test(r.tag_name) && versionParts(r.tag_name) && compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const r = eligible[0];
  if (!r) return undefined;
  const version = r.tag_name.slice(1);
  const name = `DSHEAC-AIO-v${version}-${edition === 'installer' ? 'Setup-x64.exe' : 'Portable-x64.zip'}`;
  const assets: ReleaseAsset[] = Array.isArray(r.assets) ? r.assets : [];
  const asset = assets.filter(a => a.name === name), checksum = assets.filter(a => a.name === 'SHA256SUMS.txt');
  if (asset.length !== 1 || checksum.length !== 1) throw new Error('新版发布资源尚不完整，请稍后重试。');
  for (const a of [asset[0]!, checksum[0]!]) {
    if (!Number.isSafeInteger(a.id) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 2_147_483_648) throw new Error('更新资源信息无效。');
    const url = approvedUrl(a.browser_download_url);
    if (url.hostname !== 'github.com' || !url.pathname.startsWith(`/${CLIENT_REPOSITORY}/releases/download/${r.tag_name}/`)) throw new Error('更新资源与版本不符。');
  }
  return { version, notes: String(r.body || '').slice(0, 12000), page: `https://github.com/${CLIENT_REPOSITORY}/releases/tag/${r.tag_name}`, asset: asset[0]!, checksum: checksum[0]! };
}

export function checksumFor(text: string, filename: string): string {
  const matches = text.split(/\r?\n/).flatMap(line => {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    return m && (m[2] === filename || m[2] === 'portable/' + filename) ? [m[1]!.toLowerCase()] : [];
  });
  if (matches.length !== 1) throw new Error('缺少唯一的更新包 SHA-256。');
  return matches[0]!;
}
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export class ClientUpdater {
  private state: UpdateState;
  private controller?: AbortController;
  private autoChecked = false;
  private verified?: { file: string; sha256: string; release: ClientRelease };
  private readonly preferences: string;
  constructor(private readonly ctx: UpdateContext) {
    this.preferences = path.join(ctx.userData, 'client-update', 'preferences.json');
    const prefs = readJson(this.preferences);
    this.state = { phase: 'idle', currentVersion: ctx.version, received: 0, notifications: prefs?.notifications !== false };
  }
  status(): UpdateState { return JSON.parse(JSON.stringify(this.state)); }
  notifications(enabled: unknown): UpdateState {
    if (typeof enabled !== 'boolean') throw new Error('通知设置必须是布尔值。');
    assertPlainPath(this.preferences); atomicJson(this.preferences, { notifications: enabled });
    this.state.notifications = enabled; return this.status();
  }
  async check(manual: boolean): Promise<UpdateState | null> {
    if (!manual && (this.autoChecked || !this.state.notifications)) return null;
    if (!manual) this.autoChecked = true;
    if (this.controller || ['ready', 'installing'].includes(this.state.phase)) return this.status();
    const controller = this.controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    this.state = { ...this.state, phase: 'checking', error: undefined, release: undefined };
    try {
      const response = await (this.ctx.request || githubRequest)(`https://api.github.com/repos/${CLIENT_REPOSITORY}/releases?per_page=100`, { Accept: 'application/vnd.github+json' }, controller.signal);
      const release = selectRelease(JSON.parse((await readBody(response, 4 * 1024 * 1024)).toString()), this.ctx.version, this.ctx.edition);
      this.state = { ...this.state, phase: release ? 'available' : 'idle', release };
    } catch (error) { this.state = { ...this.state, phase: 'failed', error: safeError(error) }; }
    finally { clearTimeout(timeout); this.controller = undefined; }
    return this.status();
  }
  cancel(): UpdateState { this.controller?.abort(); return this.status(); }
  startDownload(): UpdateState {
    if (this.controller || this.state.phase === 'installing') return this.status();
    if (!this.state.release) throw new Error('请先检查更新。');
    if (this.verified && this.state.phase === 'ready') return this.status();
    const controller = this.controller = new AbortController();
    this.state = { ...this.state, phase: 'downloading', error: undefined, received: 0 };
    void this.download(this.state.release!, controller).finally(() => { this.controller = undefined; });
    return this.status();
  }
  private async download(release: ClientRelease, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), 60 * 60_000);
    try {
      const request = this.ctx.request || githubRequest;
      const sums = await readBody(await request(release.checksum.browser_download_url, {}, controller.signal), 65536);
      const hash = checksumFor(sums.toString(), release.asset.name);
      if (release.asset.digest && release.asset.digest.toLowerCase() !== 'sha256:' + hash) throw new Error('更新摘要与 SHA256SUMS 不一致。');
      const directory = path.join(this.ctx.downloads, 'DSHEAC-AIO', release.version);
      assertPlainPath(directory); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, release.asset.name), part = file + '.part', metadata = part + '.json';
      for (const p of [file, part, metadata]) assertPlainPath(p);
      if (fs.existsSync(file) && fs.statSync(file).size === release.asset.size && await fileHash(file) === hash) {
        this.verified = { file, sha256: hash, release }; this.state.phase = 'ready'; this.state.received = release.asset.size; return;
      }
      const identity = `${release.asset.id}:${release.asset.size}:${hash}`;
      const previous = readJson(metadata);
      let offset = previous?.identity === identity && fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (offset > release.asset.size) offset = 0;
      if (!offset) fs.writeFileSync(part, '');
      let response: IncomingMessage | undefined;
      if (offset < release.asset.size) {
        const headers: Record<string, string> = offset ? { Range: `bytes=${offset}-` } : {};
        if (offset && typeof previous?.etag === 'string') headers['If-Range'] = previous.etag;
        response = await request(release.asset.browser_download_url, headers, controller.signal);
        if (offset && response.statusCode === 200) { offset = 0; fs.writeFileSync(part, ''); }
        if (response.statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range']));
          if (!range || Number(range[1]) !== offset || Number(range[2]) !== release.asset.size - 1 || Number(range[3]) !== release.asset.size
            || (offset && previous?.etag && response.headers.etag && previous.etag !== response.headers.etag)) {
            response.destroy(); throw new Error('续传范围或资源标识已变化，请重试。');
          }
        } else if (response.statusCode !== 200) { response.resume(); throw new Error(`下载服务返回 HTTP ${response.statusCode}。`); }
        atomicJson(metadata, { identity, etag: response.headers.etag || null });
        const fd = fs.openSync(part, 'a');
        try {
          this.state.received = offset;
          for await (const item of response) {
            const bytes = Buffer.from(item);
            if (this.state.received + bytes.length > release.asset.size) { response.destroy(); throw new Error('更新包超出声明大小。'); }
            fs.writeFileSync(fd, bytes); this.state.received += bytes.length;
          }
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
      if (fs.statSync(part).size !== release.asset.size) throw new Error('更新包未下载完整，可以重试续传。');
      if (await fileHash(part) !== hash) { fs.rmSync(part, { force: true }); fs.rmSync(metadata, { force: true }); throw new Error('更新包校验失败，已拒绝安装，请重新下载。'); }
      fs.renameSync(part, file); fs.rmSync(metadata, { force: true });
      this.verified = { file, sha256: hash, release }; this.state.phase = 'ready'; this.state.received = release.asset.size;
    } catch (error) { this.state = { ...this.state, phase: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? '下载已暂停，可重试续传。' : safeError(error) }; }
    finally { clearTimeout(timeout); }
  }
  async installation(): Promise<{ file: string; sha256: string; release: ClientRelease }> {
    if (this.controller || this.state.phase !== 'ready' || !this.verified) throw new Error('更新包尚未验证。');
    assertPlainPath(this.verified.file);
    if (await fileHash(this.verified.file) !== this.verified.sha256) throw new Error('下载文件已变化，拒绝安装。');
    return this.verified;
  }
  installing(): void { this.state.phase = 'installing'; }
  // A failed helper handoff must not strand the updater in "installing"; the
  // verified download stays ready so the user can retry.
  reset(error?: string): UpdateState {
    if (this.state.phase === 'installing') {
      this.state = { ...this.state, phase: this.verified ? 'ready' : this.state.release ? 'available' : 'idle', error };
    }
    return this.status();
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[\u4e00-\u9fff]/.test(message) ? message : '更新请求失败，请检查网络后重试。';
}
