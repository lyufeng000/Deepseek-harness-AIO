// DSH Desktop (Tauri) — 注入脚本：window.dshDesktop 桥 + 自绘窗口栏。
//
// 这是 Electron preload.js 的 WebView initialization script 移植版，在
// loading/recovery/dsh web UI 所有页面注入：
//   1. window.dshDesktop：与 Electron 版完全相同的 API 形状，底层改为
//      Tauri invoke / event（dsh Web UI 与插件零改动）。
//   2. 36px 玻璃自绘标题栏：拖拽区（data-tauri-drag-region）、图标、标题、
//      版本徽标、⋯ 菜单、最小化/最大化/关闭。
//   3. 心跳（5s）、页面异常转发、余额推送转 CustomEvent、快捷键
//      （F11/F12/Ctrl+R）、window.open 与 target=_blank 转系统浏览器。

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;
import { installClientUpdateUi } from './client-update';

const BAR_ID = '__dsh_desktop_chrome__';
const BAR_HEIGHT = 36;

const tauriCore = () => window.__TAURI__?.core;
const tauriEvent = () => window.__TAURI__?.event;

function invoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const core = tauriCore();
  if (!core?.invoke) {
    return Promise.reject(new Error('desktop bridge unavailable'));
  }
  return core.invoke(cmd, args ?? {});
}

// ---------------------------------------------------------------------------
// Bridge（形状与 Electron preload.js 一致；dsh-balance 等插件零改动消费）
// ---------------------------------------------------------------------------

const dshDesktop = {
  clientUpdate: {
    check: () => invoke('client_update', { action: 'check' }),
    status: () => invoke('client_update', { action: 'status' }),
    download: () => invoke('client_update', { action: 'download' }),
    cancel: () => invoke('client_update', { action: 'cancel' }),
    setNotifications: (enabled: boolean) => invoke('client_update', { action: 'notifications', enabled }),
    install: () => invoke('client_update', { action: 'install' }),
  },
  appVersion: '',
  windowControls: {
    minimize: () => invoke('chrome_window', { action: 'minimize' }),
    toggleMaximize: () => invoke('chrome_window', { action: 'toggle-maximize' }),
    close: () => invoke('chrome_window', { action: 'close' }),
    isMaximized: () => invoke('chrome_window', { action: 'is-maximized' }),
    onMaximizeChange: (cb: (isMax: boolean) => void) => {
      const ev = tauriEvent();
      if (!ev?.listen) return () => {};
      let unlisten: (() => void) | null = null;
      ev.listen('chrome:maximized', (e: any) => {
        try { cb(!!e?.payload); } catch { /* ignore */ }
      }).then((fn: any) => { unlisten = typeof fn === 'function' ? fn : null; }).catch(() => {});
      return () => { try { unlisten?.(); } catch { /* ignore */ } };
    },
  },
  menu: {
    action: (action: string, payload?: Record<string, unknown>) =>
      invoke('chrome_menu', { action, value: payload?.value ?? null }),
  },
  getInfo: () => invoke('chrome_init'),
  refreshBalance: () => invoke('balance_refresh'),
  balancePrices: {
    get: (model: string) => invoke('balance_prices_get', { model: model ?? null }),
    set: (model: string, prices: any) => invoke('balance_prices_set', { model: model ?? null, prices: prices ?? null }),
    reset: (model: string) => invoke('balance_prices_reset', { model: model ?? null }),
  },
  restartService: () => invoke('chrome_restart_service', { intent: 'restart-service' }),
  guard: {
    action: (action: string, value?: unknown) => invoke('guard_action', { action, value: value ?? null }),
  },
  pluginManager: {
    list: () => invoke('plugin_list'),
    setEnabled: (id: string, enabled: boolean) => invoke('plugin_set_enabled', { id, enabled }),
    setRemoved: (id: string, removed: boolean) => invoke('plugin_set_removed', { id, removed }),
  },
  pluginUpdates: {
    list: (force = false) => invoke('plugin_updates', { force }),
    update: (id: string) => invoke('plugin_update', { id }),
    setAutoUpdate: (enabled: boolean) => invoke('plugin_auto_update', { enabled }),
  },
  openExternal: (url: string) => invoke('open_external', { url }),
  recovery: {
    getState: () => invoke('recovery_state'),
    reload: () => invoke('recovery_reload'),
    restart: () => invoke('recovery_restart'),
    openLogs: () => invoke('recovery_open_logs'),
  },
};

window.dshDesktop = dshDesktop;
const clientUpdateUi = installClientUpdateUi(invoke, tauriEvent());

// ---------------------------------------------------------------------------
// 页面异常 → 主进程日志；余额推送 → CustomEvent
// ---------------------------------------------------------------------------

window.addEventListener('error', (e: any) => {
  try {
    invoke('page_error', { payload: 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown') }).catch(() => {});
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e: any) => {
  try {
    invoke('page_error', { payload: 'unhandledrejection: ' + String((e && e.reason && (e.reason.message || e.reason)) || e) }).catch(() => {});
  } catch { /* ignore */ }
});

{
  const ev = tauriEvent();
  ev?.listen?.('dsh:balance', (e: any) => {
    try { window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: e?.payload })); } catch { /* ignore */ }
  }).catch?.(() => {});
}

// ---------------------------------------------------------------------------
// window.open / target=_blank → 系统浏览器（Electron setWindowOpenHandler 语义）
// ---------------------------------------------------------------------------

{
  const origOpen = window.open?.bind(window);
  window.open = (url?: string | URL, ...rest: any[]) => {
    const u = url == null ? '' : String(url);
    if (/^https?:\/\//i.test(u)) {
      invoke('open_external', { url: u }).catch(() => {});
      return null;
    }
    return origOpen ? origOpen(url as any, ...(rest as [any])) : null;
  };
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      invoke('open_external', { url: href }).catch(() => {});
    }
  }, true);
}

// ---------------------------------------------------------------------------
// 快捷键（Electron before-input-event 的等价物）
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.type !== 'keydown') return;
  const key = String(e.key || '').toLowerCase();
  if (e.key === 'F11') {
    invoke('chrome_menu', { action: 'fullscreen' }).catch(() => {});
    e.preventDefault();
  } else if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && key === 'i')) {
    invoke('chrome_menu', { action: 'devtools' }).catch(() => {});
    e.preventDefault();
  } else if (e.ctrlKey && key === 'r') {
    invoke('chrome_menu', { action: 'reload' }).catch(() => {});
    e.preventDefault();
  }
});

// ---------------------------------------------------------------------------
// Chrome DOM（36px 玻璃标题栏；拖拽用 data-tauri-drag-region）
// ---------------------------------------------------------------------------

const CHROME_CSS = `
#${BAR_ID}{position:fixed;top:0;left:0;right:0;height:${BAR_HEIGHT}px;z-index:2147483000;
  display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 10px;
  user-select:none;box-sizing:border-box;
  font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 74%,transparent);
  backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(255,255,255,.09)) 55%,transparent)}
#${BAR_ID} .dch-left{display:flex;align-items:center;gap:8px;min-width:0}
#${BAR_ID} .dch-icon{width:20px;height:20px;border-radius:6px;display:block;flex:none;
  background:#f6f8fc;box-shadow:0 1px 3px rgba(0,0,0,.35)}
#${BAR_ID} .dch-title{font-size:12.5px;font-weight:600;letter-spacing:.2px;line-height:16px;
  color:var(--dsw-alias-label-primary,#e6ecff);white-space:nowrap}
#${BAR_ID} .dch-badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;
  color:var(--dsw-alias-label-tertiary,#93a5d8);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));
  white-space:nowrap;font-family:var(--ds-font-family-code,Consolas,monospace)}
#${BAR_ID} .dch-right{display:flex;align-items:center;gap:2px}
#${BAR_ID} .dch-btn{width:30px;height:28px;display:grid;place-items:center;border:none;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,#b8c5ea);cursor:pointer;padding:0;
  outline:none;transition:background .12s,color .12s}
#${BAR_ID} .dch-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.09));
  color:var(--dsw-alias-label-primary,#eef2ff)}
#${BAR_ID} .dch-btn:active{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.14))}
#${BAR_ID} .dch-close:hover{background:#e81123;color:#fff}
#${BAR_ID} .dch-menu{position:fixed;top:${BAR_HEIGHT + 8}px;right:8px;width:272px;z-index:2147483001;
  box-sizing:border-box;padding:6px;
  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--dsw-alias-bg-base,#0b1220) 92%,white));
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);
  backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
  color:var(--dsw-alias-label-primary,#e6ecff);font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif)}
#${BAR_ID} .dch-mh{padding:8px 10px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
  margin-bottom:6px}
#${BAR_ID} .dch-mh-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
#${BAR_ID} .dch-mh-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9ac4);margin-top:3px;
  line-height:16px;display:flex;gap:8px;flex-wrap:wrap}
#${BAR_ID} .dch-item{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:5px 10px;
  border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#dbe4f8);
  font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
#${BAR_ID} .dch-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
#${BAR_ID} .dch-item .dch-kbd{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#5f6f9c);
  font-family:var(--ds-font-family-code,Consolas,monospace)}
#${BAR_ID} .dch-item .dch-check{margin-left:auto;color:var(--dsw-alias-state-success-primary,#3ddc84);font-size:12px}
#${BAR_ID} .dch-item[data-danger="1"]{color:var(--dsw-alias-state-error-primary,#ff7a85)}
#${BAR_ID} .dch-sep{height:1px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));margin:5px 6px}
#${BAR_ID} .dch-exit-group{padding:2px 0}
#${BAR_ID} .dch-exit-title{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b9ac4);padding:2px 10px 3px}
#${BAR_ID} .dch-exit-item{min-height:26px;font-size:12px;color:var(--dsw-alias-label-secondary,#b8c5ea)}
`;

const GLYPHS = {
  menu: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.4" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="9.6" cy="6" r="1.15"/></svg>',
  min: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
  max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
  restore: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
};

let menuOpen = false;
let menuEl: HTMLElement | null = null;
let maxBtn: HTMLElement | null = null;
let state = { appVersion: '', agentVersion: '', agentSource: '', closeToTray: true, exitAction: 'ask', shortcutPolicy: 'auto' };

const EXIT_ACTIONS = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '后台运行（最小化到托盘）' },
  { value: 'quit', label: '直接退出' },
];

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function displayVersion(value: unknown): string {
  const version = String(value == null ? '' : value).trim();
  if (!version) return '';
  return /^v/i.test(version) ? version : `v${version}`;
}

function renderMenu() {
  if (!menuEl) return;
  menuEl.innerHTML = `
    <div class="dch-mh">
      <div class="dch-mh-title">DSHEAC AIO <span style="font-weight:400;color:var(--dsw-alias-label-tertiary)">All-in-One ${esc(state.appVersion)}</span></div>
      <div class="dch-mh-sub"><span>agent v${esc(state.agentVersion)}</span><span>${esc(state.agentSource)}</span></div>
    </div>
    <button class="dch-item" data-act="toggle-shortcut-policy"><span>桌面快捷方式自动维护</span>${state.shortcutPolicy !== 'never' ? '<span class="dch-check">✓</span>' : ''}</button>
    <div class="dch-exit-group">
      <div class="dch-exit-title">关闭窗口时</div>
      ${EXIT_ACTIONS.map((opt) => `<button class="dch-item dch-exit-item" data-act="set-exit-action" data-value="${opt.value}"><span>${opt.label}</span>${state.exitAction === opt.value ? '<span class="dch-check">✓</span>' : ''}</button>`).join('')}
    </div>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="restart-service"><span>重启 Web 服务</span><span class="dch-kbd">不关闭应用</span></button>
    <button class="dch-item" data-act="reload"><span>重新加载</span><span class="dch-kbd">Ctrl+R</span></button>
    <button class="dch-item" data-act="devtools"><span>开发者工具</span><span class="dch-kbd">F12</span></button>
    <button class="dch-item" data-act="fullscreen"><span>全屏</span><span class="dch-kbd">F11</span></button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="open-browser">在浏览器中打开</button>
    <button class="dch-item" data-act="open-logs">打开日志目录</button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="client-update">检查更新</button>
    <button class="dch-item" data-act="about">关于 DSHEAC AIO</button>
    <button class="dch-item" data-danger="1" data-act="quit">退出</button>`;
  menuEl.querySelectorAll('.dch-item').forEach((item) => {
    (item as HTMLElement).addEventListener('click', async () => {
      const act = (item as HTMLElement).dataset.act;
      if (act === 'toggle-shortcut-policy' || act === 'set-exit-action') {
        try {
          const next = await dshDesktop.menu.action(act, { value: (item as HTMLElement).dataset.value });
          if (next) state = { ...state, ...next };
        } catch { /* ignore */ }
        renderMenu();
        return;
      }
      closeMenu();
      if (act === 'client-update') { void clientUpdateUi.show(); return; }
      try { dshDesktop.menu.action(act); } catch { /* ignore */ }
    });
  });
}

function closeMenu() {
  menuOpen = false;
  if (menuEl) (menuEl as HTMLElement & { hidden: boolean }).hidden = true;
}

function openMenu() {
  if (!menuEl) return;
  dshDesktop.getInfo().then((info: any) => {
    if (info) state = { ...state, ...info };
    renderMenu();
    menuOpen = true;
    (menuEl as HTMLElement & { hidden: boolean }).hidden = false;
  }).catch(() => {
    renderMenu();
    menuOpen = true;
    (menuEl as HTMLElement & { hidden: boolean }).hidden = false;
  });
}

function setMaximized(isMax: boolean) {
  if (!maxBtn) return;
  maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
  maxBtn.title = isMax ? '还原' : '最大化';
  maxBtn.setAttribute('aria-label', maxBtn.title);
}

function injectChrome() {
  if (document.getElementById(BAR_ID)) return;
  const style = document.createElement('style');
  style.textContent = CHROME_CSS;
  document.head.appendChild(style);

  // 声明自绘标题栏高度：better-sidebar 等客户端插件据此自动下移其 fixed
  // 定位的顶部元素；dsh web 本体不消费该属性，不会双重下移。
  document.documentElement.setAttribute('data-dsh-title-bar-height', String(BAR_HEIGHT));

  // 内容区整体下移，避免遮挡 Web UI 顶部。
  const layout = document.createElement('style');
  layout.textContent = `body{box-sizing:border-box!important;padding-top:${BAR_HEIGHT}px!important}`;
  document.head.appendChild(layout);

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.setAttribute('data-tauri-drag-region', 'true');
  bar.innerHTML = `
    <div class="dch-left" data-tauri-drag-region="true">
      <img class="dch-icon" alt="" draggable="false" data-tauri-drag-region="true" />
      <span class="dch-title" data-tauri-drag-region="true">DSHEAC AIO</span>
      <span class="dch-badge" hidden data-tauri-drag-region="true"></span>
    </div>
    <div class="dch-right">
      <button class="dch-btn" data-act="menu" title="菜单" aria-label="菜单">${GLYPHS.menu}</button>
      <button class="dch-btn" data-act="min" title="最小化" aria-label="最小化">${GLYPHS.min}</button>
      <button class="dch-btn" data-act="max" title="最大化" aria-label="最大化">${GLYPHS.max}</button>
      <button class="dch-btn dch-close" data-act="close" title="关闭" aria-label="关闭">${GLYPHS.close}</button>
    </div>
    <div class="dch-menu" hidden></div>`;
  document.body.appendChild(bar);

  const badge = bar.querySelector('.dch-badge') as HTMLElement;
  const icon = bar.querySelector('.dch-icon') as HTMLImageElement;
  maxBtn = bar.querySelector('[data-act="max"]');
  menuEl = bar.querySelector('.dch-menu') as HTMLElement;

  bar.querySelector('[data-act="min"]')!.addEventListener('click', () => dshDesktop.windowControls.minimize());
  bar.querySelector('[data-act="max"]')!.addEventListener('click', () => dshDesktop.windowControls.toggleMaximize());
  bar.querySelector('.dch-close')!.addEventListener('click', () => dshDesktop.windowControls.close());
  bar.querySelector('[data-act="menu"]')!.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOpen) closeMenu(); else openMenu();
  });

  document.addEventListener('click', (e) => {
    if (menuOpen && !bar.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // 初始化状态
  dshDesktop.getInfo().then((info: any) => {
    if (!info) return;
    state = { ...state, ...info };
    if (info.appVersion) {
      badge.textContent = displayVersion(info.appVersion);
      badge.hidden = false;
    }
    if (info.agentVersion) badge.title = 'agent v' + info.agentVersion + '（' + info.agentSource + '）';
    if (info.iconDataUri) icon.src = info.iconDataUri;
  }).catch(() => { /* ignore */ });
  dshDesktop.windowControls.isMaximized().then(setMaximized).catch(() => { /* ignore */ });
  dshDesktop.windowControls.onMaximizeChange(setMaximized);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectChrome);
} else {
  injectChrome();
}

// ---------------------------------------------------------------------------
// Renderer 心跳：每 5s 上报一次；恢复状态机用它兜底判定挂起/崩溃。
// ---------------------------------------------------------------------------

{
  const beat = () => {
    invoke('renderer_heartbeat').catch(() => {});
  };
  beat();
  setInterval(beat, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });
}

export {};
