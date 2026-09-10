//! JS sidecar（shell-host.js）客户端：stdio 行式 JSON-RPC。
//! 协议：
//!   请求  {"id":N,"method":"ns.fn","params":{...}}
//!   响应  {"id":N,"ok":true,"result":...} | {"id":N,"ok":false,"error":"..."}
//!   事件  {"event":"log","tag":"boot","msg":"..."} 等（无 id）
//!
//! sidecar 复用全部现有 JS 模块（plugin-guard/updater/balance/...），
//! Rust 壳只做编排与平台能力，行为与 Electron 版逐一对齐。

use crate::logging::Logger;
use crate::paths::Paths;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub enum SidecarEvent {
    Log(String, String),
    /// sidecar 请求系统通知（title, body）。
    Notify(String, String),
    /// 余额数据推送（转发给 webview）。
    Balance(Value),
    /// 进程退出。
    Exited,
}

struct Inner {
    child: Mutex<Option<Child>>,
    writer: Mutex<Option<std::process::ChildStdin>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
}

#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<Inner>,
    events_tx: Sender<SidecarEvent>,
}

impl Sidecar {
    pub fn spawn(paths: &Paths, log: &Logger) -> Result<(Sidecar, Receiver<SidecarEvent>), String> {
        // V-T：sidecar 源码已 TypeScript 化，运行入口为编译产物
        // <appRoot>/sidecar/dist/shell-host.js（dev=仓库根、打包=resources/app 下同布局）。
        let host = paths
            .app_root
            .join("sidecar")
            .join("dist")
            .join("shell-host.js");
        if !host.exists() {
            return Err(format!("找不到 shell-host.js: {}", host.display()));
        }
        let mut cmd = Command::new(&paths.node_exe);
        cmd.arg(&host)
            .arg("--app-root")
            .arg(&paths.app_root)
            .arg("--user-data")
            .arg(&paths.user_data)
            .arg("--logs-dir")
            .arg(&paths.logs_dir)
            .arg("--dsh-home")
            .arg(&paths.dsh_home)
            .arg("--install-root")
            .arg(std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default())
            .arg("--client-version")
            .arg(&paths.version)
            .current_dir(&paths.app_root)
            .env("DSH_DESKTOP", "1")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 shell-host 失败: {}", e))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;

        let (events_tx, events_rx) = channel::<SidecarEvent>();
        let sidecar = Sidecar {
            inner: Arc::new(Inner {
                child: Mutex::new(Some(child)),
                writer: Mutex::new(Some(stdin)),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                alive: AtomicBool::new(true),
            }),
            events_tx: events_tx.clone(),
        };

        // 读线程：分发响应与事件。
        let inner = sidecar.inner.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    let resp = if msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(msg
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("sidecar 错误")
                            .to_string())
                    };
                    let sender = inner.pending.lock().unwrap().remove(&id);
                    if let Some(tx) = sender {
                        let _ = tx.send(resp);
                    }
                } else if let Some(ev) = msg.get("event").and_then(|v| v.as_str()) {
                    match ev {
                        "log" => {
                            let _ = events_tx.send(SidecarEvent::Log(
                                msg.get("tag")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("sidecar")
                                    .into(),
                                msg.get("msg").and_then(|v| v.as_str()).unwrap_or("").into(),
                            ));
                        }
                        "notify" => {
                            let _ = events_tx.send(SidecarEvent::Notify(
                                msg.get("title")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .into(),
                                msg.get("body")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .into(),
                            ));
                        }
                        "balance" => {
                            if let Some(data) = msg.get("data") {
                                let _ = events_tx.send(SidecarEvent::Balance(data.clone()));
                            }
                        }
                        _ => {}
                    }
                }
            }
            inner.alive.store(false, Ordering::SeqCst);
            // 所有在途请求立即失败。
            let mut map = inner.pending.lock().unwrap();
            for (_, tx) in map.drain() {
                let _ = tx.send(Err("sidecar 进程已退出".into()));
            }
            drop(map);
            let _ = events_tx.send(SidecarEvent::Exited);
        });

        log.log(
            "boot",
            &format!("shell-host sidecar 已启动 (pid={:?})", sidecar.pid()),
        );
        Ok((sidecar, events_rx))
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner
            .child
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|c| c.id()))
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, Duration::from_secs(300))
    }

    pub fn call_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("sidecar 未运行".into());
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        let req = serde_json::json!({"id": id, "method": method, "params": params});
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        {
            let mut guard = self.inner.writer.lock().unwrap();
            match guard.as_mut() {
                Some(w) => w
                    .write_all(line.as_bytes())
                    .map_err(|e| format!("sidecar 写入失败: {}", e))?,
                None => return Err("sidecar 管道已关闭".into()),
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(resp) => resp,
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "sidecar 调用超时: {}（{} 秒）",
                    method,
                    timeout.as_secs()
                ))
            }
        }
    }

    /// 有界强杀 sidecar（退出路径）：先关 stdin 让其自然退出，超时再 taskkill。
    pub fn kill(&self) {
        self.inner.alive.store(false, Ordering::SeqCst);
        // 关闭写端：shell-host 收到 EOF 后自行退出（清理动作最小化）。
        let _ = self.inner.writer.lock().unwrap().take();
        let pid = self.pid();
        if let Ok(mut guard) = self.inner.child.lock() {
            if let Some(mut child) = guard.take() {
                // 给 800ms 自然退出窗口，之后由下方 taskkill 兜底。
                for _ in 0..4 {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                        Err(_) => return,
                    }
                }
            }
        }
        if let Some(pid) = pid {
            crate::procwin::kill_pid_tree_and_wait(
                pid,
                Duration::from_millis(800),
                Duration::from_millis(2000),
            );
        }
    }
}
