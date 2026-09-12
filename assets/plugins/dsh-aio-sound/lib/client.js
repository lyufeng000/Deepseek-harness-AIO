/**
 * dsh-aio-sound — browser half: the 「音效」 settings section.
 *
 * 一行一个开关/滑杆/下拉，配置读写走 host 半身的 /api/aio-sound 路由：
 *   - 主任务完成 / 中断 / 询问 / 错误四类独立开关、选曲与试听
 *   - 音量 0..100（只作用于提示音，不动系统音量）
 *   - 播放内容（内置音效 + 自定义目录扫描到的 wav）
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
          var nextConfig = Object.assign({}, prev.config, patch);
          if (patch.events) {
            nextConfig.events = Object.assign({}, prev.config.events);
            Object.keys(patch.events).forEach(function (kind) {
              nextConfig.events[kind] = Object.assign({}, prev.config.events[kind], patch.events[kind]);
            });
          }
          return Object.assign({}, prev, { config: nextConfig, notice: null, error: null });
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
      var index;
      for (index = 0; index < state.sounds.length; index += 1) {
        if (state.sounds[index].source === "custom") custom.push(state.sounds[index]);
        else builtin.push(state.sounds[index]);
      }
      function optionOf(item) {
        return h("option", { key: item.file, value: item.file }, item.label || item.file);
      }
      function eventControl(kind, title) {
        var item = config.events[kind];
        var groups = [];
        if (builtin.length > 0) groups.push(h("optgroup", { key: "g-builtin", label: "内置音效" }, builtin.map(optionOf)));
        if (custom.length > 0) groups.push(h("optgroup", { key: "g-custom", label: "自定义目录" }, custom.map(optionOf)));
        if (!state.sounds.some(function (row) { return row.file === item.sound; })) {
          groups.push(h("option", { key: "g-current", value: item.sound }, item.sound + "（当前音效）"));
        }
        return [
          switchButton(item.enabled, function () {
            var events = {}; events[kind] = { enabled: !item.enabled };
            save({ events: events }, title + "开关");
          }, title),
          h("select", {
            key: "sel-" + kind, className: "__snd_select", value: item.sound,
            disabled: state.sounds.length === 0,
            onChange: function (event) {
              var events = {}; events[kind] = { sound: event.target.value };
              save({ events: events }, title + "音效");
            },
          }, groups),
          h("button", { key: "try-" + kind, type: "button", className: "__snd_btn", onClick: function () { preview(item.sound); } }, "试听"),
        ];
      }
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
        h("p", { key: "hint", className: "__snd_hint" }, "提示音由桌面端播放。仅顶层任务触发，子代理、自动重试和历史事件不会重复出声。"),
        row("提示音总开关", "关闭后所有自动提示静音；试听仍可用。", switchButton(config.enabled, function () { save({ enabled: !config.enabled }, "总开关"); }, "提示音总开关")),
        row("音量", "0–100，只影响提示音，不动系统音量。", volumeControl),
        row("任务完成", "顶层任务成功完成时播放。", eventControl("complete", "任务完成")),
        row("手动中断", "你主动停止顶层任务时播放。", eventControl("interrupted", "手动中断")),
        row("等待询问", "需要回答问题或授权时播放，同一请求只响一次。", eventControl("question", "等待询问")),
        row("任务错误", "顶层任务最终失败时播放；自动重试和普通工具错误不播放。", eventControl("error", "任务错误")),
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

    function switchButton(on, onClick, label) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": on,
        "aria-label": label || "播放音效",
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
    exports.inject = ["slots"];
    return module.exports;
  },
});
