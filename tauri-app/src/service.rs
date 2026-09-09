//! dsh web 服务生命周期：spawn 内置 node.exe 跑 dsh CLI、stdout 就绪行解析、
//! HTTP 探测竞争、Chromium 受限端口递归重启、有界进程树回收。
//! 对应 main.js 的 startServer / watchServerProc / waitUntilUp / startAndShow。

use crate::logging::Logger;
use crate::paths::Paths;
use crate::port;
use crate::procwin;
use crate::settings;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 就绪行正则 `/dsh web:\s+(https?:\/\/\S+)/` 的手工解析。
pub fn parse_ready_url(line: &str) -> Option<String> {
    let idx = line.find("dsh web:")?;
    let rest = line[idx + "dsh web:".len()..].trim_start();
    let token = rest.split_whitespace().next()?;
    if token.starts_with("http://") || token.starts_with("https://") {
        Some(token.to_string())
    } else {
        None
    }
}

#[derive(Debug)]
pub enum ServiceEvent {
    /// stdout 就绪行命中。只有刚启动的子进程能产生该事件；HTTP 探测
    /// 仅用于随后确认可访问性，不能独立建立可信 origin。
    ReadyLine(String),
    /// 子进程退出（code, signal）。
    Exited(Option<i32>, String),
    /// 启动超时（秒）。
    BootTimeout(u64),
}

pub struct ServiceHandle {
    pub child: Mutex<Child>,
    pub pid: u32,
    #[cfg(windows)]
    job: Mutex<Option<crate::procwin::JobHandle>>,
    /// 服务是否曾就绪（决定退出时是否弹「服务已停止」）。
    pub was_ready: AtomicBool,
    /// 主动重启/退出标记：退出事件不再弹窗。
    pub intentional: AtomicBool,
    /// 进程已退出（由监视线程置位）。
    pub exited: AtomicBool,
}

impl ServiceHandle {
    #[cfg(windows)]
    pub fn terminate_job(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        if let Ok(mut guard) = self.job.lock() {
            if let Some(crate::procwin::JobHandle(h)) = guard.take() {
                unsafe {
                    let _ = TerminateJobObject(h, 1);
                    let _ = windows::Win32::Foundation::CloseHandle(h);
                }
            }
        }
    }
    #[cfg(not(windows))]
    pub fn terminate_job(&self) {}
}

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        self.terminate_job();
    }
}

pub struct StartOutcome {
    pub url: String,
    pub handle: Arc<ServiceHandle>,
}

/// startServer + watchServerProc 的合并移植。
///
/// * `overlays` —— --patch 覆盖层（koffi 降级 overlay 等）。
/// * `unsafe_retries` —— 受限端口重启剩余次数（首启 4）。
/// * `tx`/`rx` —— 生命周期事件通道（就绪竞争在函数内消费；返回后 rx 归
///   调用方继续监视 Exited 等事件）。
pub fn start_server(
    paths: &Paths,
    log: &Logger,
    overlays: &[String],
    unsafe_retries: u32,
    events: Sender<ServiceEvent>,
    receiver: std::sync::mpsc::Receiver<ServiceEvent>,
) -> Result<(StartOutcome, std::sync::mpsc::Receiver<ServiceEvent>), String> {
    // M1 修复语义：重入由调用方（restart）负责终结旧进程；这里只管起新的。
    let web_port = port::choose_stable_web_port(&paths.settings_file());
    let node_bin = paths.node_exe.clone();
    let bin = paths.dsh_bin();
    if !node_bin.exists() {
        return Err(format!(
            "找不到内置 Node 运行时: {}\n{}",
            node_bin.display(),
            if paths.packaged {
                "安装包可能不完整，请重新安装。".to_string()
            } else {
                "开发模式请先运行: npm run fetch-node".to_string()
            }
        ));
    }
    let profile = paths.desktop_profile();
    let first_boot = !paths.desktop_profile_dir().join("node_modules").exists();

    let mut cmd = Command::new(&node_bin);
    cmd.arg("--use-system-ca")
        .arg(&bin)
        .arg("--profile")
        .arg(&profile)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(web_port.to_string())
        // 内核 0.1.1-rc.2 起本机启动默认拉起系统浏览器，桌面壳自带窗口必须关掉
        .arg("--no-open");
    for p in overlays {
        if !p.is_empty() && PathBuf::from(p).exists() {
            cmd.arg("--patch").arg(p);
        }
    }
    cmd.current_dir(&paths.user_data)
        .env("DSH_HOME", &paths.dsh_home)
        .env("DSH_DESKTOP", "1")
        .env("DSH_DESKTOP_PROFILE", &profile)
        .env("NO_COLOR", "1")
        // 丢弃 harness/session 残留，保持桌面实例干净启动（保留代理/API key 等）。
        .env_remove("DSH_WEB_URL")
        .env_remove("DSH_SESSION_ID")
        .env_remove("DSH_SESSION_JSONL")
        .env_remove("DSH_SHELL")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("NODE_OPTIONS")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    log.log(
        "dsh",
        &format!(
            "启动: {:?} {:?} web --host 127.0.0.1 --port {} --profile {}",
            node_bin, bin, web_port, profile
        ),
    );
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 dsh web 失败: {}", e))?;
    let pid = child.id();

    #[cfg(windows)]
    let job = {
        match procwin::assign_job(pid) {
            Ok(h) => Some(h),
            Err(e) => {
                log.log(
                    "dsh",
                    &format!(
                        "dsh web pid={} Job 分配失败: {}（shell 自身 in_job={}）",
                        pid,
                        e,
                        procwin::process_in_any_job(std::process::id())
                    ),
                );
                None
            }
        }
    };
    #[cfg(not(windows))]
    let job = ();
    // 兜底保护必须可见：分配结果与成员关系记入日志。
    #[cfg(windows)]
    let job_assigned = job.is_some();
    #[cfg(not(windows))]
    let job_assigned = true;
    if job_assigned {
        log.log(
            "dsh",
            &format!(
                "dsh web pid={} job 分配成功（in_job={}）",
                pid,
                procwin::process_in_any_job(pid)
            ),
        );
    }

    let handle = Arc::new(ServiceHandle {
        pid,
        child: Mutex::new(child),
        was_ready: AtomicBool::new(false),
        intentional: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        #[cfg(windows)]
        job: Mutex::new(job),
    });

    let log_file: File = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs_dir.join("dsh-web.log"))
        .map_err(|e| format!("打开 dsh-web.log 失败: {}", e))?;
    let log_file = Arc::new(Mutex::new(log_file));

    // stdout 就绪行扫描线程（stderr 并入同一日志）。
    {
        let events = events.clone();
        let log_file = log_file.clone();
        let mut stdout = handle
            .child
            .lock()
            .unwrap()
            .stdout
            .take()
            .ok_or("stdout 不可用")?;
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let _ = log_file.lock().map(|mut f| writeln!(f, "{}", line));
                if let Some(url) = parse_ready_url(&line) {
                    let _ = events.send(ServiceEvent::ReadyLine(url));
                }
            }
        });
    }
    {
        let log_file = log_file.clone();
        let mut stderr = handle
            .child
            .lock()
            .unwrap()
            .stderr
            .take()
            .ok_or("stderr 不可用")?;
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let _ = log_file.lock().map(|mut f| writeln!(f, "{}", line));
            }
        });
    }

    // 退出监视线程。
    {
        let events = events.clone();
        let handle = handle.clone();
        std::thread::spawn(move || {
            let code = loop {
                if let Ok(mut c) = handle.child.lock() {
                    match c.try_wait() {
                        Ok(Some(st)) => break st.code(),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            };
            handle.exited.store(true, Ordering::SeqCst);
            let _ = events.send(ServiceEvent::Exited(code, String::new()));
        });
    }

    // 启动超时（首启 180s：profile 需 pnpm 装依赖；稳态 60s）。
    {
        let events = events.clone();
        let secs = if first_boot { 180 } else { 60 };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            let _ = events.send(ServiceEvent::BootTimeout(secs));
        });
    }

    // 等待首个就绪事件；受限端口命中则递归重启。
    loop {
        let ev = match receiver.recv() {
            Ok(ev) => ev,
            Err(_) => return Err("dsh web 事件通道关闭".into()),
        };
        let url = match &ev {
            ServiceEvent::ReadyLine(u) => Some(u.clone()),
            _ => None,
        };
        match ev {
            ServiceEvent::ReadyLine(_) => {
                let url = url.unwrap_or_else(|| format!("http://127.0.0.1:{}", web_port));
                let blocked = port::restricted_port_of(&url);
                if blocked > 0 && unsafe_retries > 0 {
                    log.log(
                        "dsh",
                        &format!(
                            "端口 {} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 {} 次）",
                            blocked, unsafe_retries
                        ),
                    );
                    handle.intentional.store(true, Ordering::SeqCst);
                    kill_handle(&handle);
                    std::thread::sleep(Duration::from_millis(600));
                    return start_server(
                        paths,
                        log,
                        overlays,
                        unsafe_retries - 1,
                        events,
                        receiver,
                    );
                }
                // 稳定端口：dsh 实际监听端口与请求不同（极端兜底）时以实际为准。
                let actual = port::extract_port(&url);
                if web_port > 0 && actual > 0 && actual != web_port {
                    let _ = settings::set_key(
                        &paths.settings_file(),
                        "webPort",
                        serde_json::json!(actual),
                    );
                }
                handle.was_ready.store(true, Ordering::SeqCst);
                return Ok((StartOutcome { url, handle }, receiver));
            }
            ServiceEvent::Exited(code, _) => {
                return Err(format!(
                    "dsh web 启动失败（退出码 {}）。日志: {}",
                    code.map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    paths.logs_dir.join("dsh-web.log").display()
                ));
            }
            ServiceEvent::BootTimeout(secs) => {
                return Err(format!("等待 dsh web 启动超时（{} 秒）", secs));
            }
        }
    }
}

/// killTreeAndWait 的句柄版：优雅 → 强杀 → Job 兜底，全程有界。
pub fn kill_handle(handle: &ServiceHandle) {
    handle.intentional.store(true, Ordering::SeqCst);
    let mut child = match handle.child.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    if child.try_wait().map(|s| s.is_some()).unwrap_or(true) {
        return;
    }
    procwin::kill_tree_and_wait(
        &mut child,
        Duration::from_millis(procwin::GRACE_MS),
        Duration::from_millis(procwin::HARD_MS),
    );
    drop(child);
    handle.terminate_job();
}

/// waitUntilUp：服务就绪后窗口重载前的最终确认。
pub fn wait_until_up(port_num: u16, timeout: Duration) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        if crate::netprobe::probe_localhost(port_num, Duration::from_millis(3000)) {
            return Ok(());
        }
        if started.elapsed() > timeout {
            return Err("Web UI 未在预期时间内就绪".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_parsing() {
        assert_eq!(
            parse_ready_url("2026/08/21 12:00:00 dsh web: http://127.0.0.1:18080 ready"),
            Some("http://127.0.0.1:18080".to_string())
        );
        assert_eq!(
            parse_ready_url("dsh web:   https://127.0.0.1:443/x"),
            Some("https://127.0.0.1:443/x".to_string())
        );
        assert_eq!(parse_ready_url("no url here"), None);
        assert_eq!(parse_ready_url("dsh web: not-a-url"), None);
        assert_eq!(
            parse_ready_url("dsh web: http://127.0.0.1:18080/?token=qualification-test"),
            Some("http://127.0.0.1:18080/?token=qualification-test".to_string())
        );
    }
}
