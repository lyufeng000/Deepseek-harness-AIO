/**
 * dsh-aio-sound — browser half: the 「音效」 settings section.
 *
 * 一行一个开关/滑杆/下拉，配置读写走 host 半身的 /api/aio-sound 路由：
 *   - 会话完成是否播放音效（host 端监听所有会话，不受当前选中影响）
 *   - 音量 0..100（只作用于提示音，不动系统音量）
 *   - 播放内容（内置音效 + 自定义目录扫描到的 wav，默认沿用现有提示音）
 *   - 自定义音效目录（留空 = DSH 数据目录下的 sounds）
 *
 * Hand-written ModuleLoader bundle — no build step (same shape as dsh-plugin-shield).
 */
window.__ModuleLoader__.load({
  id: "dsh-aio-sound",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var API = "/api/aio-sound";
    var CSS_ID = "dsh-aio-sound-css";

    var CSS = ".__snd_root{max-width:640px;display:flex;flex-direction:column;gap:2px}" +
      ".__snd_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}" +
      ".__snd_row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__snd_text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:24px}" +
      ".__snd_title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__snd_desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__snd_ctl{flex:none;display:flex;align-items:center;gap:8px}" +
      ".__snd_switch{position:relative;flex:none;width:40px;height:22px;padding:0;border:none;border-radius:11px;cursor:pointer;transition:background .15s}" +
      ".__snd_knob{position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s,background .15s}" +
      ".__snd_range{width:150px;accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__snd_vol{width:34px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary)}" +
      ".__snd_select{max-width:220px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit;font-size:12px}" +
      ".__snd_input{width:230px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit;font-size:12px}" +
      ".__snd_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}" +
      ".__snd_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__snd_btn:disabled{opacity:.5;cursor:default}" +
      ".__snd_status{min-height:18px;margin-top:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__snd_err{color:var(--dsw-alias-state-error-primary)}";

    function ensureCss() {
      try {
        if (document.getElementById(CSS_ID)) return;
        var style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch { /* 样式注入失败不影响功能 */ }
    }

    /** fetch 包装：非 2xx 或 ok!==true 一律抛带可读文案的错误。 */
    function request(path, options) {
      return fetch(API + path, options).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            throw new Error((body && body.error) || ("HTTP " + res.status));
          }
          return body;
        });
      });
    }

    function post(path, payload) {
      return request(path, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    function payloadToState(payload) {
      return {
        phase: "ready",
        config: payload.config,
        sounds: Array.isArray(payload.sounds) ? payload.sounds : [],
        customDirIsDefault: payload.customDirIsDefault !== false,
        error: null,
      };
    }

    /** 「音效」设置页。 */
    function SoundSection() {
      var loaded = useState({
        phase: "loading",
        config: null,
        sounds: [],
        customDirIsDefault: true,
        error: null,
        notice: null,
      });
      var state = loaded[0];
      var setState = loaded[1];
      var dir = useState("");
      var dirDraft = dir[0];
      var setDirDraft = dir[1];
      var volumeTimer = useRef(0);

      useEffect(function () {
        var alive = true;
        request("/state", { cache: "no-store" }).then(function (payload) {
          if (!alive) return;
          setState(function (prev) { return Object.assign({}, prev, payloadToState(payload)); });
          var dirValue = payload.config && typeof payload.config.customDir === "string" ? payload.config.customDir : "";
          setDirDraft(dirValue);
        }).catch(function (error) {
          if (!alive) return;
          setState(function (prev) { return Object.assign({}, prev, { phase: "error", error: String((error && error.message) || error) }); });
        });
        return function () { alive = false; };
      }, []);

      useEffect(function () {
        return function () {
          if (volumeTimer.current) window.clearTimeout(volumeTimer.current);
        };
      }, []);

      function save(patch, label) {
        setState(function (prev) {
          return Object.assign({}, prev, { config: Object.assign({}, prev.config, patch), notice: null, error: null });
        });
        post("/config", patch).then(function (payload) {
          setState(function (prev) { return Object.assign({}, prev, payloadToState(payload), { notice: (label || "设置") + "已保存" }); });
        }).catch(function (error) {
          setState(function (prev) { return Object.assign({}, prev, { error: String((error && error.message) || error) }); });
          // 写入失败：回读真实状态，避免界面停在乐观值
          request("/state", { cache: "no-store" }).then(function (payload) {
            setState(function (prev) { return Object.assign({}, prev, payloadToState(payload), { notice: null }); });
          }).catch(function () { /* 保留错误提示 */ });
        });
      }

      function onVolume(value) {
        setState(function (prev) {
          return Object.assign({}, prev, { config: Object.assign({}, prev.config, { volume: value }), notice: null, error: null });
        });
        if (volumeTimer.current) window.clearTimeout(volumeTimer.current);
        volumeTimer.current = window.setTimeout(function () { save({ volume: value }, "音量"); }, 350);
      }

      function preview(sound) {
        setState(function (prev) { return Object.assign({}, prev, { notice: "试听中…", error: null }); });
        post("/preview", sound ? { sound: sound } : {}).then(function () {
          setState(function (prev) { return Object.assign({}, prev, { notice: "已试听当前音效" }); });
        }).catch(function (error) {
          setState(function (prev) { return Object.assign({}, prev, { notice: null, error: String((error && error.message) || error) }); });
        });
      }

      function applyDir() {
        save({ customDir: dirDraft }, "自定义目录");
      }

      if (state.phase === "loading") {
        return h("div", { className: "__snd_root" }, h("p", { className: "__snd_hint" }, "正在读取音效设置…"));
      }
      if (!state.config) {
        return h("div", { className: "__snd_root" }, h("p", { className: "__snd_hint __snd_err" }, state.error || "读取音效设置失败"));
      }

      var config = state.config;
      var builtin = [];
      var custom = [];
      var currentSelected = false;
      var index;
      for (index = 0; index < state.sounds.length; index += 1) {
        if (state.sounds[index].source === "custom") custom.push(state.sounds[index]);
        else builtin.push(state.sounds[index]);
        if (state.sounds[index].file === config.sound) currentSelected = true;
      }
      function optionOf(item) {
        return h("option", { key: item.file, value: item.file }, item.label || item.file);
      }
      var groups = [];
      if (builtin.length > 0) groups.push(h("optgroup", { key: "g-builtin", label: "内置音效" }, builtin.map(optionOf)));
      if (custom.length > 0) groups.push(h("optgroup", { key: "g-custom", label: "自定义目录" }, custom.map(optionOf)));
      if (!currentSelected && config.sound) groups.push(h("option", { key: "g-current", value: config.sound }, config.sound + "（当前音效）"));

      var soundControl = [
        h("select", {
          key: "sel",
          className: "__snd_select",
          value: config.sound,
          disabled: state.sounds.length === 0,
          onChange: function (event) { save({ sound: event.target.value }, "音效内容"); },
        }, groups),
        h("button", { key: "try", type: "button", className: "__snd_btn", onClick: function () { preview(config.sound); } }, "试听"),
      ];
      var volumeControl = [
        h("input", {
          key: "vol",
          className: "__snd_range",
          type: "range",
          min: 0,
          max: 100,
          step: 1,
          value: config.volume,
          onChange: function (event) { onVolume(Number(event.target.value)); },
        }),
        h("span", { key: "num", className: "__snd_vol" }, String(config.volume)),
      ];
      var dirControl = [
        h("input", {
          key: "dir",
          className: "__snd_input",
          type: "text",
          value: dirDraft,
          placeholder: "留空 = DSH 数据目录下的 sounds",
          onChange: function (event) { setDirDraft(event.target.value); },
          onKeyDown: function (event) { if (event.key === "Enter") applyDir(); },
        }),
        h("button", { key: "apply", type: "button", className: "__snd_btn", onClick: applyDir }, "扫描"),
      ];
      var statusText = state.error ? state.error : (state.notice || "");
      return h("div", { className: "__snd_root" }, [
        h("p", { key: "hint", className: "__snd_hint" }, "提示音由桌面端播放：不受浏览器自动播放限制；任何会话（含后台会话、子代理回合、用户中断与审批/提问等待）一完成就出声。音量只作用于提示音，不改系统音量。"),
        row("会话完成时播放音效", "关闭后所有会话完成都不再出声；试听仍可用。", switchButton(config.enabled, function () { save({ enabled: !config.enabled }, "开关"); })),
        row("音量", "0–100，只影响提示音，不动系统音量。", volumeControl),
        row("音效内容", "默认沿用现有提示音；下拉列出内置音效与自定义目录里的 wav。", soundControl),
        row("自定义音效目录", state.customDirIsDefault ? "当前使用默认目录（DSH 数据目录下的 sounds）。填目录后扫描其中的 *.wav。" : "扫描该目录下的 *.wav。", dirControl),
        h("div", { key: "status", className: state.error ? "__snd_status __snd_err" : "__snd_status" }, statusText),
      ]);
    }

    /** 设置行：标题 + 说明在左，控件在右。 */
    function row(title, desc, control) {
      return h("div", { key: title, className: "__snd_row" },
        h("div", { className: "__snd_text" },
          h("div", { className: "__snd_title" }, title),
          h("div", { className: "__snd_desc" }, desc)),
        h("div", { className: "__snd_ctl" }, control));
    }

    function switchButton(on, onClick) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": on,
        "aria-label": "会话完成时播放音效",
        className: "__snd_switch",
        style: { background: on ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-bg-module-platform)" },
        onClick: onClick,
      }, h("span", {
        className: "__snd_knob",
        style: { left: on ? 20 : 2, background: on ? "#ffffff" : "var(--dsw-alias-label-tertiary)" },
      }));
    }

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "aio-sound",
          order: 26,
          label: "音效",
        }, SoundSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["@deepseek-ai/dsh-client-ui-settings"];
    return module.exports;
  },
});
