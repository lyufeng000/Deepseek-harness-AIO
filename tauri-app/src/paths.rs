//! 路径解析：开发模式直接用仓库根（与 Electron 版共享 vendor/node_modules），
//! 打包模式用 Tauri resource 目录下 staging 脚本铺好的 app/node/npm。

use std::path::PathBuf;
use serde::{Deserialize, Serialize};

pub struct Paths {
    /// 应用 JS 根（shell-host.js / assets / node_modules 所在目录）。
    pub app_root: PathBuf,
    /// 内置 node.exe。
    pub node_exe: PathBuf,
    /// 内置 npm CLI 入口。
    pub npm_cli: PathBuf,
    /// 用户数据目录（%APPDATA%/<identifier>，Tauri app_data_dir）。
    pub user_data: PathBuf,
    /// 日志目录。
    pub logs_dir: PathBuf,
    /// DSH_HOME（env 显式覆盖优先，否则使用本产品独立数据目录）。
    pub dsh_home: PathBuf,
    pub packaged: bool,
    pub version: String,
}

impl Paths {
    pub fn new(
        packaged: bool,
        resource_dir: Option<PathBuf>,
        app_data_dir: PathBuf,
        version: String,
    ) -> Paths {
        // Tauri v2 在 Windows 上把 resources/**/* 落在 <exe目录>\resources\ 下，
        // 而 resource_dir() 返回 exe 目录本身 —— 必须补上 resources 层，
        // 否则打包版找不到 shell-host/assets/node_modules（真机验证发现）。
        // 另外 resource_dir() 返回 \\?\ 开头的 verbatim 路径，Node 解析主入口会炸（EISDIR: lstat 'D:'），
        // 这里统一剥掉前缀（dunce 手法）。
        let res = strip_verbatim(resource_dir.clone().unwrap_or_default().join("resources"));
        let app_root = if packaged {
            res.join("app")
        } else {
            // dev：tauri-app 的上一级即仓库根
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default()
        };
        let node_exe = if packaged {
            res.join("node").join("node.exe")
        } else {
            app_root.join("vendor").join("node").join("node.exe")
        };
        let npm_cli = if packaged {
            res.join("npm").join("bin").join("npm-cli.js")
        } else {
            app_root
                .join("vendor")
                .join("npm")
                .join("bin")
                .join("npm-cli.js")
        };
        // 便携包在 exe 同级带 `.dsh-portable`，数据进入 `.dsh-aio-data`；
        // 安装版继续使用独立 appData。环境变量始终优先，供自动化与高级用户覆盖。
        let portable_data = portable_data_dir(packaged, resource_dir.as_deref());
        let user_data = match std::env::var("DSH_DESKTOP_USERDATA") {
            Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
            _ => portable_data.clone().unwrap_or(app_data_dir),
        };
        let dsh_home = match std::env::var("DSH_HOME") {
            Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
            _ => portable_data
                .map(|dir| dir.join("dsh-home"))
                .unwrap_or_else(|| user_data.join("dsh-home")),
        };
        Paths {
            app_root,
            node_exe,
            npm_cli,
            logs_dir: user_data.join("logs"),
            user_data,
            dsh_home,
            packaged,
            version,
        }
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.app_root.join("assets")
    }

    /// 当前生效的 dsh bin：用户目录更新覆盖层优先，内置副本兜底。
    pub fn dsh_bin(&self) -> PathBuf {
        let overlay = self
            .user_data
            .join("agent")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if overlay.exists() {
            return overlay;
        }
        self.app_root
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
    }

    pub fn desktop_profile(&self) -> String {
        // AIO 永远使用专属 profile。旧版 shareWebProfile 会继承 web
        // profile 内的第三方插件，与新安装包的无插件继承策略冲突。
        DESKTOP_PROFILE.to_string()
    }

    pub fn desktop_profile_dir(&self) -> PathBuf {
        self.dsh_home.join("profiles").join(self.desktop_profile())
    }

    pub fn settings_file(&self) -> PathBuf {
        self.user_data.join("settings.json")
    }

    pub fn run_state_file(&self) -> PathBuf {
        self.user_data.join("run-state.json")
    }

    pub fn koffi_overlay_file(&self) -> PathBuf {
        self.user_data.join("picker-browse.overlay.yml")
    }

    /// Install the packaged profile snapshot. Existing AIO homes keep their
    /// root-level sessions, attachments, provider settings and credentials;
    /// the desktop profile is refreshed onto the packaged dependency closure,
    /// while user-visible settings (patch rows, plugin config, custom files and
    /// user-installed packages) are carried over into the new profile. A copy
    /// of the replaced user bytes is retained under `.aio-user-settings-backup`
    /// even after boot health commits the swap, so nothing a user changed is
    /// lost. The old profile remains as a pending-health backup until boot
    /// calls commit_distribution_profile_seed().
    pub fn seed_distribution_profile(&self) -> Result<SeedReport, String> {
        let seed = self
            .app_root
            .parent()
            .ok_or_else(|| "resource root is unavailable".to_string())?
            .join("profile-seed");
        if !seed.exists() || self.desktop_profile() != DESKTOP_PROFILE {
            return Ok(SeedReport::unchanged());
        }
        let seed_profile = seed.join("profiles").join(DESKTOP_PROFILE);
        if !seed_profile.is_dir() {
            return Err("distribution profile seed is incomplete".into());
        }
        let seed_fingerprint = tree_fingerprint(&seed_profile)?;
        let marker_file = self.dsh_home.join(PROFILE_SEED_MARKER);

        if seed_home_is_empty(&self.dsh_home)? {
            copy_tree(&seed, &self.dsh_home)?;
            clear_legacy_plugin_preferences(&self.settings_file())?;
            write_seed_marker(&marker_file, &ProfileSeedMarker::committed(
                &self.version, &seed_fingerprint, None,
            ))?;
            return Ok(SeedReport::changed());
        }
        ensure_plain_directory(&self.dsh_home)?;
        if let Some(marker) = read_seed_marker(&marker_file)? {
            if marker.state == "pending-health" {
                if let Some(backup_name) = marker.backup_name.as_deref() {
                    rollback_pending_profile(&self.dsh_home, backup_name)?;
                    let _ = std::fs::remove_file(&marker_file);
                    return Err("previous profile seed did not pass boot health; old profile restored".into());
                }
                // There was no old profile to restore. Keep testing the exact
                // seed already active and commit it after a healthy boot.
                return Ok(SeedReport::changed());
            }
            if marker.state == "committed"
                && marker.app_version == self.version
                && marker.seed_fingerprint == seed_fingerprint
            {
                if let Some(backup_name) = marker.backup_name.as_deref() {
                    cleanup_profile_backup(&self.dsh_home, backup_name)?;
                    write_seed_marker(&marker_file, &ProfileSeedMarker::committed(
                        &self.version, &seed_fingerprint, None,
                    ))?;
                }
                return Ok(SeedReport::unchanged());
            }
        }

        let profiles = self.dsh_home.join("profiles");
        std::fs::create_dir_all(&profiles)
            .map_err(|e| format!("create {}: {e}", profiles.display()))?;
        ensure_plain_directory(&profiles)?;
        let active = profiles.join(DESKTOP_PROFILE);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "system clock is before unix epoch".to_string())?
            .as_nanos();
        let candidate_name = format!(".{DESKTOP_PROFILE}-aio-seed-{}-{nonce}", std::process::id());
        let backup_name = format!(".{DESKTOP_PROFILE}-aio-backup-{}-{nonce}", std::process::id());
        let candidate = profiles.join(&candidate_name);
        let backup = profiles.join(&backup_name);
        copy_tree(&seed_profile, &candidate)?;
        if tree_fingerprint(&candidate)? != seed_fingerprint {
            let _ = std::fs::remove_dir_all(&candidate);
            return Err("copied profile seed fingerprint mismatch".into());
        }
        let had_active = active.exists();
        let mut migration = UserProfileMigration::default();
        let mut preserved_backup = None;
        let mut backup_error = None;
        if had_active {
            ensure_plain_directory(&active)?;
            // 依赖闭包换成发行包的新版本，用户设置字节原样带过去；失败则整
            // 个候选目录作废，绝不带着半份用户数据激活新 profile。
            migration = match migrate_user_profile(&active, &candidate) {
                Ok(migration) => migration,
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&candidate);
                    return Err(format!("preserve user profile settings: {e}"));
                }
            };
            // 快照必须在旧 profile 被改名之前做：健康提交会删掉 pending 备份，
            // 但这份用户设置副本保留，供修剪后回退查看。
            preserved_backup = match backup_user_settings(&active, &self.dsh_home) {
                Ok(name) => Some(name),
                Err(e) => {
                    backup_error = Some(e);
                    None
                }
            };
            std::fs::rename(&active, &backup)
                .map_err(|e| format!("backup {} -> {}: {e}", active.display(), backup.display()))?;
        }
        if let Err(e) = std::fs::rename(&candidate, &active) {
            if had_active {
                let _ = std::fs::rename(&backup, &active);
            }
            let _ = std::fs::remove_dir_all(&candidate);
            return Err(format!("activate {} -> {}: {e}", candidate.display(), active.display()));
        }
        let pending = ProfileSeedMarker::pending(
            &self.version, &seed_fingerprint, had_active.then_some(backup_name),
        );
        if let Err(e) = write_seed_marker(&marker_file, &pending) {
            let _ = std::fs::remove_dir_all(&active);
            if let Some(name) = pending.backup_name.as_deref() {
                let _ = std::fs::rename(profiles.join(name), &active);
            }
            return Err(e);
        }
        clear_legacy_plugin_preferences(&self.settings_file())?;
        Ok(SeedReport {
            changed: true,
            preserved_files: migration.files.len(),
            preserved_packages: migration.packages.len(),
            preserved_backup,
            backup_error,
            skipped: migration.skipped,
        })
    }

    /// Commit a profile replacement only after dsh web has passed startup
    /// health. Marker-first cleanup makes an interrupted backup deletion safe
    /// to retry without ever reactivating old plugins.
    pub fn commit_distribution_profile_seed(&self) -> Result<bool, String> {
        let marker_file = self.dsh_home.join(PROFILE_SEED_MARKER);
        let Some(marker) = read_seed_marker(&marker_file)? else { return Ok(false) };
        if marker.state != "pending-health" {
            return Ok(false);
        }
        let committed = ProfileSeedMarker::committed(
            &marker.app_version, &marker.seed_fingerprint, marker.backup_name.clone(),
        );
        write_seed_marker(&marker_file, &committed)?;
        if let Some(backup_name) = committed.backup_name.as_deref() {
            cleanup_profile_backup(&self.dsh_home, backup_name)?;
            write_seed_marker(&marker_file, &ProfileSeedMarker::committed(
                &committed.app_version, &committed.seed_fingerprint, None,
            ))?;
        }
        let plugin_cache = self.dsh_home.join("plugin-artifact-cache");
        if plugin_cache.exists() {
            ensure_plain_directory(&plugin_cache)?;
            std::fs::remove_dir_all(&plugin_cache)
                .map_err(|e| format!("remove {}: {e}", plugin_cache.display()))?;
        }
        Ok(true)
    }
}

pub const DESKTOP_PROFILE: &str = "web-desktop";
const PROFILE_SEED_MARKER: &str = ".aio-profile-seed.json";
/// 与官方 web profile 出厂模板一致（@deepseek-ai/dsh-base + dsh-web-app）。
pub const DESKTOP_PROFILE_BUNDLES: [&str; 2] =
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

pub fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE").ok().map(PathBuf::from)
}

fn seed_home_is_empty(home: &std::path::Path) -> Result<bool, String> {
    for ancestor in home.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => return Ok(false),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("cannot inspect seed destination".into());
            }
            _ => {}
        }
    }
    match std::fs::symlink_metadata(home) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err("cannot inspect seed destination".into()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Ok(false),
        Ok(_) => std::fs::read_dir(home)
            .map(|mut entries| entries.next().is_none())
            .map_err(|_| "cannot inspect seed destination".into()),
    }
}

/// profile 内属于依赖闭包 / 包管理器状态的条目：更新时始终换成发行包的新版本。
const PROFILE_DEPENDENCY_ARTIFACTS: [&str; 4] =
    ["node_modules", ".dsh-module-fallback", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
/// 用户设置快照目录（在 dsh_home 下，隐藏；不随健康提交删除）。
const USER_SETTINGS_BACKUP_DIR: &str = ".aio-user-settings-backup";

/// 发行包 profile 植入结果。
pub struct SeedReport {
    /// false = 本次启动无需替换（版本与 seed 指纹都已生效）。
    pub changed: bool,
    /// 从旧 profile 迁移过来的用户设置条目数。
    pub preserved_files: usize,
    /// 从旧 profile 迁移过来的用户新增包数。
    pub preserved_packages: usize,
    /// 用户设置快照目录名（相对 dsh_home）；备份失败时为 None。
    pub preserved_backup: Option<String>,
    /// 用户设置快照失败原因（不阻断启动，仅供日志）。
    pub backup_error: Option<String>,
    /// 迁移时跳过的条目（链接等），供日志提示。
    pub skipped: Vec<String>,
}

impl SeedReport {
    fn unchanged() -> Self {
        Self {
            changed: false,
            preserved_files: 0,
            preserved_packages: 0,
            preserved_backup: None,
            backup_error: None,
            skipped: Vec::new(),
        }
    }
    fn changed() -> Self {
        Self { changed: true, ..Self::unchanged() }
    }
}

#[derive(Default)]
struct UserProfileMigration {
    files: Vec<String>,
    packages: Vec<String>,
    skipped: Vec<String>,
}

fn read_profile_json(file: &std::path::Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_profile_json(file: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    std::fs::write(file, bytes).map_err(|e| format!("write {}: {e}", file.display()))
}

/// 合并 profile manifest：依赖与 overrides 以发行包闭包为准，用户额外安装的包 /
/// 覆盖项、以及用户自选的 bundles 原样保留。
fn merge_profile_manifest(
    seed: &serde_json::Value,
    user: Option<&serde_json::Value>,
) -> serde_json::Value {
    use serde_json::Value;
    let mut out = seed.clone();
    let Some(user) = user.and_then(Value::as_object) else { return out };
    let Some(object) = out.as_object_mut() else { return out };
    for section in ["dependencies", "overrides"] {
        let Some(user_section) = user.get(section).and_then(Value::as_object) else { continue };
        let entry = object
            .entry(section.to_string())
            .or_insert_with(|| Value::Object(Default::default()));
        let Some(target) = entry.as_object_mut() else { continue };
        for (name, spec) in user_section {
            if !target.contains_key(name) {
                target.insert(name.clone(), spec.clone());
            }
        }
    }
    let user_bundles = user
        .get("dsh")
        .and_then(|dsh| dsh.get("profile"))
        .and_then(|profile| profile.get("bundles"))
        .and_then(Value::as_array);
    if let Some(user_bundles) = user_bundles {
        let mut bundles = seed
            .get("dsh")
            .and_then(|dsh| dsh.get("profile"))
            .and_then(|profile| profile.get("bundles"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for name in user_bundles {
            if !bundles.contains(name) {
                bundles.push(name.clone());
            }
        }
        let dsh = object
            .entry("dsh".to_string())
            .or_insert_with(|| Value::Object(Default::default()));
        if let Some(dsh) = dsh.as_object_mut() {
            let profile = dsh
                .entry("profile".to_string())
                .or_insert_with(|| Value::Object(Default::default()));
            if let Some(profile) = profile.as_object_mut() {
                profile.insert("bundles".to_string(), Value::Array(bundles));
            }
        }
    }
    out
}

/// 递归复制用户字节：覆盖同名发行文件、合并目录；链接与特殊文件跳过并记录。
fn copy_user_entry(
    source: &std::path::Path,
    destination: &std::path::Path,
    migration: &mut UserProfileMigration,
) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(source)
        .map_err(|e| format!("inspect {}: {e}", source.display()))?;
    if meta.file_type().is_symlink() {
        migration.skipped.push(format!("{}（链接，未迁移）", source.display()));
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(destination)
            .map_err(|e| format!("create {}: {e}", destination.display()))?;
        for entry in std::fs::read_dir(source)
            .map_err(|e| format!("read {}: {e}", source.display()))?
        {
            let entry = entry.map_err(|e| format!("read entry in {}: {e}", source.display()))?;
            copy_user_entry(&entry.path(), &destination.join(entry.file_name()), migration)?;
        }
        Ok(())
    } else if meta.is_file() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::copy(source, destination)
            .map_err(|e| format!("copy {} -> {}: {e}", source.display(), destination.display()))?;
        Ok(())
    } else {
        migration.skipped.push(source.display().to_string());
        Ok(())
    }
}

/// node_modules 里的包名（scoped 展开为 `@scope/name`）。
fn installed_package_names(root: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if name.starts_with('@') {
            if let Ok(children) = std::fs::read_dir(entry.path()) {
                for child in children.flatten() {
                    let child_name = child.file_name().to_string_lossy().to_string();
                    if !child_name.starts_with('.') {
                        out.push(format!("{name}/{child_name}"));
                    }
                }
            }
        } else {
            out.push(name);
        }
    }
    out
}

/// 用户自己装的包（发行包闭包里没有的）连同其 hoisted 依赖一起搬到新 profile：
/// manifest 里保留下来的用户依赖若指向不存在的目录，dsh 启动会失败。
fn migrate_user_packages(
    active_modules: &std::path::Path,
    candidate_modules: &std::path::Path,
    migration: &mut UserProfileMigration,
) -> Result<(), String> {
    if !active_modules.is_dir() {
        return Ok(());
    }
    for name in installed_package_names(active_modules) {
        let relative: PathBuf = name.split('/').collect();
        let destination = candidate_modules.join(&relative);
        if destination.exists() {
            continue; // 发行包闭包优先
        }
        let source = active_modules.join(&relative);
        if std::fs::symlink_metadata(&source)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            migration.skipped.push(format!("{name}（链接，未迁移）"));
            continue;
        }
        copy_user_entry(&source, &destination, migration)?;
        migration.packages.push(name);
    }
    Ok(())
}

/// 把旧 profile 的用户字节搬进候选 profile：除依赖产物外全部保留，manifest 合并。
fn migrate_user_profile(
    active: &std::path::Path,
    candidate: &std::path::Path,
) -> Result<UserProfileMigration, String> {
    ensure_plain_directory(active)?;
    ensure_plain_directory(candidate)?;
    let mut migration = UserProfileMigration::default();
    for entry in std::fs::read_dir(active).map_err(|e| format!("read {}: {e}", active.display()))? {
        let entry = entry.map_err(|e| format!("read entry in {}: {e}", active.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if PROFILE_DEPENDENCY_ARTIFACTS.contains(&name.as_str()) {
            continue;
        }
        let target = candidate.join(&name);
        if name == "package.json" {
            let user = read_profile_json(&entry.path());
            let seed = read_profile_json(&target);
            let merged = match (seed, user) {
                (Some(seed), Some(user)) if seed.is_object() => {
                    merge_profile_manifest(&seed, Some(&user))
                }
                (Some(seed), _) if seed.is_object() => seed,
                (_, Some(user)) => user,
                (Some(_), None) => {
                    // 发行包 manifest 不是对象：保留候选目录里的原文件。
                    migration.skipped.push("package.json（发行包 manifest 非对象，保留原文件）".to_string());
                    continue;
                }
                (None, None) => {
                    migration.skipped.push("package.json（无法解析，未迁移）".to_string());
                    continue;
                }
            };
            write_profile_json(&target, &merged)?;
            migration.files.push(name);
            continue;
        }
        copy_user_entry(&entry.path(), &target, &mut migration)?;
        migration.files.push(name);
    }
    migrate_user_packages(
        &active.join("node_modules"),
        &candidate.join("node_modules"),
        &mut migration,
    )?;
    Ok(migration)
}

/// 把被替换掉的用户设置复制到 dsh_home 下的隐藏快照目录（只保留最近一份）。
/// 健康提交会删除旧 profile 备份，但这份用户设置副本保留，供修剪后回退查看。
fn backup_user_settings(active: &std::path::Path, home: &std::path::Path) -> Result<String, String> {
    let destination = home.join(USER_SETTINGS_BACKUP_DIR);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let staging = home.join(format!("{USER_SETTINGS_BACKUP_DIR}-{}-{nonce}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("create {}: {e}", staging.display()))?;
    let mut snapshot = UserProfileMigration::default();
    let mut names: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(active).map_err(|e| format!("read {}: {e}", active.display()))? {
        let entry = entry.map_err(|e| format!("read entry in {}: {e}", active.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if PROFILE_DEPENDENCY_ARTIFACTS.contains(&name.as_str()) {
            continue;
        }
        copy_user_entry(&entry.path(), &staging.join(&name), &mut snapshot)?;
        names.push(name);
    }
    let manifest = serde_json::json!({
        "schema": 1,
        "profile": DESKTOP_PROFILE,
        "entries": names,
        "skipped": snapshot.skipped,
    });
    write_profile_json(&staging.join("manifest.json"), &manifest)?;
    if destination.exists() {
        ensure_plain_directory(&destination)?;
        let _ = std::fs::remove_dir_all(&destination);
    }
    std::fs::rename(&staging, &destination)
        .map_err(|e| format!("activate {} -> {}: {e}", staging.display(), destination.display()))?;
    Ok(USER_SETTINGS_BACKUP_DIR.to_string())
}

/// 只清理废弃的内部迁移标记；用户可见偏好（removedPlugins、pluginAutoUpdate、
/// legacySkinChoice）一律保留：升级程序不得覆盖用户设置。
fn clear_legacy_plugin_preferences(file: &std::path::Path) -> Result<(), String> {
    if !file.exists() {
        return Ok(());
    }
    let mut settings = crate::settings::load_at(file);
    let Some(object) = settings.as_object_mut() else { return Ok(()) };
    let mut changed = false;
    for key in ["shareWebProfile", "desktopProfileMigrated"] {
        changed |= object.remove(key).is_some();
    }
    if changed {
        crate::settings::save_at(file, &settings)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileSeedMarker {
    schema: u8,
    app_version: String,
    seed_fingerprint: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_name: Option<String>,
}

impl ProfileSeedMarker {
    fn pending(version: &str, fingerprint: &str, backup_name: Option<String>) -> Self {
        Self { schema: 1, app_version: version.into(), seed_fingerprint: fingerprint.into(),
            state: "pending-health".into(), backup_name }
    }

    fn committed(version: &str, fingerprint: &str, backup_name: Option<String>) -> Self {
        Self { schema: 1, app_version: version.into(), seed_fingerprint: fingerprint.into(),
            state: "committed".into(), backup_name }
    }
}

fn read_seed_marker(file: &std::path::Path) -> Result<Option<ProfileSeedMarker>, String> {
    match std::fs::read(file) {
        Ok(bytes) => {
            let marker: ProfileSeedMarker = serde_json::from_slice(&bytes)
                .map_err(|_| "profile seed marker is invalid".to_string())?;
            if marker.schema != 1
                || !matches!(marker.state.as_str(), "pending-health" | "committed")
                || marker.seed_fingerprint.len() != 16
                || marker.backup_name.as_deref().is_some_and(|name| {
                    name.contains(['/', '\\']) || !name.starts_with(&format!(".{DESKTOP_PROFILE}-aio-backup-"))
                })
            {
                return Err("profile seed marker is invalid".into());
            }
            Ok(Some(marker))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", file.display())),
    }
}

fn write_seed_marker(file: &std::path::Path, marker: &ProfileSeedMarker) -> Result<(), String> {
    let parent = file.parent().ok_or_else(|| "profile seed marker has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let temporary = parent.join(format!(".{PROFILE_SEED_MARKER}.tmp-{}", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes).map_err(|e| format!("write {}: {e}", temporary.display()))?;
    if file.exists() {
        std::fs::remove_file(file).map_err(|e| format!("replace {}: {e}", file.display()))?;
    }
    std::fs::rename(&temporary, file)
        .map_err(|e| format!("activate {} -> {}: {e}", temporary.display(), file.display()))
}

fn ensure_plain_directory(directory: &std::path::Path) -> Result<(), String> {
    let mut ancestors: Vec<_> = directory.ancestors().collect();
    ancestors.reverse();
    for entry in ancestors {
        match std::fs::symlink_metadata(entry) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("linked profile boundary rejected".into()),
            Ok(meta) if entry == directory && !meta.is_dir() => return Err("profile boundary is not a directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("inspect {}: {e}", entry.display())),
            _ => {}
        }
    }
    Ok(())
}

fn cleanup_profile_backup(home: &std::path::Path, backup_name: &str) -> Result<(), String> {
    let profiles = home.join("profiles");
    ensure_plain_directory(&profiles)?;
    let backup = profiles.join(backup_name);
    if backup.exists() {
        ensure_plain_directory(&backup)?;
        std::fs::remove_dir_all(&backup).map_err(|e| format!("remove {}: {e}", backup.display()))?;
    }
    Ok(())
}

fn rollback_pending_profile(home: &std::path::Path, backup_name: &str) -> Result<(), String> {
    let profiles = home.join("profiles");
    ensure_plain_directory(&profiles)?;
    let active = profiles.join(DESKTOP_PROFILE);
    let backup = profiles.join(backup_name);
    ensure_plain_directory(&backup)?;
    if active.exists() {
        ensure_plain_directory(&active)?;
        std::fs::remove_dir_all(&active).map_err(|e| format!("remove {}: {e}", active.display()))?;
    }
    std::fs::rename(&backup, &active)
        .map_err(|e| format!("restore {} -> {}: {e}", backup.display(), active.display()))
}

fn tree_fingerprint(root: &std::path::Path) -> Result<String, String> {
    fn mix(hash: &mut u64, bytes: &[u8]) {
        for byte in bytes {
            *hash ^= u64::from(*byte);
            *hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    fn walk(root: &std::path::Path, directory: &std::path::Path, hash: &mut u64) -> Result<(), String> {
        let mut entries = std::fs::read_dir(directory)
            .map_err(|e| format!("read {}: {e}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read entry in {}: {e}", directory.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file = entry.path();
            let relative = file.strip_prefix(root).map_err(|_| "profile seed path escaped root".to_string())?;
            mix(hash, relative.to_string_lossy().replace('\\', "/").as_bytes());
            let kind = entry.file_type().map_err(|e| format!("inspect {}: {e}", file.display()))?;
            if kind.is_symlink() {
                return Err("linked profile seed entry rejected".into());
            } else if kind.is_dir() {
                mix(hash, b"D");
                walk(root, &file, hash)?;
            } else if kind.is_file() {
                mix(hash, b"F");
                mix(hash, &std::fs::read(&file).map_err(|e| format!("read {}: {e}", file.display()))?);
            } else {
                return Err("unsupported profile seed entry".into());
            }
        }
        Ok(())
    }
    ensure_plain_directory(root)?;
    let mut hash = 0xcbf29ce484222325u64;
    walk(root, root, &mut hash)?;
    Ok(format!("{hash:016x}"))
}

fn copy_tree(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    ensure_plain_directory(source)?;
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("create {}: {e}", destination.display()))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("read {}: {e}", source.display()))? {
        let entry = entry.map_err(|e| format!("read entry in {}: {e}", source.display()))?;
        let src = entry.path();
        let dst = destination.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("inspect {}: {e}", src.display()))?;
        if kind.is_dir() {
            copy_tree(&src, &dst)?;
        } else if kind.is_file() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            std::fs::copy(&src, &dst)
                .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
        } else {
            return Err(format!("unsupported seed entry: {}", src.display()));
        }
    }
    Ok(())
}

/// 剥掉 Windows verbatim 前缀（\\?\ 与 \\?\UNC\）。
/// Tauri 的路径解析器会返回 verbatim 路径；Node 把以 \\?\ 开头的主入口
/// 参数解析失败（EISDIR lstat 'D:'），spawn 子进程前必须还原普通路径。
fn portable_data_dir(packaged: bool, resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    if !packaged {
        return None;
    }
    resource_dir
        .filter(|dir| dir.join(".dsh-portable").is_file())
        .map(|dir| dir.join(".dsh-aio-data"))
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dsh-{label}-{}-{nonce}", std::process::id()))
    }

    fn test_paths(root: &std::path::Path) -> Paths {
        let resources = root.join("resources");
        let app_root = resources.join("app");
        std::fs::create_dir_all(&app_root).unwrap();
        Paths {
            node_exe: resources.join("node/node.exe"),
            npm_cli: resources.join("npm/bin/npm-cli.js"),
            logs_dir: root.join("user-data/logs"),
            user_data: root.join("user-data"),
            dsh_home: root.join("home"),
            app_root,
            packaged: true,
            version: "1.2.0".into(),
        }
    }

    fn write_file(root: &std::path::Path, relative: &str, bytes: &[u8]) {
        let file = root.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }

    #[test]
    fn seed_does_not_overwrite_partial_home() {
        let root = test_root("upgrade-seed");
        std::fs::create_dir(&root).unwrap();
        assert!(seed_home_is_empty(&root).unwrap());
        std::fs::write(root.join("settings.yaml"), b"private: unchanged").unwrap();
        assert!(!seed_home_is_empty(&root).unwrap());
        assert_eq!(std::fs::read(root.join("settings.yaml")).unwrap(), b"private: unchanged");
        std::fs::remove_dir_all(root).unwrap();
    }

        #[test]
    fn existing_home_inherits_sessions_providers_and_user_profile_settings() {
        let root = test_root("clean-profile");
        let paths = test_paths(&root);
        let seed_home = root.join("resources/profile-seed");
        write_file(&seed_home, "settings.yaml", b"public-default: true\n");
        write_file(&seed_home, "profiles/web-desktop/package.json",
            br#"{"name":"new-profile","dependencies":{"new-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["new-plugin"]}}}"#);
        write_file(&seed_home, "profiles/web-desktop/cordis.yml", b"[]\n");
        write_file(&seed_home, "profiles/web-desktop/node_modules/new-plugin/index.js", b"new\n");
        write_file(&paths.dsh_home, "settings.yaml", b"provider: private\n");
        write_file(&paths.dsh_home, ".credentials.yaml", b"apiKey: synthetic\n");
        write_file(&paths.dsh_home, "sessions/a/events.jsonl", b"private session\n");
        write_file(&paths.dsh_home, "attachments/v1/a", &[0, 1, 255]);
        write_file(&paths.dsh_home, "profiles/web-desktop/package.json",
            br#"{"name":"old-profile","dependencies":{"old-plugin":"2.0.0"},"dsh":{"profile":{"bundles":["old-plugin","dsh-meme"]}}}"#);
        write_file(&paths.dsh_home, "profiles/web-desktop/cordis.yml", b"# user profile root\n[]\n");
        write_file(&paths.dsh_home, "profiles/web-desktop/cordis.patch.yml",
            b"- insert:\n    - id: old-plugin\n      name: 'old-plugin'\n");
        write_file(&paths.dsh_home, "profiles/web-desktop/node_modules/old-plugin/index.js", b"old\n");
        write_file(&paths.dsh_home, "profiles/web-desktop/node_modules/@scope/user-plugin/index.js", b"user\n");
        write_file(&paths.dsh_home, "plugin-artifact-cache/old-plugin/lib/index.js", b"old cache\n");
        write_file(&paths.user_data, "settings.json",
            br#"{"exitAction":"minimize","removedPlugins":["balance"],"pluginAutoUpdate":true,"shareWebProfile":true,"legacySkinChoice":"ui-skin-old"}"#);

        let report = paths.seed_distribution_profile().unwrap();
        assert!(report.changed);
        assert!(report.preserved_files >= 2, "package.json 与用户配置文件都要迁移");
        assert!(report.preserved_packages >= 2, "用户包（含 scoped）都要迁移");
        assert_eq!(report.preserved_backup.as_deref(), Some(USER_SETTINGS_BACKUP_DIR));

        // 根级用户数据照旧继承。
        assert_eq!(std::fs::read(paths.dsh_home.join("settings.yaml")).unwrap(), b"provider: private\n");
        assert_eq!(std::fs::read(paths.dsh_home.join(".credentials.yaml")).unwrap(), b"apiKey: synthetic\n");
        assert_eq!(std::fs::read(paths.dsh_home.join("sessions/a/events.jsonl")).unwrap(), b"private session\n");
        assert_eq!(std::fs::read(paths.dsh_home.join("attachments/v1/a")).unwrap(), [0, 1, 255]);

        // 用户可编辑的 profile 文件原样保留，不被发行包默认值覆盖。
        assert_eq!(
            std::fs::read(paths.dsh_home.join("profiles/web-desktop/cordis.patch.yml")).unwrap(),
            b"- insert:\n    - id: old-plugin\n      name: 'old-plugin'\n"
        );
        assert_eq!(
            std::fs::read(paths.dsh_home.join("profiles/web-desktop/cordis.yml")).unwrap(),
            b"# user profile root\n[]\n"
        );

        // manifest：发行包依赖为底，用户额外依赖与自选 bundles 保留。
        let manifest = read_profile_json(&paths.dsh_home.join("profiles/web-desktop/package.json")).unwrap();
        assert_eq!(manifest["name"].as_str(), Some("new-profile"));
        assert_eq!(manifest["dependencies"]["new-plugin"].as_str(), Some("1.0.0"));
        assert_eq!(manifest["dependencies"]["old-plugin"].as_str(), Some("2.0.0"));
        let bundles: Vec<&str> = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(bundles, vec!["new-plugin", "old-plugin", "dsh-meme"]);

        // 依赖闭包用发行包版本；用户自装的包不被丢弃。
        assert!(paths.dsh_home.join("profiles/web-desktop/node_modules/new-plugin/index.js").is_file());
        assert!(paths.dsh_home.join("profiles/web-desktop/node_modules/old-plugin/index.js").is_file());
        assert!(paths.dsh_home.join("profiles/web-desktop/node_modules/@scope/user-plugin/index.js").is_file());

        // 用户设置快照在健康提交后仍然保留。
        let snapshot = paths.dsh_home.join(USER_SETTINGS_BACKUP_DIR);
        assert!(snapshot.join("manifest.json").is_file());
        assert!(snapshot.join("cordis.patch.yml").is_file());
        assert!(snapshot.join("cordis.yml").is_file());
        assert!(snapshot.join("package.json").is_file());

        // 旧 profile 备份仍按原语义在健康提交后清理。
        let pending = read_seed_marker(&paths.dsh_home.join(PROFILE_SEED_MARKER)).unwrap().unwrap();
        assert_eq!(pending.state, "pending-health");
        let backup = paths.dsh_home.join("profiles").join(pending.backup_name.as_ref().unwrap());
        assert!(backup.join("node_modules/old-plugin/index.js").is_file());

        // 用户可见应用设置保留；只清理废弃的内部迁移标记。
        let app_settings = crate::settings::load_at(&paths.settings_file());
        assert_eq!(app_settings.get("exitAction").and_then(|v| v.as_str()), Some("minimize"));
        assert_eq!(
            app_settings.get("removedPlugins").and_then(|v| v.as_array()).map(|list| list.len()),
            Some(1)
        );
        assert_eq!(app_settings.get("pluginAutoUpdate").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(app_settings.get("legacySkinChoice").and_then(|v| v.as_str()), Some("ui-skin-old"));
        assert!(app_settings.get("shareWebProfile").is_none());

        assert!(paths.commit_distribution_profile_seed().unwrap());
        assert!(!backup.exists());
        assert!(snapshot.join("cordis.patch.yml").is_file());
        assert!(!paths.dsh_home.join("plugin-artifact-cache").exists());
        let committed = read_seed_marker(&paths.dsh_home.join(PROFILE_SEED_MARKER)).unwrap().unwrap();
        assert_eq!(committed.state, "committed");
        assert!(committed.backup_name.is_none());
        assert!(!paths.seed_distribution_profile().unwrap().changed);
        std::fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn interrupted_profile_seed_restores_old_profile_on_next_launch() {
        let root = test_root("profile-rollback");
        let paths = test_paths(&root);
        let seed_home = root.join("resources/profile-seed");
        write_file(&seed_home, "settings.yaml", b"public-default: true\n");
        write_file(&seed_home, "profiles/web-desktop/package.json", b"{\"name\":\"new-profile\"}\n");
        write_file(&paths.dsh_home, "settings.yaml", b"provider: private\n");
        write_file(&paths.dsh_home, "profiles/web-desktop/package.json", b"{\"name\":\"old-profile\"}\n");

        assert!(paths.seed_distribution_profile().unwrap().changed);
        assert!(paths.seed_distribution_profile().is_err());
        assert_eq!(std::fs::read(paths.dsh_home.join("profiles/web-desktop/package.json")).unwrap(),
            b"{\"name\":\"old-profile\"}\n");
        assert_eq!(std::fs::read(paths.dsh_home.join("settings.yaml")).unwrap(), b"provider: private\n");
        assert!(!paths.dsh_home.join(PROFILE_SEED_MARKER).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_home_receives_public_defaults_and_a_committed_marker() {
        let root = test_root("first-seed");
        let paths = test_paths(&root);
        let seed_home = root.join("resources/profile-seed");
        write_file(&seed_home, "settings.yaml", b"public-default: true\n");
        write_file(&seed_home, "profiles/web-desktop/package.json", b"{\"name\":\"new-profile\"}\n");

        assert!(paths.seed_distribution_profile().unwrap().changed);
        assert_eq!(std::fs::read(paths.dsh_home.join("settings.yaml")).unwrap(), b"public-default: true\n");
        let marker = read_seed_marker(&paths.dsh_home.join(PROFILE_SEED_MARKER)).unwrap().unwrap();
        assert_eq!(marker.state, "committed");
        assert!(marker.backup_name.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shared_profile_preference_cannot_redirect_aio_to_old_plugins() {
        let root = test_root("dedicated-profile");
        let paths = test_paths(&root);
        write_file(&paths.user_data, "settings.json", br#"{"shareWebProfile":true}"#);
        assert_eq!(paths.desktop_profile(), DESKTOP_PROFILE);
        assert_eq!(paths.desktop_profile_dir(), paths.dsh_home.join("profiles/web-desktop"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_marker_selects_sibling_data_root() {
        let root = test_root("aio-portable");
        let _ = std::fs::create_dir_all(&root);
        std::fs::write(root.join(".dsh-portable"), b"").unwrap();
        assert_eq!(portable_data_dir(true, Some(&root)), Some(root.join(".dsh-aio-data")));
        assert_eq!(portable_data_dir(false, Some(&root)), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
