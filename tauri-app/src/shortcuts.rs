//! 快捷方式维护（main.js maintainShortcuts 移植，PowerShell WScript.Shell
//! 实现 .lnk 读写）。语义完整保留：
//!   · 开始菜单快捷方式按 target 匹配维护（系统 Toast 通知的前置条件）；
//!   · 桌面快捷方式 policy=never 不创建；已有任意名称指向本应用的 .lnk
//!     即视为存在，绝不重复新建（V4「换图标后多出快捷方式」修复）；
//!   · exe 搬家/图标版本更新时只刷新「确认属于本应用」的快捷方式，
//!     用户自定义图标绝不覆盖。

use crate::logging::Logger;
use crate::paths::Paths;
use crate::settings;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
const SHORTCUT_ICON_VERSION: &str = "whale-2";
const APP_TITLE: &str = "DSHEAC AIO";

fn ps(script: &str) -> Option<String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ps_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "''"))
}

fn read_lnk_target(lnk: &Path) -> Option<String> {
    let s = ps(&format!(
        "(New-Object -ComObject WScript.Shell).CreateShortcut({}).TargetPath",
        ps_quote(&lnk.to_string_lossy())
    ))?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn read_lnk_icon(lnk: &Path) -> Option<String> {
    ps(&format!(
        "(New-Object -ComObject WScript.Shell).CreateShortcut({}).IconLocation",
        ps_quote(&lnk.to_string_lossy())
    ))
}

fn write_lnk(lnk: &Path, target: &Path, description: &str, icon: Option<&Path>) -> bool {
    let icon_line = match icon {
        Some(ico) => format!(
            "$s.IconLocation = {}; ",
            ps_quote(&format!("{},0", ico.display()))
        ),
        None => String::new(),
    };
    ps(&format!(
        "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut({}); $s.TargetPath = {}; $s.Description = {}; {}$s.Save()",
        ps_quote(&lnk.to_string_lossy()),
        ps_quote(&target.to_string_lossy()),
        ps_quote(description),
        icon_line,
    ))
    .is_some()
}

fn same_path(a: &str, b: &Path) -> bool {
    a.eq_ignore_ascii_case(&b.to_string_lossy())
}

fn list_lnk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file()
                && p.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("lnk"))
                    .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
    out
}

fn is_managed_target(target: &str, current: &Path, previous: Option<&Path>) -> bool {
    same_path(target, current)
        || previous.map(|path| same_path(target, path)).unwrap_or(false)
}

fn lnk_targets_app(lnk: &Path, targets: &[&Path]) -> bool {
    read_lnk_target(lnk)
        .map(|t| targets.iter().any(|x| same_path(&t, x)))
        .unwrap_or(false)
}

fn lnk_targets_managed(lnk: &Path, current: &Path, previous: Option<&Path>) -> bool {
    read_lnk_target(lnk)
        .map(|target| is_managed_target(&target, current, previous))
        .unwrap_or(false)
}

fn lnk_uses_managed_icon(lnk: &Path, ico: &Path) -> bool {
    match read_lnk_icon(lnk) {
        // 无自定义图标（空或等于 target 自带）视为可接管。
        None => true,
        Some(s) if s.trim().is_empty() || s == ",0" || s == "0" => true,
        Some(s) => {
            let icon_path = s.split(',').next().unwrap_or("").trim();
            icon_path.is_empty() || same_path(icon_path, ico)
        }
    }
}

/// 复制 icon.ico 到 userData 保证路径稳定。
fn shortcut_icon_path(paths: &Paths, log: &Logger) -> Option<PathBuf> {
    let src = paths.assets_dir().join("icon.ico");
    if !src.exists() {
        return None;
    }
    let dst = paths.user_data.join("icon.ico");
    let ok = if !dst.exists()
        || std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0)
            != std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(1)
    {
        std::fs::copy(&src, &dst).is_ok()
    } else {
        true
    };
    if ok {
        Some(dst)
    } else {
        log.log("boot", "复制快捷方式图标失败");
        Some(src)
    }
}

pub fn maintain_shortcuts(paths: &Paths, log: &Logger) {
    if !paths.packaged {
        return;
    }
    // E2E / 自动化：跳过（对齐 DSH_DESKTOP_TEST_NO_SHORTCUTS 约定）。
    if std::env::var("DSH_DESKTOP_TEST_NO_SHORTCUTS").as_deref() == Ok("1") {
        return;
    }
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return,
    };
    let settings_file = paths.settings_file();
    let doc = settings::load_at(&settings_file);
    let policy = if doc.get("shortcutPolicy").and_then(|v| v.as_str()) == Some("never") {
        "never"
    } else {
        "auto"
    };
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let links_dir = appdata
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    let desktop_dir = dirs_desktop();
    let start_menu = links_dir.join(format!("{}.lnk", APP_TITLE));
    let desktop = desktop_dir.join(format!("{}.lnk", APP_TITLE));
    let Some(ico) = shortcut_icon_path(paths, log) else {
        return;
    };

    // 不按文件名接管或删除任何其他产品快捷方式。只有 TargetPath 明确
    // 指向当前 AIO EXE（或本产品 settings 中记录的上一 AIO 目标）才维护。

    let prev_target = doc
        .get("shortcutTarget")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let prev_icon = doc
        .get("shortcutIcon")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let target_moved = !prev_target.is_empty() && !same_path(prev_target, &exe);
    let icon_outdated = prev_icon != SHORTCUT_ICON_VERSION;
    let mut changed = false;

    if target_moved || icon_outdated {
        let previous = if target_moved && !prev_target.is_empty() {
            Some(Path::new(prev_target))
        } else {
            None
        };
        let is_ours = |p: &Path| p.exists() && lnk_targets_managed(p, &exe, previous);
        let mut candidates = vec![start_menu.clone()];
        if policy != "never" {
            candidates.extend(list_lnk_files(&desktop_dir));
        }
        for p in candidates {
            if !is_ours(&p) {
                continue;
            }
            // 仅图标过时且用户自定义了图标：尊重用户选择；target 移动时即使
            // 图标被自定义也要修指向（否则快捷方式失效）。
            if !target_moved && !lnk_uses_managed_icon(&p, &ico) {
                continue;
            }
            if write_lnk(
                &p,
                &exe,
                concat!("DSHEAC AIO v", env!("CARGO_PKG_VERSION")),
                Some(&ico),
            ) {
                changed = true;
            }
        }
    }

    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    let start_menu_ok = start_menu.exists() && lnk_targets_app(&start_menu, &[&exe]);
    if !start_menu_ok
        && write_lnk(
            &start_menu,
            &exe,
            concat!("DSHEAC AIO v", env!("CARGO_PKG_VERSION")),
            Some(&ico),
        )
    {
        changed = true;
    }
    // 桌面快捷方式：已有任意名称指向本应用的 .lnk 即不再新建。
    if policy != "never" && !desktop.exists() {
        let has_ours = list_lnk_files(&desktop_dir)
            .iter()
            .any(|p| lnk_targets_app(p, &[&exe]));
        if !has_ours {
            if write_lnk(
                &desktop,
                &exe,
                concat!("DSHEAC AIO v", env!("CARGO_PKG_VERSION")),
                Some(&ico),
            ) {
                changed = true;
            }
        } else {
            log.log(
                "boot",
                "检测到用户自定义的桌面快捷方式（指向本应用），不再重复创建",
            );
        }
    }
    if changed {
        let mut next = doc.clone();
        if let Some(obj) = next.as_object_mut() {
            obj.insert(
                "shortcutTarget".into(),
                Value::String(exe.to_string_lossy().to_string()),
            );
            obj.insert(
                "shortcutIcon".into(),
                Value::String(SHORTCUT_ICON_VERSION.into()),
            );
        }
        let _ = settings::save_at(&settings_file, &next);
        log.log(
            "boot",
            &format!(
                "快捷方式已维护（开始菜单/桌面 → {}，图标 {}）",
                exe.display(),
                SHORTCUT_ICON_VERSION
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_ownership_never_claims_another_product() {
        let current = Path::new(r"C:\Apps\DSHEAC AIO\DSHEAC AIO.exe");
        let previous = Path::new(r"D:\Portable\DSHEAC AIO.exe");
        assert!(is_managed_target(r"C:\Apps\DSHEAC AIO\DSHEAC AIO.exe", current, Some(previous)));
        assert!(is_managed_target(r"D:\Portable\DSHEAC AIO.exe", current, Some(previous)));
        assert!(!is_managed_target(r"C:\Apps\DSH Desktop\DSH Desktop.exe", current, Some(previous)));
        assert!(!is_managed_target(r"C:\Apps\Deepseek Harness EAC\Deepseek Harness EAC.exe", current, Some(previous)));
    }
}

fn dirs_desktop() -> PathBuf {
    // 已知文件夹 Desktop（尊重 OneDrive 重定向）。
    if let Some(out) = ps("[Environment]::GetFolderPath('Desktop')") {
        if !out.is_empty() {
            return PathBuf::from(out);
        }
    }
    let home = std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join("Desktop")
}
