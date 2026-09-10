// 入口：--dsh-watchdog 参数时以看门狗模式运行（同一 exe 再入，替代 Electron
// 版的独立 watchdog.js Node 进程），否则启动桌面壳。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if dsh_desktop_aio_lib::client_update::helper_entry() { return; }
    if std::env::args().any(|a| a.starts_with("--dsh-watchdog")) {
        dsh_desktop_aio_lib::watchdog::run_as_watchdog();
    }
    dsh_desktop_aio_lib::run();
}
