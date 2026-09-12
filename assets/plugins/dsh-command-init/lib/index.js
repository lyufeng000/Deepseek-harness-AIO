/**
 * dsh-command-init — `/init` requests a hidden AGENTS.md baseline refresh.
 *
 * The official `dsh-agent-instructions` plugin owns discovery, scoping,
 * replacement metadata, persistence, resume and compaction. This plugin only
 * records a per-session refresh request; it never reads files, injects a second
 * message, or changes the user's text.
 */

export const name = 'command-init';
export const inject = ['commands'];
export const REFRESH_SYMBOL = Symbol.for('dsh.eac.agent-instructions.refresh.v1');

/** Return the process-wide weak set shared with the controlled kernel patch. */
export function refreshSessions() {
  const existing = globalThis[REFRESH_SYMBOL];
  if (existing instanceof WeakSet) return existing;
  const created = new WeakSet();
  Object.defineProperty(globalThis, REFRESH_SYMBOL, {
    value: created,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return created;
}

/** Register `/init`; clicking it does not start a model request. */
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'init',
    description: '重新读取 AGENTS.md，并在下一次请求中隐式生效',
    handler: ({ agent }) => {
      const session = agent?.session;
      if (session === undefined || session === null || typeof session !== 'object') {
        return { kind: 'error', text: '当前没有可刷新的会话。' };
      }
      refreshSessions().add(session);
      return { kind: 'success', text: '已安排重新读取 AGENTS.md；不会改写你的消息。' };
    },
  }), 'command-init: /init');
}
