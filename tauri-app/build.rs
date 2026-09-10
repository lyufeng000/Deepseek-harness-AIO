// Tauri v2.11 起，非本地 URL（含 http://127.0.0.1:* 的 dsh Web UI）调用应用
// 自有命令一律走显式 ACL：必须先用 AppManifest 声明命令生成 allow-* 权限，
// 再在 capabilities/main.json 里授予。两处必须同步维护（新增命令时两处都加）。
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "client_update",
            "renderer_heartbeat",
            "page_error",
            "chrome_init",
            "chrome_window",
            "chrome_menu",
            "chrome_restart_service",
            "guard_action",
            "plugin_list",
            "plugin_set_enabled",
            "plugin_set_removed",
            "plugin_updates",
            "plugin_update",
            "plugin_auto_update",
            "balance_refresh",
            "balance_prices_get",
            "balance_prices_set",
            "balance_prices_reset",
            "open_external",
            "recovery_state",
            "recovery_reload",
            "recovery_restart",
            "recovery_open_logs",
        ]),
    ))
    .expect("tauri build 失败");
}
