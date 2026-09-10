use crate::state::AppState;
use serde_json::{json, Value};
use std::{path::Path, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

static STARTED: AtomicBool = AtomicBool::new(false);
static INSTALLING: AtomicBool = AtomicBool::new(false);

fn init(state: &AppState, app: &AppHandle) -> Result<(), String> {
    if !state.paths.packaged { return Err("开发模式不执行客户端自动更新。".into()); }
    let downloads = app.path().download_dir().map_err(|_| "系统下载目录不可用。")?;
    state.sidecar()?.call("clientUpdate.init", json!({"downloads": downloads})).map(|_| ())
}

#[tauri::command]
pub async fn client_update(app: AppHandle, state: State<'_, Arc<AppState>>, window: WebviewWindow, action: String, enabled: Option<bool>) -> Result<Value, String> {
    crate::ipc::ensure_origin(&state, &window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        init(&state, &app)?;
        let sc = state.sidecar()?;
        match action.as_str() {
            "check" => sc.call_timeout("clientUpdate.check", json!({"manual": true}), Duration::from_secs(40)),
            "status" => sc.call("clientUpdate.status", json!({})),
            "download" => sc.call("clientUpdate.download", json!({})),
            "cancel" => sc.call("clientUpdate.cancel", json!({})),
            "notifications" => sc.call("clientUpdate.notifications", json!({"enabled": enabled.ok_or("通知参数缺失。")?})),
            "install" => {
                if INSTALLING.swap(true, Ordering::SeqCst) { return Err("更新安装已启动。".into()); }
                let result = handoff(&state, &app);
                if result.is_err() { INSTALLING.store(false, Ordering::SeqCst); }
                result
            }
            _ => Err("未知更新动作。".into()),
        }
    }).await.map_err(|_| "更新任务异常。".to_string())?
}

fn hidden(cmd: &mut Command) {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
}
fn handoff(state: &Arc<AppState>, app: &AppHandle) -> Result<Value, String> {
    // If preparation or takeover fails, the updater must leave the stranded
    // "installing" phase so the user can retry the verified download.
    match handoff_inner(state, app) {
        Ok(value) => Ok(value),
        Err(error) => {
            if let Ok(sidecar) = state.sidecar() {
                let _ = sidecar.call("clientUpdate.reset", json!({ "error": error }));
            }
            Err(error)
        }
    }
}
fn handoff_inner(state: &Arc<AppState>, app: &AppHandle) -> Result<Value, String> {
    let reply = state.sidecar()?.call_timeout("clientUpdate.prepare", json!({"parentPid": std::process::id()}), Duration::from_secs(120))?;
    let id = reply["id"].as_str().ok_or("更新事务缺少标识。")?;
    let directory = state.paths.user_data.join("client-update/transaction");
    let mut cmd = Command::new(directory.join("helper.exe"));
    cmd.arg("--aio-update-helper"); hidden(&mut cmd);
    let mut helper = cmd.spawn().map_err(|_| "无法启动更新助手。")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let accepted = read_json(&directory.join("accepted.json"));
        if accepted["id"].as_str() == Some(id) {
            crate::shutdown_flow(app); return Ok(json!({"phase": "installing"}));
        }
        if helper.try_wait().map_err(|_| "无法检查更新助手。")?.is_some() { return Err("更新助手未接管，当前应用保持运行。".into()); }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("更新助手接管超时，当前应用保持运行。".into())
}
fn read_json(file: &Path) -> Value {
    std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null)
}

pub fn start(state: Arc<AppState>) {
    if STARTED.swap(true, Ordering::SeqCst) || !state.paths.packaged || std::env::var_os("AIO_UPDATE_HEALTH_DIR").is_some() { return; }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        if state.quitting.load(Ordering::SeqCst) { return; }
        let Some(app) = state.app_handle() else { return; };
        if init(&state, &app).is_err() { return; }
        if let Ok(sc) = state.sidecar() {
            if let Ok(result) = sc.call_timeout("clientUpdate.check", json!({"manual": false}), Duration::from_secs(40)) {
                if result["phase"] == "available" { let _ = app.emit_to("main", "aio:update", result); }
            }
        }
    });
}

// Runs before Tauri/webview initialization, from the copy outside the install tree.
pub fn helper_entry() -> bool {
    if !std::env::args().any(|a| a == "--aio-update-helper") { return false; }
    let Some(directory) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) else { return true; };
    if directory.file_name().and_then(|n| n.to_str()) != Some("transaction") { return true; }
    let mut cmd = Command::new(directory.join("node.exe"));
    cmd.arg(directory.join("update-helper.js")).current_dir(&directory).env_remove("NODE_OPTIONS").env_remove("ELECTRON_RUN_AS_NODE");
    hidden(&mut cmd); let _ = cmd.status(); true
}

pub fn confirm_health(state: &AppState) {
    let Ok(directory) = std::env::var("AIO_UPDATE_HEALTH_DIR") else { return; };
    let Ok(token) = std::env::var("AIO_UPDATE_TOKEN") else { return; };
    let directory = std::path::PathBuf::from(directory);
    if directory != state.paths.user_data.join("client-update/transaction") { return; }
    let tx = read_json(&directory.join("transaction.json"));
    if tx["id"] != token || tx["version"] != state.paths.version || tx["phase"] != "verifying" { return; }
    let payload = json!({"id": token, "version": state.paths.version, "pid": std::process::id(), "ok": true});
    if std::fs::write(directory.join("healthy.tmp"), payload.to_string()).is_ok() {
        let _ = std::fs::rename(directory.join("healthy.tmp"), directory.join("healthy.json"));
    }
    // No navigation to the interactive Web UI until the helper commits.
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if read_json(&directory.join("committed.json"))["id"] == token {
            if let Some(app) = state.app_handle() {
                crate::boot::navigate_main_to_web(&app, state);
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(app) = state.app_handle() { crate::shutdown_flow(&app); }
}

pub fn resume_before_boot(paths: &crate::paths::Paths) {
    if !paths.packaged || std::env::var_os("AIO_UPDATE_HEALTH_DIR").is_some() { return; }
    let directory = paths.user_data.join("client-update/transaction");
    let tx = read_json(&directory.join("transaction.json"));
    let Some(phase) = tx["phase"].as_str() else { return; };
    if ["complete", "rolled-back", "aborted"].contains(&phase) { return; }
    let mut cmd = Command::new(directory.join("helper.exe"));
    cmd.arg("--aio-update-helper"); hidden(&mut cmd);
    if cmd.spawn().is_ok() { std::process::exit(0); }
}
