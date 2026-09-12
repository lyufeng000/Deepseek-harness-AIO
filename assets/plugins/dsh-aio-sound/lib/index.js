// dsh-aio-sound — DSHEAC AIO 配套插件（host 半身）。
//
// 「音效」设置栏的服务端：主任务完成/中断/询问/错误提示音的播放与配置。
//
// 为什么播放放在 host：
//   1) 上游 dsh-webui 的提示音由「客户端当前会话」的 turnTail 槽位触发，
//      只有被选中的会话才会出声；改成 host 端监听 `session/event` 后，任何
//      前台或后台主任务一有需要关注的状态就出声，与前端选中状态无关；
//      子任务和自动重试不会制造额外通知。
//   2) 播放走 PowerShell（WPF MediaPlayer），绕开浏览器 autoplay 拦截，
//      并支持 0..100 音量——只作用于这次播放，不动系统音量。
//
// 配置存官方设置命名空间 `aio-sound`（settings.yaml，随 profile 保留）；
// settings 服务不可用时退化为进程内配置，插件仍能工作。
//
// 路由（全部回环，Cache-Control: no-store）：
//   GET  /api/aio-sound/state    → 配置 + 音效清单（内置 + 自定义目录扫描）
//   POST /api/aio-sound/config   → 校验并写入总开关、音量、分类事件与自定义目录
//   POST /api/aio-sound/preview  → 按当前音量试听一个音效（用户点「试听」）
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'dsh-aio-sound';
const inject = ['webServer'];

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOUND_DIR = join(PKG_DIR, 'assets', 'sounds');
const PLAY_SCRIPT = join(PKG_DIR, 'assets', 'play-sound.ps1');
const SETTINGS_NS = 'aio-sound';
const DEFAULT_SOUND = 'task-done.wav';
const MAX_SOUND_NAME = 128;
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  volume: 100,
  sound: DEFAULT_SOUND,
  customDir: '',
  events: Object.freeze({
    complete: Object.freeze({ enabled: true, sound: 'task-done.wav' }),
    interrupted: Object.freeze({ enabled: true, sound: 'drop.wav' }),
    question: Object.freeze({ enabled: true, sound: 'bell.wav' }),
    error: Object.freeze({ enabled: true, sound: 'pulse.wav' }),
  }),
});

const BUILTIN_LABELS = Object.freeze({
  'task-done.wav': '默认（当前音效）',
  'chime-soft.wav': '柔和双音',
  'chime-bright.wav': '清脆三连音',
  'bell.wav': '铃声',
  'drop.wav': '水滴',
  'pulse.wav': '短促双响',
});

function log(message) {
  console.log(`[dsh-aio-sound] ${message}`);
}

/** 只接受单个 wav 文件名的白名单：不含路径分隔符，排除目录穿越。 */
function safeSoundName(value) {
  if (typeof value !== 'string') return null;
  const file = value.trim();
  if (file === '' || file.length > MAX_SOUND_NAME) return null;
  if (!/^[A-Za-z0-9._-]+\.wav$/i.test(file)) return null;
  return file;
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const volume = Number(source.volume);
  const eventSource = source.events !== null && typeof source.events === 'object' && !Array.isArray(source.events)
    ? source.events : {};
  const events = {};
  for (const kind of Object.keys(DEFAULT_CONFIG.events)) {
    const item = eventSource[kind] !== null && typeof eventSource[kind] === 'object' ? eventSource[kind] : {};
    events[kind] = {
      enabled: item.enabled === undefined ? DEFAULT_CONFIG.events[kind].enabled : item.enabled !== false,
      sound: safeSoundName(item.sound) ?? (kind === 'complete'
        ? (safeSoundName(source.sound) ?? DEFAULT_CONFIG.events.complete.sound)
        : DEFAULT_CONFIG.events[kind].sound),
    };
  }
  return {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled !== false,
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : DEFAULT_CONFIG.volume,
    sound: safeSoundName(source.sound) ?? DEFAULT_CONFIG.sound,
    customDir: typeof source.customDir === 'string' ? source.customDir.trim() : '',
    events,
  };
}

/** 自定义音效目录：用户配置优先，留空时用 DSH 数据目录下的 sounds/。 */
function defaultCustomDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'sounds');
}

function wavFilesIn(dir) {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((file) => /\.wav$/i.test(file)).sort();
  } catch {
    return [];
  }
}

/** 音效清单：内置包资源在前，自定义目录在后；同名以内置为准（默认行为稳定）。 */
function soundList(config) {
  const seen = new Set();
  const out = [];
  for (const file of wavFilesIn(SOUND_DIR)) {
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, label: BUILTIN_LABELS[key] ?? file, source: 'builtin' });
  }
  for (const file of wavFilesIn(config.customDir === '' ? defaultCustomDir() : config.customDir)) {
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, label: file, source: 'custom' });
  }
  return out;
}

/** 解析实际播放文件：内置优先，其次自定义目录（文件名已过白名单）。 */
function resolveSoundPath(file, config) {
  const builtin = join(SOUND_DIR, file);
  if (existsSync(builtin)) return builtin;
  const dir = resolve(config.customDir === '' ? defaultCustomDir() : config.customDir);
  const candidate = resolve(dir, file);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  return existsSync(candidate) ? candidate : null;
}

// ---------------------------------------------------------------- 配置层 --

let ctxRef = null;
let scope = null;
let scopeReady = false;
let memory = { ...DEFAULT_CONFIG };

async function ensureScope() {
  if (scopeReady) return scope;
  scopeReady = true;
  try {
    const settings = ctxRef !== null && typeof ctxRef.get === 'function' ? ctxRef.get('settings') : null;
    if (!settings || typeof settings.register !== 'function') return null;
    const schemastery = await import('@deepseek-ai/schemastery');
    const z = schemastery.default ?? schemastery;
    // 宽松 schema：字段结构由 normalizeConfig 把关（接受任意 JSON 对象）。
    scope = settings.register(SETTINGS_NS, z.object({}).loose(), { applies: 'live' });
    log('settings namespace `' + SETTINGS_NS + '` bound');
    return scope;
  } catch (error) {
    log('settings namespace unavailable, using in-memory config: ' + String((error && error.message) || error));
    scope = null;
    return null;
  }
}

function currentConfig() {
  try {
    const value = scope !== null && typeof scope.get === 'function' ? scope.get() : null;
    return value === null || value === undefined ? normalizeConfig(memory) : normalizeConfig(value);
  } catch {
    return normalizeConfig(memory);
  }
}

async function updateConfig(patch) {
  const next = normalizeConfig({ ...currentConfig(), ...patch });
  memory = next;
  if (scope !== null && typeof scope.update === 'function') await scope.update(next);
  return next;
}

// ------------------------------------------------------------------ 播放 --

/** 播放一个音效（不阻塞；PowerShell 子进程自管生命周期）。 */
function playSound(file) {
  const config = currentConfig();
  const path = resolveSoundPath(file, config);
  if (path === null) return { ok: false, error: '找不到音效文件: ' + file };
  if (!existsSync(PLAY_SCRIPT)) return { ok: false, error: '播放脚本缺失: ' + PLAY_SCRIPT };
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', PLAY_SCRIPT,
      '-Path', path, '-Volume', String(config.volume),
    ], { stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => log('spawn powershell errored: ' + String((error && error.message) || error)));
    child.unref();
    return { ok: true, file, volume: config.volume };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 事件触发的播放：受总开关控制；音量在 playSound 里读取。 */
function playFor(event) {
  try {
    const config = currentConfig();
    const selected = config.events[event];
    if (!config.enabled || !selected || !selected.enabled) return;
    const result = playSound(selected.sound);
    if (!result.ok) log('play failed (' + event + '): ' + result.error);
  } catch (error) {
    log('play threw (' + event + '): ' + String((error && error.message) || error));
  }
}

function isTopLevelSession(session) {
  const header = session?.header;
  return header?.origin !== 'subagent' && !(Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0);
}

const played = new Set();
function playOnce(kind, key) {
  const identity = `${kind}:${key}`;
  if (played.has(identity)) return;
  played.add(identity);
  if (played.size > 2048) played.delete(played.values().next().value);
  playFor(kind);
}

// ------------------------------------------------------------------ 路由 --

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

function statePayload() {
  const config = currentConfig();
  return {
    ok: true,
    config,
    customDirIsDefault: config.customDir === '',
    sounds: soundList(config),
  };
}

function createHandler(route) {
  return async (req, res) => {
    try {
      const method = req.method === undefined ? 'GET' : req.method.toUpperCase();
      if (route === 'state') {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return sendJson(res, 200, statePayload());
      }
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      if (route === 'config') {
        const patch = {};
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
          patch.enabled = body.enabled;
        }
        if (body.volume !== undefined) {
          const volume = Number(body.volume);
          if (!Number.isFinite(volume) || volume < 0 || volume > 100) return sendJson(res, 400, { ok: false, error: '音量必须是 0~100 的数字' });
          patch.volume = volume;
        }
        if (body.sound !== undefined) {
          const file = safeSoundName(body.sound);
          if (file === null) return sendJson(res, 400, { ok: false, error: '音效名必须是单个 .wav 文件名' });
          patch.sound = file;
          // 兼容 1.3.0 及旧客户端：旧的单一 sound 字段等价于“完成”音效。
          const current = currentConfig();
          patch.events = {
            ...current.events,
            complete: { ...current.events.complete, sound: file },
          };
        }
        if (body.events !== undefined) {
          if (body.events === null || typeof body.events !== 'object' || Array.isArray(body.events)) {
            return sendJson(res, 400, { ok: false, error: 'events 必须是对象' });
          }
          const events = { ...(patch.events ?? currentConfig().events) };
          for (const [kind, value] of Object.entries(body.events)) {
            if (!Object.hasOwn(DEFAULT_CONFIG.events, kind) || value === null || typeof value !== 'object' || Array.isArray(value)) {
              return sendJson(res, 400, { ok: false, error: '未知音效事件: ' + kind });
            }
            const next = { ...events[kind] };
            if (value.enabled !== undefined) {
              if (typeof value.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: kind + '.enabled 必须是布尔值' });
              next.enabled = value.enabled;
            }
            if (value.sound !== undefined) {
              const file = safeSoundName(value.sound);
              if (file === null) return sendJson(res, 400, { ok: false, error: kind + '.sound 必须是单个 .wav 文件名' });
              next.sound = file;
            }
            events[kind] = next;
          }
          patch.events = events;
        }
        if (body.customDir !== undefined) {
          if (typeof body.customDir !== 'string') return sendJson(res, 400, { ok: false, error: 'customDir 必须是字符串' });
          patch.customDir = body.customDir;
        }
        await updateConfig(patch);
        return sendJson(res, 200, statePayload());
      }
      if (route === 'preview') {
        const config = currentConfig();
        const file = body.sound === undefined ? config.sound : safeSoundName(body.sound);
        if (file === null) return sendJson(res, 400, { ok: false, error: '音效名必须是单个 .wav 文件名' });
        const result = playSound(file);
        if (result.ok) return sendJson(res, 200, { ok: true, sound: file, volume: config.volume });
        return sendJson(res, 404, { ok: false, error: result.error });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
    }
  };
}

// ------------------------------------------------------------------ 装配 --

function apply(ctx) {
  ctxRef = ctx;

  ctx.effect(() => {
    ensureScope();
  }, 'dsh-aio-sound: settings namespace');

  ctx.effect(() => {
    const disposers = [];
    for (const [route, path] of [
      ['state', '/api/aio-sound/state'],
      ['config', '/api/aio-sound/config'],
      ['preview', '/api/aio-sound/preview'],
    ]) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path, handler: createHandler(route) }));
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* 卸载清理失败不影响其它路由 */ }
      }
    };
  }, 'dsh-aio-sound: http routes');

  // OpenCode 同类行为：只通知顶层会话，子代理不单独出声。
  ctx.on('session/event', (session, event) => {
    if (!isTopLevelSession(session)) return;
    const type = event !== null && typeof event === 'object' && typeof event.type === 'string' ? event.type : '';
    const data = event?.data ?? event;
    const sessionId = String(session?.id ?? 'session');
    if (type === 'turn/end') {
      const reason = data.reason?.kind;
      const key = `${sessionId}:${data.turn ?? 'turn'}`;
      if (reason === 'completed') playOnce('complete', key);
      else if (reason === 'aborted' && data.reason?.reason?.kind === 'user') playOnce('interrupted', key);
      else if (reason === 'error' || reason === 'blocked' || reason === 'max-tokens') playOnce('error', key);
    } else if (type === 'approval/asked') {
      playOnce('question', `${sessionId}:${data.id ?? event.seq ?? 'approval'}`);
    }
  });

  // 向用户提问（plan 询问 / AskUserQuestion）走的是 waterfall 请求而非 session
  // 事件，这里单独挂一个只出声、不参与回答的监听器：返回 undefined，不截断
  // waterfall 的答案链。
  ctx.on('user-questions/request', (request) => {
    const session = request?.agent?.session;
    const root = session?.header?.parentSession ?? session?.id ?? 'session';
    const ids = Array.isArray(request?.questions) ? request.questions.map((row) => row?.id ?? '').join(',') : 'question';
    playOnce('question', `${root}:${ids}`);
  });

  log('mounted: /api/aio-sound/{state,config,preview} + session/event playback');
}

export { apply, inject, name };
