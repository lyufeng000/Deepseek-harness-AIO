(() => {
  // tauri-app/frontend/client-update.ts
  function installClientUpdateUi(invoke2, events) {
    let dialog;
    let interval;
    let busy = false;
    const call = (action, extra = {}) => invoke2("client_update", { action, ...extra });
    const close = () => {
      if (interval) clearInterval(interval);
      interval = void 0;
      dialog?.close();
      dialog?.remove();
      dialog = void 0;
    };
    const open = () => {
      if (dialog) return dialog;
      dialog = document.createElement("dialog");
      dialog.setAttribute("aria-label", "DSHEAC AIO \u5BA2\u6237\u7AEF\u66F4\u65B0");
      dialog.style.cssText = "width:min(520px,90vw);max-height:80vh;border:1px solid #7c8394;border-radius:16px;padding:24px;background:#18202d;color:#f1f5f9;font:15px/1.6 system-ui;z-index:2147483647;box-shadow:0 20px 80px #0008";
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        if (!busy) close();
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      return dialog;
    };
    const text = (parent, tag, value) => {
      const node = document.createElement(tag);
      node.textContent = value;
      parent.appendChild(node);
      return node;
    };
    const button = (parent, label, fn) => {
      const element = document.createElement("button");
      element.textContent = label;
      element.style.cssText = "margin:12px 8px 0 0;padding:8px 16px;border:1px solid #64748b;border-radius:8px;cursor:pointer;background:#27364a;color:white;font:inherit";
      element.onclick = () => {
        Promise.resolve().then(fn).catch(showError);
      };
      parent.appendChild(element);
      return element;
    };
    const showError = (error) => {
      busy = false;
      const root = open();
      root.replaceChildren();
      text(root, "h2", "\u66F4\u65B0\u672A\u5B8C\u6210");
      text(root, "p", String(error));
      button(root, "\u91CD\u8BD5\u68C0\u67E5", show);
      button(root, "\u5173\u95ED", close);
    };
    async function render(state2) {
      busy = false;
      const root = open();
      root.replaceChildren();
      text(root, "h2", "DSHEAC AIO \u66F4\u65B0");
      if (state2.release) {
        text(root, "p", `\u5F53\u524D ${state2.currentVersion} \u2192 \u65B0\u7248 ${state2.release.version} \xB7 ${(state2.release.asset.size / 1048576).toFixed(1)} MB`);
        const notes = text(root, "div", state2.release.notes || "\u6B64\u7248\u672C\u672A\u63D0\u4F9B\u66F4\u65B0\u8BF4\u660E\u3002");
        notes.style.cssText = "max-height:220px;overflow:auto;white-space:pre-wrap";
      }
      if (state2.phase === "available") {
        button(root, "\u66F4\u65B0", async () => {
          await render(await call("download"));
          poll();
        });
        button(root, "\u53D6\u6D88", close);
        button(root, "\u4E0D\u518D\u901A\u77E5", async () => {
          await call("notifications", { enabled: false });
          close();
        });
      } else if (state2.phase === "downloading") {
        const progress = document.createElement("progress");
        progress.max = state2.release.asset.size;
        progress.value = state2.received;
        progress.style.width = "100%";
        root.appendChild(progress);
        text(root, "p", `\u5DF2\u4E0B\u8F7D ${(state2.received / 1048576).toFixed(1)} MB\u3002\u4E2D\u65AD\u540E\u53EF\u7EE7\u7EED\u4E0B\u8F7D\u3002`);
        button(root, "\u6682\u505C\u4E0B\u8F7D", async () => {
          await call("cancel");
        });
      } else if (state2.phase === "ready") {
        text(root, "p", "\u4E0B\u8F7D\u4E0E\u6821\u9A8C\u5B8C\u6210\u3002\u5B89\u88C5\u5C06\u5173\u95ED\u5E94\u7528\u5E76\u53EF\u80FD\u4E2D\u65AD\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\uFF0C\u8BF7\u5148\u4FDD\u5B58\u5DE5\u4F5C\u3002\u914D\u7F6E\u548C\u4F1A\u8BDD\u6570\u636E\u5C06\u4FDD\u7559\uFF1B\u5B89\u88C5\u5931\u8D25\u4F1A\u5C1D\u8BD5\u6062\u590D\u65E7\u7248\u672C\u3002");
        button(root, "\u786E\u8BA4\u4E2D\u65AD\u4EFB\u52A1\u5E76\u5B89\u88C5", async () => {
          busy = true;
          root.replaceChildren();
          text(root, "h2", "\u6B63\u5728\u4EA4\u63A5\u66F4\u65B0");
          text(root, "p", "\u8BF7\u52FF\u5173\u95ED\u7535\u8111\u3002\u5E94\u7528\u5C06\u9000\u51FA\uFF0C\u66F4\u65B0\u52A9\u624B\u5907\u4EFD\u65E7\u7A0B\u5E8F\u540E\u5B89\u88C5\uFF0C\u9A8C\u8BC1\u6210\u529F\u540E\u91CD\u65B0\u6253\u5F00\u3002");
          await call("install");
        });
        button(root, "\u7A0D\u540E\u5B89\u88C5", close);
      } else if (["failed", "cancelled"].includes(state2.phase)) {
        text(root, "p", state2.error || "\u66F4\u65B0\u672A\u5B8C\u6210\u3002");
        if (state2.release) button(root, "\u91CD\u8BD5\u4E0B\u8F7D", async () => {
          await render(await call("download"));
          poll();
        });
        else button(root, "\u91CD\u8BD5\u68C0\u67E5", show);
        button(root, "\u5173\u95ED", close);
      } else if (state2.phase === "installing") {
        busy = true;
        text(root, "p", "\u66F4\u65B0\u52A9\u624B\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u5019\u3002");
      } else {
        text(root, "p", state2.phase === "checking" ? "\u6B63\u5728\u68C0\u67E5\u66F4\u65B0\u2026" : `\u5F53\u524D\u7248\u672C ${state2.currentVersion}\uFF0C\u6682\u65E0\u53EF\u7528\u7684\u65B0\u7248\u672C\u3002`);
        button(root, "\u5173\u95ED", close);
      }
    }
    function poll() {
      if (interval) clearInterval(interval);
      let checking = false;
      interval = setInterval(async () => {
        if (checking || !dialog) return;
        checking = true;
        try {
          const state2 = await call("status");
          await render(state2);
          if (state2.phase !== "downloading" && interval) {
            clearInterval(interval);
            interval = void 0;
          }
        } catch (error) {
          if (interval) clearInterval(interval);
          showError(error);
        } finally {
          checking = false;
        }
      }, 700);
    }
    async function show() {
      open().replaceChildren();
      text(open(), "p", "\u6B63\u5728\u68C0\u67E5\u66F4\u65B0\u2026");
      try {
        const state2 = await call("check");
        await render(state2);
        if (state2.phase === "downloading") poll();
      } catch (error) {
        showError(error);
      }
    }
    let disposed = false, unlisten;
    events?.listen?.("aio:update", (event) => {
      if (!disposed && !dialog) void render(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {
    });
    window.addEventListener("beforeunload", () => {
      disposed = true;
      unlisten?.();
      if (interval) clearInterval(interval);
    });
    return { show };
  }

  // tauri-app/frontend/chrome.ts
  var BAR_ID = "__dsh_desktop_chrome__";
  var BAR_HEIGHT = 36;
  var tauriCore = () => window.__TAURI__?.core;
  var tauriEvent = () => window.__TAURI__?.event;
  function invoke(cmd, args) {
    const core = tauriCore();
    if (!core?.invoke) {
      return Promise.reject(new Error("desktop bridge unavailable"));
    }
    return core.invoke(cmd, args ?? {});
  }
  var dshDesktop = {
    clientUpdate: {
      check: () => invoke("client_update", { action: "check" }),
      status: () => invoke("client_update", { action: "status" }),
      download: () => invoke("client_update", { action: "download" }),
      cancel: () => invoke("client_update", { action: "cancel" }),
      setNotifications: (enabled) => invoke("client_update", { action: "notifications", enabled }),
      install: () => invoke("client_update", { action: "install" })
    },
    appVersion: "",
    windowControls: {
      minimize: () => invoke("chrome_window", { action: "minimize" }),
      toggleMaximize: () => invoke("chrome_window", { action: "toggle-maximize" }),
      close: () => invoke("chrome_window", { action: "close" }),
      isMaximized: () => invoke("chrome_window", { action: "is-maximized" }),
      onMaximizeChange: (cb) => {
        const ev = tauriEvent();
        if (!ev?.listen) return () => {
        };
        let unlisten = null;
        ev.listen("chrome:maximized", (e) => {
          try {
            cb(!!e?.payload);
          } catch {
          }
        }).then((fn) => {
          unlisten = typeof fn === "function" ? fn : null;
        }).catch(() => {
        });
        return () => {
          try {
            unlisten?.();
          } catch {
          }
        };
      }
    },
    menu: {
      action: (action, payload) => invoke("chrome_menu", { action, value: payload?.value ?? null })
    },
    getInfo: () => invoke("chrome_init"),
    refreshBalance: () => invoke("balance_refresh"),
    balancePrices: {
      get: (model) => invoke("balance_prices_get", { model: model ?? null }),
      set: (model, prices) => invoke("balance_prices_set", { model: model ?? null, prices: prices ?? null }),
      reset: (model) => invoke("balance_prices_reset", { model: model ?? null })
    },
    restartService: () => invoke("chrome_restart_service", { intent: "restart-service" }),
    guard: {
      action: (action, value) => invoke("guard_action", { action, value: value ?? null })
    },
    pluginManager: {
      list: () => invoke("plugin_list"),
      setEnabled: (id, enabled) => invoke("plugin_set_enabled", { id, enabled }),
      setRemoved: (id, removed) => invoke("plugin_set_removed", { id, removed })
    },
    pluginUpdates: {
      list: (force = false) => invoke("plugin_updates", { force }),
      update: (id) => invoke("plugin_update", { id }),
      setAutoUpdate: (enabled) => invoke("plugin_auto_update", { enabled })
    },
    openExternal: (url) => invoke("open_external", { url }),
    recovery: {
      getState: () => invoke("recovery_state"),
      reload: () => invoke("recovery_reload"),
      restart: () => invoke("recovery_restart"),
      openLogs: () => invoke("recovery_open_logs")
    }
  };
  window.dshDesktop = dshDesktop;
  var clientUpdateUi = installClientUpdateUi(invoke, tauriEvent());
  window.addEventListener("error", (e) => {
    try {
      invoke("page_error", { payload: "window.onerror: " + (e && (e.message || e.error) || "unknown") }).catch(() => {
      });
    } catch {
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      invoke("page_error", { payload: "unhandledrejection: " + String(e && e.reason && (e.reason.message || e.reason) || e) }).catch(() => {
      });
    } catch {
    }
  });
  {
    const ev = tauriEvent();
    ev?.listen?.("dsh:balance", (e) => {
      try {
        window.dispatchEvent(new CustomEvent("dsh-balance-changed", { detail: e?.payload }));
      } catch {
      }
    }).catch?.(() => {
    });
  }
  {
    const origOpen = window.open?.bind(window);
    window.open = (url, ...rest) => {
      const u = url == null ? "" : String(url);
      if (/^https?:\/\//i.test(u)) {
        invoke("open_external", { url: u }).catch(() => {
        });
        return null;
      }
      return origOpen ? origOpen(url, ...rest) : null;
    };
    document.addEventListener("click", (e) => {
      const target = e.target;
      const anchor = target?.closest?.('a[target="_blank"]');
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        invoke("open_external", { url: href }).catch(() => {
        });
      }
    }, true);
  }
  document.addEventListener("keydown", (e) => {
    if (e.type !== "keydown") return;
    const key = String(e.key || "").toLowerCase();
    if (e.key === "F11") {
      invoke("chrome_menu", { action: "fullscreen" }).catch(() => {
      });
      e.preventDefault();
    } else if (e.key === "F12" || e.ctrlKey && e.shiftKey && key === "i") {
      invoke("chrome_menu", { action: "devtools" }).catch(() => {
      });
      e.preventDefault();
    } else if (e.ctrlKey && key === "r") {
      invoke("chrome_menu", { action: "reload" }).catch(() => {
      });
      e.preventDefault();
    }
  });
  var CHROME_CSS = `
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
  var GLYPHS = {
    menu: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.4" cy="6" r="1.15"/><circle cx="6" cy="6" r="1.15"/><circle cx="9.6" cy="6" r="1.15"/></svg>',
    min: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
    max: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
    restore: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>'
  };
  var menuOpen = false;
  var menuEl = null;
  var maxBtn = null;
  var state = { appVersion: "", agentVersion: "", agentSource: "", closeToTray: true, exitAction: "ask", shortcutPolicy: "auto" };
  var EXIT_ACTIONS = [
    { value: "ask", label: "\u6BCF\u6B21\u8BE2\u95EE" },
    { value: "minimize", label: "\u540E\u53F0\u8FD0\u884C\uFF08\u6700\u5C0F\u5316\u5230\u6258\u76D8\uFF09" },
    { value: "quit", label: "\u76F4\u63A5\u9000\u51FA" }
  ];
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function displayVersion(value) {
    const version = String(value == null ? "" : value).trim();
    if (!version) return "";
    return /^v/i.test(version) ? version : `v${version}`;
  }
  function renderMenu() {
    if (!menuEl) return;
    menuEl.innerHTML = `
    <div class="dch-mh">
      <div class="dch-mh-title">DSHEAC AIO <span style="font-weight:400;color:var(--dsw-alias-label-tertiary)">All-in-One ${esc(state.appVersion)}</span></div>
      <div class="dch-mh-sub"><span>agent v${esc(state.agentVersion)}</span><span>${esc(state.agentSource)}</span></div>
    </div>
    <button class="dch-item" data-act="toggle-shortcut-policy"><span>\u684C\u9762\u5FEB\u6377\u65B9\u5F0F\u81EA\u52A8\u7EF4\u62A4</span>${state.shortcutPolicy !== "never" ? '<span class="dch-check">\u2713</span>' : ""}</button>
    <div class="dch-exit-group">
      <div class="dch-exit-title">\u5173\u95ED\u7A97\u53E3\u65F6</div>
      ${EXIT_ACTIONS.map((opt) => `<button class="dch-item dch-exit-item" data-act="set-exit-action" data-value="${opt.value}"><span>${opt.label}</span>${state.exitAction === opt.value ? '<span class="dch-check">\u2713</span>' : ""}</button>`).join("")}
    </div>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="restart-service"><span>\u91CD\u542F Web \u670D\u52A1</span><span class="dch-kbd">\u4E0D\u5173\u95ED\u5E94\u7528</span></button>
    <button class="dch-item" data-act="reload"><span>\u91CD\u65B0\u52A0\u8F7D</span><span class="dch-kbd">Ctrl+R</span></button>
    <button class="dch-item" data-act="devtools"><span>\u5F00\u53D1\u8005\u5DE5\u5177</span><span class="dch-kbd">F12</span></button>
    <button class="dch-item" data-act="fullscreen"><span>\u5168\u5C4F</span><span class="dch-kbd">F11</span></button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="open-browser">\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00</button>
    <button class="dch-item" data-act="open-logs">\u6253\u5F00\u65E5\u5FD7\u76EE\u5F55</button>
    <div class="dch-sep"></div>
    <button class="dch-item" data-act="client-update">\u68C0\u67E5\u66F4\u65B0</button>
    <button class="dch-item" data-act="about">\u5173\u4E8E DSHEAC AIO</button>
    <button class="dch-item" data-danger="1" data-act="quit">\u9000\u51FA</button>`;
    menuEl.querySelectorAll(".dch-item").forEach((item) => {
      item.addEventListener("click", async () => {
        const act = item.dataset.act;
        if (act === "toggle-shortcut-policy" || act === "set-exit-action") {
          try {
            const next = await dshDesktop.menu.action(act, { value: item.dataset.value });
            if (next) state = { ...state, ...next };
          } catch {
          }
          renderMenu();
          return;
        }
        closeMenu();
        if (act === "client-update") {
          void clientUpdateUi.show();
          return;
        }
        try {
          dshDesktop.menu.action(act);
        } catch {
        }
      });
    });
  }
  function closeMenu() {
    menuOpen = false;
    if (menuEl) menuEl.hidden = true;
  }
  function openMenu() {
    if (!menuEl) return;
    dshDesktop.getInfo().then((info) => {
      if (info) state = { ...state, ...info };
      renderMenu();
      menuOpen = true;
      menuEl.hidden = false;
    }).catch(() => {
      renderMenu();
      menuOpen = true;
      menuEl.hidden = false;
    });
  }
  function setMaximized(isMax) {
    if (!maxBtn) return;
    maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
    maxBtn.title = isMax ? "\u8FD8\u539F" : "\u6700\u5927\u5316";
    maxBtn.setAttribute("aria-label", maxBtn.title);
  }
  function injectChrome() {
    if (document.getElementById(BAR_ID)) return;
    const style = document.createElement("style");
    style.textContent = CHROME_CSS;
    document.head.appendChild(style);
    document.documentElement.setAttribute("data-dsh-title-bar-height", String(BAR_HEIGHT));
    const layout = document.createElement("style");
    layout.textContent = `body{box-sizing:border-box!important;padding-top:${BAR_HEIGHT}px!important}`;
    document.head.appendChild(layout);
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("data-tauri-drag-region", "true");
    bar.innerHTML = `
    <div class="dch-left" data-tauri-drag-region="true">
      <img class="dch-icon" alt="" draggable="false" data-tauri-drag-region="true" />
      <span class="dch-title" data-tauri-drag-region="true">DSHEAC AIO</span>
      <span class="dch-badge" hidden data-tauri-drag-region="true"></span>
    </div>
    <div class="dch-right">
      <button class="dch-btn" data-act="menu" title="\u83DC\u5355" aria-label="\u83DC\u5355">${GLYPHS.menu}</button>
      <button class="dch-btn" data-act="min" title="\u6700\u5C0F\u5316" aria-label="\u6700\u5C0F\u5316">${GLYPHS.min}</button>
      <button class="dch-btn" data-act="max" title="\u6700\u5927\u5316" aria-label="\u6700\u5927\u5316">${GLYPHS.max}</button>
      <button class="dch-btn dch-close" data-act="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">${GLYPHS.close}</button>
    </div>
    <div class="dch-menu" hidden></div>`;
    document.body.appendChild(bar);
    const badge = bar.querySelector(".dch-badge");
    const icon = bar.querySelector(".dch-icon");
    maxBtn = bar.querySelector('[data-act="max"]');
    menuEl = bar.querySelector(".dch-menu");
    bar.querySelector('[data-act="min"]').addEventListener("click", () => dshDesktop.windowControls.minimize());
    bar.querySelector('[data-act="max"]').addEventListener("click", () => dshDesktop.windowControls.toggleMaximize());
    bar.querySelector(".dch-close").addEventListener("click", () => dshDesktop.windowControls.close());
    bar.querySelector('[data-act="menu"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpen) closeMenu();
      else openMenu();
    });
    document.addEventListener("click", (e) => {
      if (menuOpen && !bar.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
    dshDesktop.getInfo().then((info) => {
      if (!info) return;
      state = { ...state, ...info };
      if (info.appVersion) {
        badge.textContent = displayVersion(info.appVersion);
        badge.hidden = false;
      }
      if (info.agentVersion) badge.title = "agent v" + info.agentVersion + "\uFF08" + info.agentSource + "\uFF09";
      if (info.iconDataUri) icon.src = info.iconDataUri;
    }).catch(() => {
    });
    dshDesktop.windowControls.isMaximized().then(setMaximized).catch(() => {
    });
    dshDesktop.windowControls.onMaximizeChange(setMaximized);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectChrome);
  } else {
    injectChrome();
  }
  {
    const beat = () => {
      invoke("renderer_heartbeat").catch(() => {
      });
    };
    beat();
    setInterval(beat, 5e3);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") beat();
    });
  }
})();
