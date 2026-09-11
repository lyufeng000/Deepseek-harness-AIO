/**
 * dsh-command-init — `/init` plus first-send AGENTS.md injection.
 *
 * Why first user message (not session-create): clicking 「新对话」 must not
 * start a model turn or leave a used empty session. The files are prepended
 * to the first human user message of each session (source.kind === 'user'),
 * which anchored-cn does not strip. `/init` re-arms injection for the next
 * send in the same session.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

export const name = 'command-init';
export const inject = ['commands'];

/** Marker so a session injects at most once unless `/init` re-arms. */
export const INIT_MARKER = '<!-- dsh-init-agents -->';
const MAX_FILE_BYTES = 64 * 1024;
const PROJECT_CANDIDATES = ['AGENTS.md', 'AGENTS.local.md'];
const ROOT_MARKERS = ['.git', '.hg', '.svn'];

/**
 * @param {string} file
 * @returns {Promise<{ path: string, text: string } | null>}
 */
export async function readAgentFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    if (info.size > MAX_FILE_BYTES) {
      return { path: file, text: `（已跳过：超过 ${MAX_FILE_BYTES} 字节）` };
    }
    const text = await readFile(file, 'utf8');
    if (text.trim().length === 0) return null;
    return { path: file, text };
  } catch {
    return null;
  }
}

/**
 * Walk from cwd up to the VCS root (or filesystem root).
 * @param {string} cwd
 * @returns {Promise<string[]>} directories from project root down to cwd
 */
export async function projectDirs(cwd) {
  const chain = [];
  let current = cwd;
  for (;;) {
    chain.push(current);
    let rooted = false;
    for (const marker of ROOT_MARKERS) {
      try {
        await stat(join(current, marker));
        rooted = true;
        break;
      } catch {
        // marker absent
      }
    }
    if (rooted) break;
    const parent = dirname(current);
    if (parent === current || parent.length === 0) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * Collect user-global then project AGENTS.md / AGENTS.local.md.
 * @param {{ cwd?: string, dshHome?: string }} scope
 * @returns {Promise<{ path: string, text: string }[]>}
 */
export async function collectAgentFiles(scope) {
  const found = [];
  const seen = new Set();
  const push = async (file) => {
    if (!file || seen.has(file)) return;
    const entry = await readAgentFile(file);
    if (entry === null) return;
    seen.add(file);
    found.push(entry);
  };
  const dshHome = typeof scope.dshHome === 'string' ? scope.dshHome : '';
  if (dshHome) await push(join(dshHome, 'AGENTS.md'));
  const cwd = typeof scope.cwd === 'string' ? scope.cwd : '';
  if (cwd) {
    for (const dir of await projectDirs(cwd)) {
      for (const name of PROJECT_CANDIDATES) await push(join(dir, name));
    }
  }
  return found;
}

/**
 * @param {{ path: string, text: string }[]} files
 * @returns {string}
 */
export function formatInitBlock(files) {
  if (files.length === 0) {
    return `${INIT_MARKER}\n未找到 AGENTS.md。`;
  }
  const body = files.map((file) => {
    const label = file.path.split(/[/\\]/).slice(-2).join(sep);
    return `## ${label}\n\n${file.text.trimEnd()}`;
  }).join('\n\n');
  return `${INIT_MARKER}\n# AGENTS.md\n\n${body}`;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
}

export function messageHasMarker(message) {
  return textOf(message).includes(INIT_MARKER);
}

function isHumanUser(message) {
  const kind = message?.source?.kind;
  if (kind === 'user') return true;
  if (kind === 'agent-instructions' || kind === 'instruction-hint' || kind === 'skill-catalog') return false;
  return message?.role === 'user' && kind !== 'command-init';
}

/**
 * Prepend the init block to a user message without mutating the original.
 * @param {object} message
 * @param {string} block
 */
export function prependInitBlock(message, block) {
  const prefix = { type: 'text', text: `${block}\n\n` };
  const content = message?.content;
  if (Array.isArray(content)) return { ...message, content: [prefix, ...content] };
  if (typeof content === 'string') return { ...message, content: `${block}\n\n${content}` };
  return { ...message, content: [prefix] };
}

function sessionHasAssistant(agent) {
  try {
    const session = agent?.session;
    if (!session) return false;
    if (typeof session.snapshotEvents === 'function') {
      for (const event of session.snapshotEvents()) {
        if (event?.type === 'assistant/message') return true;
      }
    }
    const nodes = session.surface?.nodes;
    if (Array.isArray(nodes) && typeof session.eventAt === 'function') {
      for (const seq of nodes) {
        const event = session.eventAt(seq);
        if (event?.type === 'assistant/message') return true;
      }
    }
  } catch {
    // degrade to "no assistant yet"
  }
  return false;
}

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  const force = new WeakMap();

  ctx.effect(() => ctx.commands.register({
    name: 'init',
    description: '阅读 AGENTS.md，并在下一次发送时注入到用户正文',
    handler: ({ agent }) => {
      try {
        if (agent?.session) force.set(agent.session, true);
      } catch {
        // ignore
      }
      return { kind: 'success', text: '已安排在下一次发送时注入 AGENTS.md。' };
    },
  }), 'command-init: /init');

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision;
      const messages = decision.messages;
      if (messages.some(messageHasMarker)) return decision;
      const forced = agent?.session ? force.get(agent.session) === true : false;
      if (!forced && sessionHasAssistant(agent)) return decision;
      const index = messages.findIndex(isHumanUser);
      if (index < 0) return decision;
      const cwd = agent?.session?.header?.cwd;
      const dshHome = process.env.DSH_HOME || '';
      const files = await collectAgentFiles({ cwd, dshHome });
      const block = formatInitBlock(files);
      const nextMessages = messages.slice();
      nextMessages[index] = prependInitBlock(messages[index], block);
      if (forced && agent?.session) force.delete(agent.session);
      return { ...decision, messages: nextMessages };
    } catch (error) {
      try { ctx.logger?.warn?.('command-init pre-step failed: %o', error); } catch { /* ignore */ }
      return decision;
    }
  });
}
