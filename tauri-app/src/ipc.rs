//! IPC 命令层：Electron 版 20 个 handle + 2 个 on 的逐一映射。
//! 命令名保持 chrome_* / dsh_* 语义；注入脚本里的 window.dshDesktop 桥
//! （frontend/chrome.ts）按相同形状调用。所有命令校验来源窗口必须是主窗；
//! 敏感命令（插件生态/余额写/菜单写操作/服务重启）再加 origin 二重校验（v2 采纳项 A）。

use crate::dialog::{build_error_detail, DialogIcon, DialogSpec};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub type St<'a> = State<'a, Arc<AppState>>;

fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("unauthorized".into())
    }
}

/// 敏感命令第二重校验：调用页必须来自本地壳页面，或运行期确认的 Web UI origin。
fn ensure_origin(state: &AppState, window: &WebviewWindow) -> Result<(), String> {
    ensure_main(window)?;
    let cur = window.url().map_err(|_| "unauthorized".to_string())?;
    let cur_origin = cur.origin().ascii_serialization();
    // 本地页（loading/recovery）。Windows WebView2 下默认 http://tauri.localhost。
    if matches!(
        cur_origin.as_str(),
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    ) {
        return Ok(());
    }
    let web = state.web_url.lock().unwrap().clone();
    let web_origin = web
        .as_deref()
        .and_then(|u| tauri::Url::parse(u).ok())
        .map(|u| u.origin().ascii_serialization());
    if web_origin.as_deref() == Some(cur_origin.as_str()) {
        return Ok(());
    }
    state.log.log(
        "ipc",
        &format!("已拒绝非预期来源的命令调用: {}", cur_origin),
    );
    Err("unauthorized".into())
}

fn normalized_external_url(value: &str) -> Option<String> {
    let parsed = tauri::Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.host_str() == Some("tauri.localhost") {
        return None;
    }
    Some(parsed.to_string())
}

pub fn open_url_external(url: &str) {
    let Some(url) = normalized_external_url(url) else { return };
    // Avoid PowerShell/cmd string interpolation. explorer.exe delegates a URL
    // argument to the registered system browser without introducing a shell.
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.spawn();
}

pub fn open_path_explorer(path: &str) {
    let _ = std::process::Command::new("explorer").arg(path).spawn();
}

// ---------------------------------------------------------------------------
// 心跳 / 页面错误 / chrome:init / 窗口控制 / 菜单
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn renderer_heartbeat(state: St<'_>, window: WebviewWindow) {
    if ensure_origin(&state, &window).is_err() {
        return;
    }
    state.recovery.note_heartbeat();
}

#[tauri::command]
pub fn page_error(state: St<'_>, window: WebviewWindow, payload: String) {
    if ensure_origin(&state, &window).is_err() {
        return;
    }
    state.log.log("page-error", &payload);
}

#[tauri::command]
pub fn chrome_init(state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return Value::Null;
    }
    let icon_path = state.paths.assets_dir().join("icon.png");
    let mut icon_data_uri = String::new();
    if let Ok(bytes) = std::fs::read(&icon_path) {
        if bytes.len() > 2 && bytes[0] == 0x89 && bytes[1] == 0x50 {
            icon_data_uri = format!("data:image/png;base64,{}", base64_lite_encode(&bytes));
        }
    }
    let doc = crate::settings::load_at(&state.paths.settings_file());
    let (agent_version, agent_source) = agent_version_info(state.inner());
    json!({
        "appVersion": crate::DISPLAY_RELEASE,
        "agentVersion": agent_version,
        "agentSource": agent_source,
        "closeToTray": doc.get("closeToTray").and_then(|v| v.as_bool()).unwrap_or(true),
        "exitAction": crate::settings::exit_action_of(&doc),
        "shortcutPolicy": crate::settings::shortcut_policy_of(&doc),
        "iconDataUri": icon_data_uri,
        "repoUrls": repo_urls(),
        "staticPort": 0,
        "desktopShell": "tauri",
    })
}

pub fn agent_version_info(state: &AppState) -> (String, String) {
    let overlay = state
        .paths
        .user_data
        .join("agent")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let read_ver = |p: &std::path::Path| -> Option<String> {
        serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?)
            .ok()?
            .get("version")?
            .as_str()
            .map(|s| s.to_string())
    };
    if let Some(v) = read_ver(&overlay) {
        return (v, "用户目录（已更新）".into());
    }
    let bundled = state
        .paths
        .app_root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    (
        read_ver(&bundled).unwrap_or_else(|| "未知".into()),
        "内置".into(),
    )
}

fn repo_urls() -> Value {
    json!({
        "github": "https://github.com/zouyuxuan122/Deepseek-Harness-EAC",
        "gitee": "https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC",
    })
}

#[tauri::command]
pub fn chrome_window(
    app: AppHandle,
    state: St<'_>,
    window: WebviewWindow,
    action: String,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return Value::Null;
    }
    let Some(win) = app.get_webview_window("main") else {
        return Value::Null;
    };
    match action.as_str() {
        "minimize" => {
            let _ = win.minimize();
        }
        "toggle-maximize" => {
            if win.is_maximized().unwrap_or(false) {
                let _ = win.unmaximize();
            } else {
                let _ = win.maximize();
            }
        }
        "close" => {
            let _ = win.close();
        }
        "is-maximized" => return json!(win.is_maximized().unwrap_or(false)),
        _ => {}
    }
    Value::Null
}

#[tauri::command]
pub fn chrome_menu(
    app: AppHandle,
    state: St<'_>,
    window: WebviewWindow,
    action: String,
    value: Option<String>,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return menu_state(&state);
    }
    let settings_file = state.paths.settings_file();
    match action.as_str() {
        "reload" => crate::boot::reload_main_window(&app),
        "devtools" => {
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
        }
        "fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                let fs = win.is_fullscreen().unwrap_or(false);
                let _ = win.set_fullscreen(!fs);
            }
        }
        "open-browser" => {
            if let Some(url) = state.web_url.lock().unwrap().clone() {
                open_url_external(&url);
            }
        }
        "open-logs" => open_path_explorer(&state.paths.logs_dir.to_string_lossy()),
        "toggle-close-to-tray" => {
            let cur = crate::settings::get_bool(&settings_file, "closeToTray", true);
            let _ = crate::settings::set_key(&settings_file, "closeToTray", json!(!cur));
        }
        "set-exit-action" => {
            if let Some(v) = value.as_deref() {
                if matches!(v, "ask" | "minimize" | "quit") {
                    let _ = crate::settings::set_key(&settings_file, "exitAction", json!(v));
                    // 同步旧字段，避免降级回旧版本时行为回退。
                    let _ =
                        crate::settings::set_key(&settings_file, "closeToTray", json!(v != "quit"));
                }
            }
        }
        "restart-service" => {
            let st = state.inner().clone();
            std::thread::spawn(move || {
                let r = crate::boot::restart_service_core(&st);
                if !r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
                    && r.get("error").and_then(|v| v.as_str()) != Some("not-running")
                {
                    crate::boot::show_dialog_simple(
                        &st,
                        DialogSpec {
                            title: "重启 Web 服务失败".into(),
                            message: "dsh web 服务重启未成功。".into(),
                            detail: r
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            buttons: vec!["确定".into()],
                            default_index: 0,
                            checkbox: None,
                            icon: DialogIcon::Error,
                            cancellable: true,
                        },
                    );
                }
            });
        }
        "toggle-shortcut-policy" => {
            let doc = crate::settings::load_at(&settings_file);
            let next = if crate::settings::shortcut_policy_of(&doc) == "never" {
                "auto"
            } else {
                "never"
            };
            let _ = crate::settings::set_key(&settings_file, "shortcutPolicy", json!(next));
            state
                .log
                .log("boot", &format!("桌面快捷方式自动维护: {}", next));
        }
        "about" => show_about(app.clone(), state.inner().clone()),
        "quit" => {
            // 走统一优雅退出流：写干净退出标记（否则安装版看门狗会把本次
            // 退出误判为崩溃并自动重启）→ 有界回收进程树 → exit(0)。
            crate::shutdown_flow(&app);
        }
        _ => {}
    }
    menu_state(&state)
}

fn menu_state(state: &AppState) -> Value {
    let doc = crate::settings::load_at(&state.paths.settings_file());
    json!({
        "closeToTray": doc.get("closeToTray").and_then(|v| v.as_bool()).unwrap_or(true),
        "exitAction": crate::settings::exit_action_of(&doc),
        "shortcutPolicy": crate::settings::shortcut_policy_of(&doc),
    })
}

fn show_about(app: AppHandle, state: Arc<AppState>) {
    let urls = repo_urls();
    let github = urls["github"].as_str().unwrap_or("").to_string();
    let gitee = urls["gitee"].as_str().unwrap_or("").to_string();
    let (agent_version, agent_source) = agent_version_info(&state);
    let detail = format!(
        "DSHEAC AIO（All-in-One）{}\n兼容 DeepSeek Harness\n\nagent 版本：{}（{}）\n数据目录：{}\nDSH_HOME：{}\n\n上游参考：\n  GitHub: {}\n  Gitee:  {}\n\n本发行版为非官方社区重构版。",
        crate::DISPLAY_RELEASE,
        agent_version,
        agent_source,
        state.paths.user_data.display(),
        state.paths.dsh_home.display(),
        github,
        gitee
    );
    let spec = DialogSpec {
        title: format!("关于 DSHEAC AIO {}", crate::DISPLAY_RELEASE),
        message: format!("DSHEAC AIO（All-in-One）{}", crate::DISPLAY_RELEASE),
        detail,
        buttons: vec![
            "复制 GitHub 地址".into(),
            "复制 Gitee 地址".into(),
            "确定".into(),
        ],
        default_index: 0,
        checkbox: None,
        icon: DialogIcon::Info,
        cancellable: true,
    };
    // 原生弹窗必须主线程（bug #11：后台线程弹模态框触发注入物 AV）。
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = crate::dialog::show(0, &spec);
        let clip = match r.index {
            0 => Some(github),
            1 => Some(gitee),
            _ => None,
        };
        if let Some(text) = clip {
            let _ = app2.clipboard().write_text(text);
        }
    })
    .ok();
}

// ---------------------------------------------------------------------------
// 服务重启 / 插件生态 / 余额 / 外链
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn chrome_restart_service(
    state: St<'_>,
    window: WebviewWindow,
    intent: Option<String>,
) -> Value {
    if intent.as_deref() != Some("restart-service") {
        return json!({"ok": false, "error": "missing-intent"});
    }
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let st = state.inner().clone();
    // 市场插件等待该调用返回后刷新 UI；重启耗时较长但必须同步返回结果。
    crate::boot::restart_service_core(&st)
}

#[tauri::command]
pub fn guard_action(
    state: St<'_>,
    window: WebviewWindow,
    action: String,
    value: Option<Value>,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    let params = json!({
        "action": action,
        "value": value.unwrap_or(Value::Null),
        "serviceRunning": state.service_running(),
        "restartingServer": state.restarting.load(Ordering::SeqCst),
    });
    match sc.call("guard.action", params) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn plugin_list(state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!([]);
    }
    match state
        .sidecar()
        .ok()
        .map(|s| s.call("plugin.list", json!({})))
    {
        Some(Ok(v)) => v,
        _ => json!([]),
    }
}

#[tauri::command]
pub fn plugin_set_enabled(
    state: St<'_>,
    window: WebviewWindow,
    id: String,
    enabled: bool,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    match sc.call("plugin.setEnabled", json!({"id": id, "enabled": enabled})) {
        Ok(v) => {
            state.log.log(
                "plugin-manager",
                &format!("已{}插件 {}", if enabled { "启用" } else { "关闭" }, id),
            );
            v
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn plugin_set_removed(
    state: St<'_>,
    window: WebviewWindow,
    id: String,
    removed: bool,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    match sc.call("plugin.setRemoved", json!({"id": id, "removed": removed})) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn plugin_updates(state: St<'_>, window: WebviewWindow, force: Option<bool>) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return Value::Null;
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"list": [], "autoUpdate": false, "error": e}),
    };
    match sc.call_timeout(
        "updates.list",
        json!({"force": force.unwrap_or(false)}),
        std::time::Duration::from_secs(180),
    ) {
        Ok(v) => v,
        Err(e) => json!({"list": [], "autoUpdate": false, "error": e}),
    }
}

#[tauri::command]
pub fn plugin_update(state: St<'_>, window: WebviewWindow, id: String) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    match sc.call_timeout(
        "updates.updateOne",
        json!({"id": id}),
        std::time::Duration::from_secs(1800),
    ) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn plugin_auto_update(state: St<'_>, window: WebviewWindow, enabled: bool) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    match sc.call("updates.setAutoUpdate", json!({"enabled": enabled})) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn balance_refresh(state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        if let Ok(c) = state.balance_cache.lock() {
            return c.clone().unwrap_or(Value::Null);
        }
        return Value::Null;
    }
    crate::boot::refresh_balance_blocking(state.inner())
}

#[tauri::command]
pub fn balance_prices_get(state: St<'_>, window: WebviewWindow, model: Option<String>) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    match sc.call("balance.pricesGet", json!({"model": model})) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn balance_prices_set(
    state: St<'_>,
    window: WebviewWindow,
    model: Option<String>,
    prices: Option<Value>,
) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    let r = sc.call(
        "balance.pricesSet",
        json!({"model": model, "prices": prices}),
    );
    // 保存后立即重推余额数据（dock 费用估算即时生效）。
    let st = state.inner().clone();
    std::thread::spawn(move || {
        crate::boot::refresh_balance_blocking(&st);
    });
    match r {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn balance_prices_reset(state: St<'_>, window: WebviewWindow, model: Option<String>) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    let sc = match state.sidecar() {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    let r = sc.call("balance.pricesReset", json!({"model": model}));
    let st = state.inner().clone();
    std::thread::spawn(move || {
        crate::boot::refresh_balance_blocking(&st);
    });
    match r {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
pub fn open_external(state: St<'_>, window: WebviewWindow, url: String) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "forbidden"});
    }
    let Some(url) = normalized_external_url(&url) else {
        return json!({"ok": false, "error": "invalid url"});
    };
    open_url_external(&url);
    json!({"ok": true})
}

// ---------------------------------------------------------------------------
// 恢复页（assets/recovery.html）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn recovery_state(state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return Value::Null;
    }
    json!({
        "appVersion": crate::DISPLAY_RELEASE,
        "logsDir": state.paths.logs_dir.display().to_string(),
        "crashDumpsDir": local_app_data_crash_dumps(),
        "state": state.recovery.state_of(),
    })
}

fn local_app_data_crash_dumps() -> String {
    std::env::var("LOCALAPPDATA")
        .map(|l| {
            std::path::PathBuf::from(l)
                .join("CrashDumps")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn recovery_reload(app: AppHandle, state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if !state.service_running() {
        let st = state.inner().clone();
        match crate::boot::guarded_start(&st) {
            Ok(_) => {}
            Err(e) => return json!({"ok": false, "error": e}),
        }
    }
    state.recovery.retry_now();
    crate::boot::navigate_main_to_web(&app, &state);
    json!({"ok": true})
}

#[tauri::command]
pub fn recovery_restart(app: AppHandle, state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    state.log.log("recovery", "用户在恢复页面选择重启客户端");
    state.quitting.store(true, Ordering::SeqCst);
    state.force_quit.store(true, Ordering::SeqCst);
    let _ = crate::watchdog::mark_clean_exit(&state.paths.run_state_file());
    if let Ok(g) = state.service.lock() {
        if let Some(h) = g.as_ref() {
            h.intentional.store(true, Ordering::SeqCst);
            crate::service::kill_handle(h);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let cwd = exe.parent().map(|p| p.to_path_buf());
        let _ = crate::procwin::spawn_detached(&exe.to_string_lossy(), &[], cwd.as_deref());
    }
    app.exit(0);
    json!({"ok": true})
}

#[tauri::command]
pub fn recovery_open_logs(state: St<'_>, window: WebviewWindow) -> Value {
    if ensure_origin(&state, &window).is_err() {
        return json!({"ok": false, "error": "unauthorized"});
    }
    open_path_explorer(&state.paths.logs_dir.to_string_lossy());
    json!({"ok": true})
}

/// buildErrorDetail 共享出口（供 boot.rs 错误弹窗与「复制日志」使用）。
pub fn error_detail(state: &AppState, err: &str, files: &[&str]) -> String {
    build_error_detail(err, &state.paths.logs_dir, files)
}

/// base64 编码（仅用于图标 data URI，无外部依赖）。
pub fn base64_lite_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
