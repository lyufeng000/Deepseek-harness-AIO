type Invoke = (command: string, args?: Record<string, unknown>) => Promise<any>;

export function installClientUpdateUi(invoke: Invoke, events: any): { show: () => Promise<void> } {
  let dialog: HTMLDialogElement | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const call = (action: string, extra = {}) => invoke('client_update', { action, ...extra });
  const close = () => { if (interval) clearInterval(interval); interval = undefined; dialog?.close(); dialog?.remove(); dialog = undefined; };
  const open = () => {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'DSHEAC AIO 客户端更新');
    dialog.style.cssText = 'width:min(520px,90vw);max-height:80vh;border:1px solid #7c8394;border-radius:16px;padding:24px;background:#18202d;color:#f1f5f9;font:15px/1.6 system-ui;z-index:2147483647;box-shadow:0 20px 80px #0008';
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (!busy) close(); });
    document.body.appendChild(dialog); dialog.showModal(); return dialog;
  };
  const text = (parent: HTMLElement, tag: string, value: string) => {
    const node = document.createElement(tag); node.textContent = value; parent.appendChild(node); return node;
  };
  const button = (parent: HTMLElement, label: string, fn: () => unknown) => {
    const element = document.createElement('button'); element.textContent = label;
    element.style.cssText = 'margin:12px 8px 0 0;padding:8px 16px;border:1px solid #64748b;border-radius:8px;cursor:pointer;background:#27364a;color:white;font:inherit';
    element.onclick = () => { Promise.resolve().then(fn).catch(showError); };
    parent.appendChild(element); return element;
  };
  const showError = (error: unknown) => {
    busy = false; const root = open(); root.replaceChildren(); text(root, 'h2', '更新未完成');
    text(root, 'p', String(error)); button(root, '重试检查', show); button(root, '关闭', close);
  };
  async function render(state: any) {
    busy = false;
    const root = open(); root.replaceChildren(); text(root, 'h2', 'DSHEAC AIO 更新');
    if (state.release) {
      text(root, 'p', `当前 ${state.currentVersion} → 新版 ${state.release.version} · ${(state.release.asset.size / 1048576).toFixed(1)} MB`);
      const notes = text(root, 'div', state.release.notes || '此版本未提供更新说明。'); notes.style.cssText = 'max-height:220px;overflow:auto;white-space:pre-wrap';
    }
    if (state.phase === 'available') {
      button(root, '更新', async () => { await render(await call('download')); poll(); });
      button(root, '取消', close);
      button(root, '不再通知', async () => { await call('notifications', { enabled: false }); close(); });
    } else if (state.phase === 'downloading') {
      const progress = document.createElement('progress'); progress.max = state.release.asset.size; progress.value = state.received; progress.style.width = '100%'; root.appendChild(progress);
      text(root, 'p', `已下载 ${(state.received / 1048576).toFixed(1)} MB。中断后可继续下载。`);
      button(root, '暂停下载', async () => { await call('cancel'); });
    } else if (state.phase === 'ready') {
      text(root, 'p', '下载与校验完成。安装将关闭应用并可能中断正在运行的任务，请先保存工作。配置和会话数据将保留；安装失败会尝试恢复旧版本。');
      button(root, '确认中断任务并安装', async () => {
        busy = true; root.replaceChildren(); text(root, 'h2', '正在交接更新'); text(root, 'p', '请勿关闭电脑。应用将退出，更新助手备份旧程序后安装，验证成功后重新打开。');
        await call('install');
      });
      button(root, '稍后安装', close);
    } else if (['failed', 'cancelled'].includes(state.phase)) {
      text(root, 'p', state.error || '更新未完成。');
      if (state.release) button(root, '重试下载', async () => { await render(await call('download')); poll(); });
      else button(root, '重试检查', show);
      button(root, '关闭', close);
    } else if (state.phase === 'installing') {
      busy = true; text(root, 'p', '更新助手正在处理，请稍候。');
    } else {
      text(root, 'p', state.phase === 'checking' ? '正在检查更新…' : `当前版本 ${state.currentVersion}，暂无可用的新版本。`);
      button(root, '关闭', close);
    }
  }
  function poll() {
    if (interval) clearInterval(interval);
    let checking = false;
    interval = setInterval(async () => {
      if (checking || !dialog) return; checking = true;
      try { const state = await call('status'); await render(state); if (state.phase !== 'downloading' && interval) { clearInterval(interval); interval = undefined; } }
      catch (error) { if (interval) clearInterval(interval); showError(error); }
      finally { checking = false; }
    }, 700);
  }
  async function show() {
    open().replaceChildren(); text(open(), 'p', '正在检查更新…');
    try { const state = await call('check'); await render(state); if (state.phase === 'downloading') poll(); } catch (error) { showError(error); }
  }
  let disposed = false, unlisten: (() => void) | undefined;
  events?.listen?.('aio:update', (event: any) => { if (!disposed && !dialog) void render(event.payload); })
    .then((fn: () => void) => { if (disposed) fn(); else unlisten = fn; }).catch(() => {});
  window.addEventListener('beforeunload', () => { disposed = true; unlisten?.(); if (interval) clearInterval(interval); });
  return { show };
}
