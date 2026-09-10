//! 应用装配：单实例锁、托盘、主窗、退出清理（before-quit 有界回收）、
//! 恢复状态机周期体检、窗口关闭三档行为。

pub mod boot;
pub mod dialog;
pub mod integrity;
pub mod ipc;
pub mod logging;
pub mod netprobe;
pub mod paths;
pub mod port;
pub mod procwin;
pub mod recovery;
pub mod service;
pub mod settings;
pub mod shortcuts;
pub mod sidecar;
pub mod state;
pub mod ve_migrate;
pub mod watchdog;

use state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

pub const DISPLAY_RELEASE: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub mod client_update;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二实例：恢复/聚焦主窗。
            if let Some(win) = app.get_webview_window("main") {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            client_update::client_update,
            ipc::renderer_heartbeat,
            ipc::page_error,
            ipc::chrome_init,
            ipc::chrome_window,
            ipc::chrome_menu,
            ipc::chrome_restart_service,
            ipc::guard_action,
            ipc::plugin_list,
            ipc::plugin_set_enabled,
            ipc::plugin_set_removed,
            ipc::plugin_updates,
            ipc::plugin_update,
            ipc::plugin_auto_update,
            ipc::balance_refresh,
            ipc::balance_prices_get,
            ipc::balance_prices_set,
            ipc::balance_prices_reset,
            ipc::open_external,
            ipc::recovery_state,
            ipc::recovery_reload,
            ipc::recovery_restart,
            ipc::recovery_open_logs,
        ])
        .setup(|app| {
            let version = app.package_info().version.to_string();
            let resource_dir = app.path().resource_dir().ok();
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
            let paths = paths::Paths::new(
                cfg!(debug_assertions) == false,
                resource_dir,
                app_data,
                version,
            );
            let log = std::sync::Arc::new(logging::Logger::open(&paths.logs_dir));
            client_update::resume_before_boot(&paths);
            // 插件与技能快照的植入（首次约 3 万文件）移到 boot_chain 后台线程执行，
            // 让主窗先显示 loading 页；否则首次启动会有很长一段时间没有任何窗口。
            let state = Arc::new(AppState::new(paths, log));
            let _ = state.app.set(app.handle().clone());
            app.manage(state.clone());

            // 托盘（Windows only 语义）：重启 Web 服务 / 退出；左键点击切换显隐。
            create_tray(app.handle().clone(), &state);

            // 主窗：loading 页起，boot 链就绪后导航到 dsh web。
            match boot::create_main_window(app.handle()) {
                Ok(win) => {
                    let st = state.clone();
                    let w = win.clone();
                    win.on_window_event(move |_event| on_window_event(&st, &w, _event));
                }
                Err(e) => {
                    state.log.log("boot", &format!("创建主窗失败: {}", e));
                }
            }

            // 恢复状态机周期体检：心跳丢失 / 服务探活失败 → 退避恢复。
            {
                let st = state.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(
                        recovery::CHECK_INTERVAL_MS,
                    ));
                    recovery_tick(&st);
                });
            }

            boot::run_boot(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // V4 语义：退出必须等 dsh web 进程树真正死透再退；首次请求阻止，
            // 走统一清理流（内部完成后再 exit(0)，code=Some 时放行）。
            if code.is_none() {
                api.prevent_exit();
                shutdown_flow(app_handle);
            }
        }
        RunEvent::Exit => {
            // 最终退出前的最后保障：Job 句柄 Drop 会终止关联进程树。
            let state: Arc<AppState> = app_handle.state::<Arc<AppState>>().inner().clone();
            match state.service.lock() {
                Ok(mut g) => {
                    if let Some(h) = g.take() {
                        service::kill_handle(&h);
                    }
                }
                Err(_) => {}
            };
        }
        _ => {}
    });
}

/// 统一优雅退出流程：写干净退出标记（防看门狗误判重启）→ 有界回收
/// 服务树与 sidecar → 真正 exit(0)。菜单退出/系统退出共用；
/// shutdown_started 保证只进一次。
pub fn shutdown_flow(app_handle: &AppHandle) {
    let state: Arc<AppState> = app_handle.state::<Arc<AppState>>().inner().clone();
    if state.shutdown_started.swap(true, Ordering::SeqCst) {
        return;
    }
    state.quitting.store(true, Ordering::SeqCst);
    state.force_quit.store(true, Ordering::SeqCst);
    let t0 = std::time::Instant::now();
    state.log.log("boot", "正在退出，停止 dsh web 进程树…");
    let _ = watchdog::mark_clean_exit(&state.paths.run_state_file());
    let app2 = app_handle.clone();
    std::thread::spawn(move || {
        // 服务进程树：有界强回收（优雅 → 强杀 → Job 兜底）。
        if let Ok(mut g) = state.service.lock() {
            if let Some(h) = g.take() {
                service::kill_handle(&h);
            }
        }
        // sidecar：关 stdin 自然退出 + taskkill 兜底。
        if let Some(sc) = state.sidecar.get() {
            sc.kill();
        }
        state.log.log(
            "boot",
            &format!("退出清理完成（耗时 {}ms）", t0.elapsed().as_millis()),
        );
        app2.exit(0);
    });
}

fn on_window_event(state: &Arc<AppState>, win: &tauri::WebviewWindow, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if state.force_quit.load(Ordering::SeqCst) || !state.tray_ready.load(Ordering::SeqCst) {
                return; // 放行关闭
            }
            api.prevent_close();
            let st = state.clone();
            let win_label = win.label().to_string();
            let app = state.app_handle();
            std::thread::spawn(move || {
                close_flow(&st, app, &win_label);
            });
        }
        WindowEvent::Destroyed => {
            state.recovery.note_local_page();
        }
        _ => {
            // 最大化/还原事件推送（自绘按钮状态）。
            if let Some(app) = state.app_handle() {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(is_max) = win.is_maximized() {
                        let _ = app.emit_to("main", "chrome:maximized", is_max);
                    }
                }
            }
        }
    }
}

/// 关闭窗口三档：ask（每次询问）/ minimize（后台运行）/ quit（直接退出）。
/// 注意：所有原生弹窗必须跑在主线程——微信输入法（WeType）等 TSF 注入物
/// （含 CrashRpt1500.dll）的窗口 hook 在后台线程创建模态框（无论
/// TaskDialogIndirect 还是 MessageBoxW）都会触发 ntdll 堆 AV 并冻结该线程
/// （bug #11）；主线程有完整消息泵与线程局部状态，实测安全。
fn close_flow(state: &Arc<AppState>, app: Option<AppHandle>, _win_label: &str) {
    state.log.log("boot", "close-flow: 进入");
    let doc = settings::load_at(&state.paths.settings_file());
    let action = settings::exit_action_of(&doc);
    state
        .log
        .log("boot", &format!("close-flow: exitAction={}", action));
    match action.as_str() {
        "quit" => {
            if let Some(app) = app {
                state.force_quit.store(true, Ordering::SeqCst);
                crate::shutdown_flow(&app);
            }
        }
        "minimize" => {
            minimize_main(state, app.as_ref());
            tray_hint_once(state);
        }
        _ => {
            // 退出确认弹窗（带「记住我的选择」勾选框）→ 主线程模态弹出。
            // 模态框自带消息泵，主循环其余事件照常派发，不会卡死界面。
            let Some(app) = app else { return };
            let st = state.clone();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                st.log.log("boot", "close-flow: 主线程弹出退出确认框");
                let r = crate::dialog::show(
                    0,
                    &crate::dialog::DialogSpec {
                        title: "退出 Deepseek Harness".into(),
                        message: "要退出程序，还是在后台运行？".into(),
                        detail: "后台运行时窗口会隐藏到系统托盘，任务完成后会发通知。".into(),
                        buttons: vec!["最小化到后台".into(), "退出程序".into()],
                        default_index: 0,
                        checkbox: Some(("记住我的选择，不再询问".into(), false)),
                        icon: crate::dialog::DialogIcon::Question,
                        cancellable: false,
                    },
                );
                st.log.log(
                    "boot",
                    &format!(
                        "close-flow: 对话框返回 index={} checked={}",
                        r.index, r.checked
                    ),
                );
                if r.index == usize::MAX || r.cancel {
                    return; // 无法取消（cancellable=false），此分支仅防御
                }
                if r.checked {
                    let saved = if r.index == 1 { "quit" } else { "minimize" };
                    let _ = settings::set_key(
                        &st.paths.settings_file(),
                        "exitAction",
                        serde_json::json!(saved),
                    );
                    let _ = settings::set_key(
                        &st.paths.settings_file(),
                        "closeToTray",
                        serde_json::json!(saved != "quit"),
                    );
                }
                if r.index == 1 {
                    st.force_quit.store(true, Ordering::SeqCst);
                    crate::shutdown_flow(&app2);
                } else {
                    minimize_main(&st, Some(&app2));
                    tray_hint_once(&st);
                }
            });
        }
    }
}

/// 主窗隐藏到托盘（tauri 窗口方法跨线程安全；主线程调用亦可）。
fn minimize_main(state: &Arc<AppState>, app: Option<&AppHandle>) {
    if let Some(app) = app {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
            state.recovery.set_user_hidden(true);
        }
    }
}

static TRAY_HINTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn tray_hint_once(state: &Arc<AppState>) {
    if TRAY_HINTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = state.notify(
        "boot",
        "DSHEAC AIO 仍在运行",
        "窗口已隐藏到系统托盘，点击托盘图标可重新打开。",
    );
}

fn create_tray(app: AppHandle, state: &Arc<AppState>) {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let icon_path = state.paths.assets_dir().join("tray-icon.png");
    let icon = match tauri::image::Image::from_path(&icon_path) {
        Ok(i) => i,
        Err(e) => {
            state.log.log("boot", &format!("托盘图标加载失败: {}", e));
            return;
        }
    };
    let restart = MenuItem::with_id(&app, "restart", "重启 Web 服务", true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>).unwrap();
    let menu = Menu::with_items(&app, &[&restart, &quit]).unwrap();
    let st = state.clone();
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip(format!("DSHEAC AIO {}", DISPLAY_RELEASE))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let st2 = st.clone();
            match event.id().as_ref() {
                "restart" => {
                    show_main(app);
                    let s = st2.clone();
                    std::thread::spawn(move || {
                        boot::restart_service_core(&s);
                    });
                }
                "quit" => {
                    // 与菜单退出/X 关闭同流：干净标记 + 有界回收（直接
                    // exit(0) 会漏写 cleanExit，看门狗会把退出误判为崩溃）。
                    crate::shutdown_flow(app);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                // 左键点击：可见则隐藏，隐藏则显示（Electron 版语义）。
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                        let st: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
                        st.recovery.set_user_hidden(true);
                    } else {
                        show_main(&app);
                    }
                }
            }
        })
        .build(&app);
    match tray {
        Ok(_) => {
            state.tray_ready.store(true, Ordering::SeqCst);
            state.log.log("boot", "系统托盘已就绪");
        }
        Err(e) => state.log.log("boot", &format!("创建系统托盘失败: {}", e)),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.set_focus();
        let state: Arc<AppState> = app.state::<Arc<AppState>>().inner().clone();
        state.recovery.set_user_hidden(false);
    }
}

/// 恢复状态机周期体检：心跳丢失 → 退避 reload/rebuild/give-up；
/// 服务探活失败 → 同一决策树（did-fail-load 等价路径）。
fn recovery_tick(state: &Arc<AppState>) {
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    let Some(app) = state.app_handle() else {
        return;
    };
    // 服务探活（expecting_web 期间）：probe 失败视作加载失败。
    let web_url = state.web_url.lock().unwrap().clone();
    if let Some(url) = web_url {
        let port = port::extract_port(&url);
        if state.service_running() && !netprobe_quiet(port) {
            if let Some(action) = state.recovery.note_probe_failed() {
                apply_recovery_action(state, &app, action);
                return;
            }
        }
    }
    if let Some(action) = state.recovery.check() {
        apply_recovery_action(state, &app, action);
    }
}

fn netprobe_quiet(port: u16) -> bool {
    crate::netprobe::probe_localhost(port, std::time::Duration::from_millis(2500))
}

fn apply_recovery_action(state: &Arc<AppState>, app: &AppHandle, action: recovery::RecoveryAction) {
    use recovery::RecoveryAction::*;
    state.log.log(
        "recovery",
        &format!(
            "触发恢复动作: {:?}（failures={}）",
            action,
            state.recovery.state_of().failures
        ),
    );
    match action {
        Reload => {
            boot::navigate_main_to_web(app, state);
            // 加载完成事件会解除 in-flight；这里也给个兜底超时。
            let st = state.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(40));
                st.recovery.set_action_in_flight(false);
            });
        }
        Rebuild => {
            // 销毁重建主窗（保留 state；recovery 状态机延续计数）。
            if let Some(old) = app.get_webview_window("main") {
                let _ = old.destroy();
            }
            match boot::create_main_window(app) {
                Ok(win) => {
                    let st = state.clone();
                    let w = win.clone();
                    win.on_window_event(move |_event| on_window_event(&st, &w, _event));
                    let _ = win.show();
                    boot::navigate_main_to_web(app, state);
                }
                Err(e) => state.log.log("recovery", &format!("重建主窗失败: {}", e)),
            }
        }
        GiveUp => {
            boot::navigate_main_to_local(app, "recovery.html");
            let _ = state.notify(
                "recovery",
                "DSH Desktop 界面多次异常退出",
                "已暂停自动恢复并显示恢复页面。你的数据与后台任务不受影响，仍在继续运行。",
            );
        }
    }
}
