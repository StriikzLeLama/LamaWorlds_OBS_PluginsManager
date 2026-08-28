//! LamaWorlds OBS Plugin Manager - Backend
//!
//! Handles OBS plugin discovery, installation, uninstallation, and configuration.
//! All file operations validate paths to prevent traversal attacks.

use directories::ProjectDirs;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use walkdir::WalkDir;

/// Serializes every operation that mutates the plugin folders.
///
/// Commands are dispatched with `#[tauri::command(async)]`, so two installs (the
/// drag-drop handler can start several at once) would otherwise extract into the
/// same target directory concurrently and clobber each other's files.
static PLUGIN_MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Runs blocking work on the runtime's blocking pool and awaits the result.
///
/// A `#[tauri::command(async)]` on a sync function runs its body inside a task on
/// a scheduler worker, which is an *entered* runtime context. That is fatal here:
/// `reqwest::blocking` builds its own tokio runtime, and dropping a runtime from
/// an async context panics with "Cannot drop a runtime in a context where
/// blocking is not allowed". `spawn_blocking` threads never enter the runtime,
/// so blocking - and that drop - is allowed there.
async fn run_blocking<T, F>(func: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(func).await {
        Ok(result) => result,
        Err(e) => Err(format!("Background task failed: {}", e)),
    }
}

/// Acquires the mutation lock, recovering the guard if a previous holder panicked.
fn lock_plugin_mutations() -> MutexGuard<'static, ()> {
    PLUGIN_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Application configuration (paths, preferences).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    pub custom_plugins_path: Option<String>,
    pub custom_obs_install_path: Option<String>,
    #[serde(default)]
    pub forum_favorites: Vec<String>,
    #[serde(default = "default_auto_backup")]
    pub auto_backup: bool,
    #[serde(default)]
    pub read_only: bool,
}

fn default_auto_backup() -> bool {
    true
}

/// Returns the path to the config file (config.json).
fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "lamaworlds", "plugin-manager")
        .map(|d| d.config_dir().join("config.json"))
}

/// Returns the config directory (for cache, logs).
fn config_dir() -> Option<PathBuf> {
    ProjectDirs::from("com", "lamaworlds", "plugin-manager").map(|d| d.config_dir().to_path_buf())
}

/// Path to the forum cache file for a given category.
fn forum_cache_path(category: &str) -> PathBuf {
    config_dir()
        .map(|d| d.join(format!("forum_cache_{}.json", category)))
        .unwrap_or_else(|| PathBuf::from("forum_cache.json"))
}

/// Append-only session log (`plugin-manager.log`) next to config.json.
fn log_file_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("plugin-manager.log"))
}

/// Loads config.json, or defaults if missing / unreadable.
fn load_config() -> AppConfig {
    let path = match config_path() {
        Some(p) if p.exists() => p,
        _ => return AppConfig::default(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist config.json (creates the config directory if needed).
fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path().ok_or("Could not determine config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// An installed OBS plugin (discovered from plugin folders).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsPluginInfo {
    pub name: String,
    pub path: String,
    /// Path to delete when uninstalling (plugin folder or single dll path for legacy)
    pub uninstall_path: String,
    pub enabled: bool,
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_time: Option<i64>,
    /// DLL stems this plugin ships. OBS identifies a module by its DLL stem, so
    /// these are the keys used to look the plugin up in OBS's own modules.json.
    #[serde(default)]
    pub module_names: Vec<String>,
    /// Enabled state as reported by OBS 32's plugin manager.
    /// `None` when OBS does not track it (OBS < 32, or a built-in module).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obs_enabled: Option<bool>,
    /// True when OBS lists this as a manageable module. Empirically OBS records
    /// only user-installed modules there, so a DLL sitting in obs-plugins/64bit
    /// without an entry is almost always one of OBS's own built-ins - which the
    /// user must not uninstall.
    #[serde(default)]
    pub obs_managed: bool,
    /// Friendly name OBS reports for the module, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obs_display_name: Option<String>,
    /// Bare DLL that OBS does not list as a module: either one of OBS's own
    /// built-ins (obs-ffmpeg, libcef, win-capture...) or a helper library owned
    /// by another plugin (advanced-scene-switcher-lib). Neither is a plugin the
    /// user should remove on its own, so the UI locks the destructive actions.
    ///
    /// Never set for folder plugins: a user plugin only reaches modules.json once
    /// OBS has loaded it, so a freshly installed one must not be flagged.
    #[serde(default)]
    pub support_dll: bool,
}

/// One entry of OBS 32's own plugin manager state file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsModuleInfo {
    pub module_name: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Detected and configured OBS installation paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsPaths {
    pub plugins_path: Option<String>,
    pub obs_install_path: Option<String>,
    pub appdata_plugins: Option<String>,
    pub custom_plugins_path: Option<String>,
    pub custom_obs_install_path: Option<String>,
}

/// A built-in catalog plugin (hardcoded popular plugins).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub download_url: String,
    pub version: Option<String>,
}

/// One plugin from the OBS forum (scraped).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForumPlugin {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Direct download URL (resource URL + /download).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<String>,
    /// Number of ratings, e.g. "1 ratings".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating_count: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Icon image URL (relative or full).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Resource prefix: Free, Non-Free, Semi-free, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// One download option (forum file or GitHub release asset).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadOption {
    pub label: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    /// "forum" or "github"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ForumCache {
    fetched_at: i64,
    plugins: Vec<ForumPlugin>,
}

const FORUM_CACHE_TTL_SECS: i64 = 20 * 60; // 20 minutes

/// Upper bound for a downloaded plugin archive, which is held in memory
/// before extraction. Real OBS plugin packages are a few MB to ~100 MB.
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// Shared User-Agent so the OBS forum / GitHub don't reject our requests.
const HTTP_USER_AGENT: &str = "LamaWorlds-OBS-PluginManager/1.0 (Desktop; OBS Plugin Manager)";

/// Builds a blocking HTTP client with a User-Agent and timeouts.
///
/// Without timeouts a stalled connection would block the worker thread (and the
/// install/refresh UI) indefinitely. `connect_timeout` bounds DNS/TCP setup while
/// `request_timeout_secs` bounds the whole exchange (use a larger value for big
/// plugin downloads, a small one for HTML/API scraping).
fn http_client(request_timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(request_timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

fn load_forum_cache(category: &str) -> Option<Vec<ForumPlugin>> {
    let path = forum_cache_path(category);
    let s = std::fs::read_to_string(&path).ok()?;
    let cache: ForumCache = serde_json::from_str(&s).ok()?;
    let now = chrono::Utc::now().timestamp();
    if now - cache.fetched_at < FORUM_CACHE_TTL_SECS {
        Some(cache.plugins)
    } else {
        None
    }
}

/// Save forum plugin list to cache (TTL 20 min).
fn save_forum_cache(category: &str, plugins: &[ForumPlugin]) {
    let path = forum_cache_path(category);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cache = ForumCache {
        fetched_at: chrono::Utc::now().timestamp(),
        plugins: plugins.to_vec(),
    };
    if let Ok(j) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(&path, j);
    }
}

/// Append a timestamped line to plugin-manager.log (best-effort, never panics).
fn log_action(message: &str) {
    if let Some(path) = log_file_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let line = format!(
            "{} {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            message
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Maps Windows ERROR_ACCESS_DENIED (5) to a hint about closing OBS / admin rights.
fn format_io_error(e: std::io::Error, context: &str) -> String {
    #[cfg(windows)]
    if e.raw_os_error() == Some(5) {
        return format!(
            "{context}: Access denied (OS error 5). Close OBS Studio completely, then retry. \
             If the plugin lives under Program Files, set a custom plugins folder in Options \
             or run the app as administrator."
        );
    }
    format!("{context}: {e}")
}

/// Blocks install/uninstall while OBS holds plugin DLLs open.
fn ensure_obs_not_running() -> Result<(), String> {
    if is_obs_running() {
        return Err(
            "OBS Studio is running. Close OBS completely before installing, updating, or removing plugins."
                .to_string(),
        );
    }
    Ok(())
}

/// Probe-write a temp file to know whether we can create a backup next to the plugin.
fn can_write_to_dir(dir: Option<&Path>) -> bool {
    let dir = match dir {
        Some(d) if d.exists() => d,
        _ => return false,
    };
    let test = dir.join(".lamaworlds_write_test");
    match std::fs::write(&test, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&test);
            true
        }
        Err(_) => false,
    }
}

/// Parent directory where a plugin package should be extracted (plugins/ or obs-plugins/).
fn find_plugins_dir_for_name(plugin_name: &str) -> Option<PathBuf> {
    for p in list_obs_plugins() {
        if !p.name.eq_ignore_ascii_case(plugin_name) {
            continue;
        }
        let path = Path::new(&p.uninstall_path);
        if path.is_dir() {
            return path.parent().map(|parent| parent.to_path_buf());
        }
        if let Some(parent) = path.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some("64bit") {
                if let Some(obs_plugins) = parent.parent() {
                    return Some(obs_plugins.to_path_buf());
                }
            }
            return Some(parent.to_path_buf());
        }
    }
    None
}

/// Removes every on-disk install matching `plugin_name`. Returns true if something was removed.
fn remove_installed_plugin_by_name(plugin_name: &str) -> Result<bool, String> {
    let mut was_update = false;
    for p in list_obs_plugins() {
        if !p.name.eq_ignore_ascii_case(plugin_name) {
            continue;
        }
        let path = Path::new(&p.uninstall_path);
        if !path.exists() {
            continue;
        }
        was_update = true;
        if load_config().auto_backup && path.is_dir() && can_write_to_dir(path.parent()) {
            let _ = backup_plugin_folder_inner(p.uninstall_path.clone());
        }
        if path.is_dir() {
            remove_dir_all_recursive(path)?;
        } else {
            std::fs::remove_file(path).map_err(|e| format_io_error(e, "remove plugin file"))?;
        }
    }
    Ok(was_update)
}

fn get_program_data_path() -> PathBuf {
    std::env::var("PROGRAMDATA")
        .unwrap_or_else(|_| "C:\\ProgramData".to_string())
        .into()
}

fn get_app_data_path() -> PathBuf {
    std::env::var("APPDATA")
        .unwrap_or_else(|_| "".to_string())
        .into()
}

/// Best-effort version from data/<name>.json, package.json, or manifest.json.
fn try_read_plugin_version(plugin_path: &Path, plugin_name: &str) -> Option<String> {
    let data_json = plugin_path.join("data").join(format!("{}.json", plugin_name));
    if data_json.exists() {
        if let Ok(s) = std::fs::read_to_string(&data_json) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                return v.get("version").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    let package_json = plugin_path.join("package.json");
    if package_json.exists() {
        if let Ok(s) = std::fs::read_to_string(&package_json) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                return v.get("version").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    let manifest = plugin_path.join("manifest.json");
    if manifest.exists() {
        if let Ok(s) = std::fs::read_to_string(&manifest) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                return v.get("version").and_then(|v| v.as_str()).map(String::from);
            }
        }
    }
    None
}

fn get_modified_time(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
}

/// Root of OBS Studio's own configuration directory.
///
/// A portable install keeps it next to the executable in `config/obs-studio`;
/// a normal install uses `%APPDATA%/obs-studio`.
fn obs_config_dir() -> Option<PathBuf> {
    let paths = get_obs_paths();
    for obs in [
        paths.custom_obs_install_path.as_deref(),
        paths.obs_install_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let portable = Path::new(obs).join("config").join("obs-studio");
        if portable.is_dir() {
            return Some(portable);
        }
    }
    let app_data = get_app_data_path();
    let standard = app_data.join("obs-studio");
    standard.is_dir().then_some(standard)
}

/// Path to OBS 32's plugin manager state file.
fn obs_modules_json_path() -> Option<PathBuf> {
    obs_config_dir().map(|d| d.join("plugin_manager").join("modules.json"))
}

/// Reads OBS's module list. Returns an empty vec when the file is absent,
/// which is the normal case on OBS releases older than 32.
fn load_obs_modules() -> Vec<ObsModuleInfo> {
    let path = match obs_modules_json_path() {
        Some(p) if p.is_file() => p,
        _ => return Vec::new(),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<ObsModuleInfo>>(&raw).unwrap_or_default()
}

/// The DLL stems a plugin provides, i.e. the names OBS uses to identify modules.
///
/// A folder plugin can ship several DLLs (a main module plus helper libraries);
/// only those OBS actually lists as modules end up matching.
fn module_names_for(path: &Path) -> Vec<String> {
    if path.is_file() {
        let stem = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim_end_matches(".disabled"))
            .and_then(|n| n.strip_suffix(".dll"))
            .unwrap_or_default();
        return if stem.is_empty() {
            Vec::new()
        } else {
            vec![stem.to_string()]
        };
    }
    let bin_64 = path.join("bin").join("64bit");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&bin_64).into_iter().flatten().flatten() {
        let file = entry.path();
        if file.extension().is_some_and(|ext| ext == "dll") {
            if let Some(stem) = file.file_stem().and_then(|s| s.to_str()) {
                names.push(stem.to_string());
            }
        }
    }
    names
}

/// Annotates plugins with the state OBS itself reports for their modules.
fn annotate_with_obs_modules(plugins: &mut [ObsPluginInfo]) {
    apply_module_states(plugins, &load_obs_modules());
}

/// Pure matching step of [`annotate_with_obs_modules`].
fn apply_module_states(plugins: &mut [ObsPluginInfo], modules: &[ObsModuleInfo]) {
    if modules.is_empty() {
        return;
    }
    let by_name: HashMap<&str, &ObsModuleInfo> = modules
        .iter()
        .map(|m| (m.module_name.as_str(), m))
        .collect();
    for plugin in plugins.iter_mut() {
        let matched: Vec<&&ObsModuleInfo> = plugin
            .module_names
            .iter()
            .filter_map(|n| by_name.get(n.as_str()))
            .collect();
        if matched.is_empty() {
            continue;
        }
        plugin.obs_managed = true;
        // A plugin counts as enabled for OBS only if every module it ships is.
        plugin.obs_enabled = Some(matched.iter().all(|m| m.enabled));
        plugin.obs_display_name = matched
            .iter()
            .find_map(|m| m.display_name.clone().filter(|s| !s.is_empty()));
    }

    for plugin in plugins.iter_mut() {
        let is_bare_dll = plugin
            .uninstall_path
            .trim_end_matches(".disabled")
            .to_ascii_lowercase()
            .ends_with(".dll");
        plugin.support_dll = is_bare_dll && !plugin.obs_managed;
    }
}

/// Returns detected and configured OBS paths (plugins, install, AppData).
#[tauri::command(async)]
fn get_obs_paths() -> ObsPaths {
    let config = load_config();
    let program_data = get_program_data_path();
    let app_data = get_app_data_path();

    let plugins_path = program_data.join("obs-studio").join("plugins");
    let obs_install = PathBuf::from("C:\\Program Files\\obs-studio");
    let appdata_plugins = app_data.join("obs-studio").join("plugins");

    ObsPaths {
        plugins_path: plugins_path.exists().then(|| plugins_path.to_string_lossy().to_string()),
        obs_install_path: obs_install.exists().then(|| obs_install.to_string_lossy().to_string()),
        appdata_plugins: appdata_plugins
            .exists()
            .then(|| appdata_plugins.to_string_lossy().to_string()),
        custom_plugins_path: config.custom_plugins_path,
        custom_obs_install_path: config.custom_obs_install_path,
    }
}

/// Returns the current application configuration.
#[tauri::command(async)]
fn get_config() -> AppConfig {
    load_config()
}

/// Saves the application configuration.
#[tauri::command(async)]
fn set_config(config: AppConfig) -> Result<(), String> {
    save_config(&config)
}

/// Validates that a path exists and is a directory. Empty path returns true (no path set).
#[tauri::command(async)]
fn validate_path(path: String) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Ok(true);
    }
    let p = Path::new(path.trim());
    Ok(p.exists() && p.is_dir())
}

/// Ensures the given path is under the base directory (prevents path traversal).
fn path_under_base(path: &Path, base: &Path) -> bool {
    path.canonicalize()
        .and_then(|p| base.canonicalize().map(|b| p.starts_with(b)))
        .unwrap_or(false)
}

/// Install target: custom path, then ProgramData, AppData, then OBS/data/plugins.
fn get_target_plugins_dir() -> Result<PathBuf, String> {
    let paths = get_obs_paths();
    // 1. Custom plugins path (user-configured)
    if let Some(ref p) = paths.custom_plugins_path {
        return Ok(PathBuf::from(p));
    }
    // 2. Standard OBS plugin folders (when they exist)
    if let Some(ref p) = paths.plugins_path {
        return Ok(PathBuf::from(p));
    }
    if let Some(ref p) = paths.appdata_plugins {
        return Ok(PathBuf::from(p));
    }
    // 3. Derive from OBS installation folder (data/plugins, used by portable OBS)
    if let Some(ref obs) = paths.custom_obs_install_path {
        let plugins = PathBuf::from(obs).join("data").join("plugins");
        return Ok(plugins);
    }
    // 4. Fallback: default OBS install (portable mode)
    if let Some(ref obs) = paths.obs_install_path {
        let plugins = PathBuf::from(obs).join("data").join("plugins");
        return Ok(plugins);
    }
    // 5. AppData even if folder doesn't exist yet (we'll create it)
    let app_data = get_app_data_path();
    let appdata_plugins = app_data.join("obs-studio").join("plugins");
    Ok(appdata_plugins)
}

/// Returns true if the path is under one of the configured OBS plugin directories.
fn is_path_in_plugin_dirs(path: &Path) -> bool {
    let paths = get_obs_paths();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in [
        paths.custom_plugins_path.as_deref(),
        paths.plugins_path.as_deref(),
        paths.appdata_plugins.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        dirs.push(PathBuf::from(p));
    }
    if let Some(ref obs) = paths.custom_obs_install_path {
        dirs.push(PathBuf::from(obs).join("data").join("plugins"));
        dirs.push(PathBuf::from(obs).join("obs-plugins"));
    }
    if let Some(ref obs) = paths.obs_install_path {
        dirs.push(PathBuf::from(obs).join("data").join("plugins"));
        dirs.push(PathBuf::from(obs).join("obs-plugins"));
    }
    let app_data = get_app_data_path();
    dirs.push(app_data.join("obs-studio").join("plugins"));
    dirs.into_iter()
        .any(|base| path_under_base(path, &base))
}

/// Scan a `plugins/` tree: each folder with `bin/64bit/*.dll` is one plugin.
/// Folders ending in `.disabled` are listed as disabled.
fn find_plugins_in_directory(path: &Path) -> Vec<ObsPluginInfo> {
    let mut plugins = Vec::new();

    if !path.exists() {
        return plugins;
    }

    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            let raw_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if raw_name.is_empty() || raw_name == "64bit" {
                continue;
            }
            let (plugin_name, enabled) = if raw_name.ends_with(".disabled") {
                let name = raw_name.strip_suffix(".disabled").unwrap_or(&raw_name).to_string();
                (name, false)
            } else {
                (raw_name.clone(), true)
            };
            let bin_64 = entry_path.join("bin").join("64bit");
            if bin_64.exists() {
                let has_dll = std::fs::read_dir(&bin_64)
                    .map(|d| {
                        d.filter_map(|e| e.ok()).any(|e| {
                            e.path().extension().is_some_and(|ext| ext == "dll")
                        })
                    })
                    .unwrap_or(false);
                if has_dll {
                    let version = try_read_plugin_version(&entry_path, &plugin_name);
                    let modified_time = get_modified_time(&entry_path);
                    let module_names = module_names_for(&entry_path);
                    plugins.push(ObsPluginInfo {
                        name: plugin_name,
                        path: entry_path.to_string_lossy().to_string(),
                        uninstall_path: entry_path.to_string_lossy().to_string(),
                        enabled,
                        version,
                        modified_time,
                        module_names,
                        obs_enabled: None,
                        obs_managed: false,
                        obs_display_name: None,
                        support_dll: false,
                    });
                }
            }
        }
    }

    plugins
}

/// Scan legacy `obs-plugins/64bit/*.dll` (and `*.dll.disabled`).
fn find_plugins_in_obs_plugins(path: &Path) -> Vec<ObsPluginInfo> {
    let mut plugins = Vec::new();
    let bin_64 = path.join("64bit");
    if !bin_64.exists() {
        return plugins;
    }
    for entry in std::fs::read_dir(&bin_64).into_iter().flatten().flatten() {
        let entry_path = entry.path();
        let fname = entry_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let (enabled, plugin_name) = if fname.ends_with(".dll.disabled") {
            (false, fname.strip_suffix(".dll.disabled").unwrap_or(fname).to_string())
        } else if entry_path.extension().is_some_and(|ext| ext == "dll") {
            (true, entry_path.file_stem().and_then(|n| n.to_str()).unwrap_or("").to_string())
        } else {
            continue;
        };
        if !plugin_name.is_empty() {
            let modified_time = get_modified_time(&entry_path);
            let module_names = module_names_for(&entry_path);
            plugins.push(ObsPluginInfo {
                name: plugin_name,
                path: bin_64.to_string_lossy().to_string(),
                uninstall_path: entry_path.to_string_lossy().to_string(),
                enabled,
                version: None,
                modified_time,
                module_names,
                obs_enabled: None,
                obs_managed: false,
                obs_display_name: None,
                support_dll: false,
            });
        }
    }
    plugins
}

/// Scans configured OBS plugin folders and returns all installed plugins (including disabled .dll.disabled).
#[tauri::command(async)]
fn list_obs_plugins() -> Vec<ObsPluginInfo> {
    let mut all_plugins = Vec::new();
    let mut seen_names = std::collections::HashSet::new();
    let paths = get_obs_paths();

    // Clone the OBS install paths so they can be used both for data/plugins and obs-plugins
    let custom_obs = paths.custom_obs_install_path.clone();
    let obs_install = paths.obs_install_path.clone();

    let mut plugin_paths: Vec<Option<String>> = vec![
        paths.custom_plugins_path,
        paths.plugins_path,
        paths.appdata_plugins,
    ];
    for obs in [custom_obs.as_deref(), obs_install.as_deref()].into_iter().flatten() {
        plugin_paths.push(Some(Path::new(obs).join("data").join("plugins").to_string_lossy().to_string()));
    }

    for path_str in plugin_paths.into_iter().flatten() {
        let path = Path::new(&path_str);
        for plugin in find_plugins_in_directory(path) {
            if seen_names.insert(plugin.name.clone()) {
                all_plugins.push(plugin);
            }
        }
    }

    let obs_paths: Vec<Option<String>> = vec![
        custom_obs,
        obs_install,
    ];
    for obs_path in obs_paths.into_iter().flatten() {
        let obs_plugins = Path::new(&obs_path).join("obs-plugins");
        for plugin in find_plugins_in_obs_plugins(&obs_plugins) {
            if seen_names.insert(plugin.name.clone()) {
                all_plugins.push(plugin);
            }
        }
    }

    annotate_with_obs_modules(&mut all_plugins);
    all_plugins.sort_by_key(|a| a.name.to_lowercase());
    all_plugins
}

fn remove_dir_all_recursive(p: &Path) -> Result<(), String> {
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format_io_error(e, "remove plugin folder"))
    } else if p.exists() {
        std::fs::remove_file(p).map_err(|e| format_io_error(e, "remove plugin file"))
    } else {
        Ok(())
    }
}

/// Windows: `tasklist` for obs64/obs32/obs.exe. Other OS: always false.
#[tauri::command(async)]
fn is_obs_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        // CREATE_NO_WINDOW: without it every poll flashes a console window in a
        // release build (windows_subsystem = "windows"), and this runs on every refresh.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("tasklist")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok();
        if let Some(ok) = output {
            let stdout = String::from_utf8_lossy(&ok.stdout).to_lowercase();
            ["obs64.exe", "obs32.exe", "obs.exe"]
                .iter()
                .any(|proc| stdout.contains(proc))
        } else {
            false
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Zip every file under `src` into `zip_path`.
/// Stored (no deflate): plugin binaries barely compress and backups stay fast.
fn zip_directory(src: &Path, zip_path: &Path) -> Result<(), String> {
    let file = File::create(zip_path).map_err(|e| e.to_string())?;
    let mut zip_writer = zip::ZipWriter::new(BufWriter::new(file));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    for entry in WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name_in_zip = path.strip_prefix(src).unwrap_or(path);
        let name_str = name_in_zip.to_string_lossy().replace('\\', "/");
        zip_writer
            .start_file(&name_str, options)
            .map_err(|e| e.to_string())?;
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut zip_writer).map_err(|e| e.to_string())?;
    }
    zip_writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Backup a single plugin folder next to it (`<name>-backup.zip`).
///
/// Lock-free: callers that already hold [`lock_plugin_mutations`] use this directly.
fn backup_plugin_folder_inner(plugin_path: String) -> Result<String, String> {
    let src = Path::new(&plugin_path);
    if !src.exists() || !src.is_dir() {
        return Err("Plugin folder not found.".to_string());
    }
    if !is_path_in_plugin_dirs(src) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("plugin");
    let parent = src.parent().ok_or("Invalid path.")?;
    let zip_path = parent.join(format!("{}-backup.zip", name));
    zip_directory(src, &zip_path)?;
    Ok(zip_path.to_string_lossy().to_string())
}

/// Backup a single plugin folder next to it (`<name>-backup.zip`).
#[tauri::command]
async fn backup_plugin_folder(plugin_path: String) -> Result<String, String> {
    run_blocking(move || backup_plugin_folder_sync(plugin_path)).await
}

fn backup_plugin_folder_sync(plugin_path: String) -> Result<String, String> {
    let _guard = lock_plugin_mutations();
    backup_plugin_folder_inner(plugin_path)
}

/// Backup the entire plugins folder (`obs-plugins-backup-<timestamp>.zip`).
#[tauri::command]
async fn backup_all_plugins() -> Result<String, String> {
    run_blocking(backup_all_plugins_sync).await
}

fn backup_all_plugins_sync() -> Result<String, String> {
    let _guard = lock_plugin_mutations();
    let plugins_dir = get_target_plugins_dir()?;
    if !plugins_dir.exists() || !plugins_dir.is_dir() {
        return Err("Plugins folder not found.".to_string());
    }
    let parent = plugins_dir.parent().ok_or("Invalid plugins path.")?;
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let zip_path = parent.join(format!("obs-plugins-backup-{}.zip", ts));
    zip_directory(&plugins_dir, &zip_path)?;
    log_action(&format!("Backup all: {}", zip_path.display()));
    Ok(zip_path.to_string_lossy().to_string())
}

/// Uninstalls a plugin (removes folder or .dll). Creates backup if auto_backup is enabled.
#[tauri::command]
async fn uninstall_plugin(uninstall_path: String) -> Result<(), String> {
    run_blocking(move || uninstall_plugin_sync(uninstall_path)).await
}

fn uninstall_plugin_sync(uninstall_path: String) -> Result<(), String> {
    let _guard = lock_plugin_mutations();
    if load_config().read_only {
        return Err("Read-only mode: uninstall disabled.".to_string());
    }
    ensure_obs_not_running()?;
    let path = Path::new(&uninstall_path);
    if !path.exists() {
        return Err(format!("File or folder does not exist: {}", uninstall_path));
    }
    if !is_path_in_plugin_dirs(path) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if load_config().auto_backup && path.is_dir() {
        let _ = backup_plugin_folder_inner(uninstall_path.clone());
    }
    log_action(&format!("Uninstall: {}", name));
    if path.is_dir() {
        remove_dir_all_recursive(path)
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

/// JSON dump of config + detected paths + installed plugins (for backup/restore).
#[tauri::command(async)]
fn export_config_json() -> Result<String, String> {
    let config = load_config();
    let paths = get_obs_paths();
    let plugins = list_obs_plugins();
    #[derive(Serialize)]
    struct Export {
        config: AppConfig,
        paths: ObsPaths,
        plugins: Vec<ObsPluginInfo>,
        exported_at: String,
    }
    let export = Export {
        config,
        paths,
        plugins,
        exported_at: chrono::Utc::now().to_rfc3339(),
    };
    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

/// Writes a file. Path is user-chosen via save dialog; no server-side validation.
#[tauri::command(async)]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Reads a file. Path is user-chosen via open dialog; no server-side validation.
#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn export_plugins_list_json() -> Result<String, String> {
    let plugins = list_obs_plugins();
    #[derive(Serialize)]
    struct Row {
        name: String,
        path: String,
        version: Option<String>,
        enabled: bool,
    }
    let rows: Vec<Row> = plugins
        .into_iter()
        .map(|p| Row {
            name: p.name,
            path: p.path,
            version: p.version,
            enabled: p.enabled,
        })
        .collect();
    serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn export_plugins_list_csv() -> Result<String, String> {
    let plugins = list_obs_plugins();
    let mut csv = String::from("name,path,version,enabled\n");
    // Every field is quoted, so every embedded quote must be doubled - a plugin
    // name or version containing `"` would otherwise break the row structure.
    fn csv_field(value: &str) -> String {
        value.replace('"', "\"\"")
    }
    for p in &plugins {
        let enabled = if p.enabled { "yes" } else { "no" };
        let row = format!(
            "\"{}\",\"{}\",\"{}\",\"{}\"",
            csv_field(&p.name),
            csv_field(&p.path),
            csv_field(p.version.as_deref().unwrap_or("")),
            enabled
        );
        csv.push_str(&row);
        csv.push('\n');
    }
    Ok(csv)
}

#[tauri::command]
fn get_config_dir() -> Option<String> {
    config_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn open_log_folder() -> Result<(), String> {
    let dir = config_dir().ok_or("Config directory not found")?;
    open::that(&dir).map_err(|e| e.to_string())
}

/// Returns plugin-manager.log, creating an empty file if it does not exist yet.
#[tauri::command(async)]
fn read_log_file() -> Result<String, String> {
    let path = log_file_path().ok_or("Log file path not found")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !path.exists() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn open_downloads_folder() -> Result<(), String> {
    let downloads = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(|h| format!("{}/Downloads", h.trim_end_matches('/')))
        .map_err(|_| "Could not find Downloads folder")?;
    let path = Path::new(&downloads);
    if path.exists() {
        open::that(&downloads).map_err(|e| e.to_string())
    } else {
        open::that(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "No home dir")?)
            .map_err(|e| e.to_string())
    }
}

/// Fetch one forum page to verify network / scraping still works.
#[tauri::command]
async fn test_forum_connection() -> Result<serde_json::Value, String> {
    run_blocking(test_forum_connection_sync).await
}

fn test_forum_connection_sync() -> Result<serde_json::Value, String> {
    match fetch_forum_plugins_impl("plugins", true, 1) {
        Ok(plugins) => Ok(serde_json::json!({ "count": plugins.len(), "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// True if the target plugins folder exists, or its parent does (we can create it).
#[tauri::command(async)]
fn check_paths_valid() -> Result<bool, String> {
    let target = match get_target_plugins_dir() {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    if target.exists() {
        return Ok(true);
    }
    // Folder may not exist yet; valid if parent exists (we can create it)
    target.parent().map_or(Ok(false), |p| Ok(p.exists()))
}

/// Disables a plugin by renaming .dll to .dll.disabled (or folder to folder.disabled).
#[tauri::command(async)]
fn disable_plugin(plugin_path: String) -> Result<(), String> {
    let _guard = lock_plugin_mutations();
    if load_config().read_only {
        return Err("Read-only mode: disable disabled.".to_string());
    }
    let path = Path::new(&plugin_path);
    if !path.exists() {
        return Err("Path does not exist.".to_string());
    }
    if !is_path_in_plugin_dirs(path) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".disabled") {
        return Err("Plugin is already disabled.".to_string());
    }
    let parent = path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(format!("{}.disabled", name));
    if new_path.exists() {
        return Err("A .disabled item already exists.".to_string());
    }
    std::fs::rename(path, &new_path).map_err(|e| e.to_string())
}

/// Re-enables a disabled plugin by removing the .disabled suffix.
#[tauri::command(async)]
fn enable_plugin(plugin_path: String) -> Result<(), String> {
    let _guard = lock_plugin_mutations();
    if load_config().read_only {
        return Err("Read-only mode: enable disabled.".to_string());
    }
    let path = Path::new(&plugin_path);
    if !path.exists() {
        return Err("Invalid path.".to_string());
    }
    if !is_path_in_plugin_dirs(path) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let base = name.strip_suffix(".disabled").ok_or("Plugin is not disabled.")?;
    let parent = path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(base);
    if new_path.exists() {
        return Err("An active plugin with this name already exists.".to_string());
    }
    std::fs::rename(path, &new_path).map_err(|e| e.to_string())
}

/// Extracts zip bytes to target_dir, handling obs-plugins/ and data/ structure.
/// Returns (primary_plugin_name, was_update).
fn extract_zip_to_obs(
    mut archive: zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
) -> Result<(String, bool), String> {
    ensure_obs_not_running()?;

    let mut roots: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut plugin_subdirs: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let p = Path::new(&name);
        if p.is_absolute()
            || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let parts: Vec<&str> = p
            .components()
            .map(|c| c.as_os_str().to_str().unwrap_or(""))
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(root) = parts.first() {
            roots.insert((*root).to_string());
            if *root == "obs-plugins" && parts.len() >= 2 {
                let sub = parts[1].to_string();
                if sub != "64bit" && !plugin_subdirs.contains(&sub) {
                    plugin_subdirs.push(sub);
                }
            }
        }
    }

    let has_obs_plugins = roots.contains("obs-plugins");
    let has_data = roots.contains("data");

    if has_data && !has_obs_plugins && roots.len() == 1 {
        return Err("ZIP contains only 'data/' folder. Use a full OBS plugin package.".to_string());
    }

    let first_plugin = if has_obs_plugins && !plugin_subdirs.is_empty() {
        plugin_subdirs.first().cloned()
    } else {
        roots.iter().find(|r| *r != "data" && *r != "bin").cloned()
    };
    let name = first_plugin
        .clone()
        .unwrap_or_else(|| "plugin".to_string());

    let target_dir = match find_plugins_dir_for_name(&name) {
        Some(dir) => dir,
        None => get_target_plugins_dir()?,
    };
    let data_dir_opt = target_dir.parent().map(|p| p.join("data"));

    let mut was_update = remove_installed_plugin_by_name(&name)?;

    // Also remove package folder names from the zip when they differ from the plugin id.
    let to_remove: Vec<String> = if has_obs_plugins {
        plugin_subdirs
    } else if name != "bin" {
        vec![name.clone()]
    } else {
        Vec::new()
    };

    for plugin_name in &to_remove {
        let dest_plugin = target_dir.join(plugin_name);
        if dest_plugin.exists() {
            was_update = true;
            if load_config().auto_backup && dest_plugin.is_dir() && can_write_to_dir(dest_plugin.parent()) {
                let _ = backup_plugin_folder_inner(dest_plugin.to_string_lossy().to_string());
            }
            if dest_plugin.is_dir() {
                remove_dir_all_recursive(&dest_plugin)?;
            } else {
                std::fs::remove_file(&dest_plugin).map_err(|e| format_io_error(e, "remove old plugin"))?;
            }
        }
    }

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = file.name().to_string();
        if entry_name.ends_with('/') {
            continue;
        }
        let p = Path::new(&entry_name);
        if p.is_absolute()
            || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let out_path = if entry_name.starts_with("data/") {
            if let Some(ref data_dir) = data_dir_opt {
                data_dir.join(entry_name.trim_start_matches("data/"))
            } else {
                continue;
            }
        } else if has_obs_plugins && entry_name.starts_with("obs-plugins/") {
            target_dir.join(entry_name.trim_start_matches("obs-plugins/"))
        } else if !has_obs_plugins {
            target_dir.join(&entry_name)
        } else {
            continue;
        };
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format_io_error(e, "create plugin folder"))?;
        }
        if file.is_file() {
            let mut out_file =
                File::create(&out_path).map_err(|e| format_io_error(e, "write plugin file"))?;
            std::io::copy(&mut file, &mut out_file).map_err(|e| format_io_error(e, "extract plugin file"))?;
        }
    }

    Ok((name, was_update))
}

/// Downloads a plugin ZIP from URL and extracts it to the OBS plugins folder.
#[tauri::command]
async fn install_plugin_from_url(url: String) -> Result<InstallFromPathResult, String> {
    run_blocking(move || install_plugin_from_url_sync(url)).await
}

fn install_plugin_from_url_sync(url: String) -> Result<InstallFromPathResult, String> {
    if load_config().read_only {
        return Err("Read-only mode: install disabled.".to_string());
    }

    let result = (|| -> Result<InstallFromPathResult, String> {
        // Plugin archives can be tens of MB, so allow a generous request timeout.
        let client = http_client(300)?;

        let response = client
            .get(&url)
            .send()
            .map_err(|e| format!("Download error: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Download failed (code {})", response.status()));
        }

        // The archive is buffered in memory before extraction, so a mistyped URL
        // pointing at a huge file would otherwise take the whole app down with it.
        if let Some(len) = response.content_length() {
            if len > MAX_DOWNLOAD_BYTES {
                return Err(format!(
                    "Download refused: {} exceeds the {} MB limit for a plugin archive.",
                    format_size(len),
                    MAX_DOWNLOAD_BYTES / (1024 * 1024)
                ));
            }
        }

        let bytes = response.bytes().map_err(|e| e.to_string())?.to_vec();
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Download refused: {} exceeds the {} MB limit for a plugin archive.",
                format_size(bytes.len() as u64),
                MAX_DOWNLOAD_BYTES / (1024 * 1024)
            ));
        }
        let cursor = std::io::Cursor::new(bytes);
        let archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid ZIP: {}", e))?;

        // Held for extraction only: the download above must not block other mutations.
        let _guard = lock_plugin_mutations();
        let (name, was_update) = extract_zip_to_obs(archive)?;
        log_action(&format!(
            "{} from URL: {} -> {}",
            if was_update { "Updated" } else { "Installed" },
            url,
            name
        ));
        Ok(InstallFromPathResult {
            name,
            updated: was_update,
        })
    })();

    if let Err(ref err) = result {
        log_action(&format!("ERROR install from URL: {} -> {}", url, err));
    }
    result
}

/// Result of install/update from file.
#[derive(Serialize)]
struct InstallFromPathResult {
    name: String,
    updated: bool,
}

/// Installs or updates a plugin from a local file path (.zip, .dll) or folder.
/// For zip: if plugin exists, removes old version (with optional backup) then extracts.
#[tauri::command]
async fn install_plugin_from_path(path: String) -> Result<InstallFromPathResult, String> {
    run_blocking(move || install_plugin_from_path_sync(path)).await
}

fn install_plugin_from_path_sync(path: String) -> Result<InstallFromPathResult, String> {
    let _guard = lock_plugin_mutations();
    if load_config().read_only {
        return Err("Read-only mode: install disabled.".to_string());
    }
    let target_dir = get_target_plugins_dir()?;
    let src = Path::new(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    if src.is_file() {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "zip" {
            let bytes = std::fs::read(src).map_err(|e| e.to_string())?;
            let cursor = std::io::Cursor::new(bytes);
            let archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid ZIP: {}", e))?;
            let (name, was_update) = extract_zip_to_obs(archive)?;
            log_action(&format!(
                "{} from file: {} -> {}",
                if was_update { "Updated" } else { "Installed" },
                path,
                name
            ));
            return Ok(InstallFromPathResult {
                name: name.clone(),
                updated: was_update,
            });
        }
        if ext == "dll" {
            ensure_obs_not_running()?;
            let file_name = src
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid DLL file name.")?
                .to_string();
            let name = src
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("plugin")
                .to_string();
            // OBS loads a bare DLL only from `<plugins>/<name>/bin/64bit/`. Copying it
            // into `<plugins>/64bit/` leaves it invisible both to OBS and to the scanner
            // in `find_plugins_in_directory`, which skips a folder named `64bit`.
            let plugin_root = target_dir.join(&name);
            let dest_dir = plugin_root.join("bin").join("64bit");
            let updated = plugin_root.exists();
            if updated && load_config().auto_backup && can_write_to_dir(plugin_root.parent()) {
                let _ = backup_plugin_folder_inner(plugin_root.to_string_lossy().to_string());
            }
            std::fs::create_dir_all(&dest_dir)
                .map_err(|e| format_io_error(e, "create plugin folder"))?;
            std::fs::copy(src, dest_dir.join(&file_name))
                .map_err(|e| format_io_error(e, "copy plugin DLL"))?;
            log_action(&format!(
                "{} DLL from file: {} -> {}",
                if updated { "Updated" } else { "Installed" },
                path,
                name
            ));
            return Ok(InstallFromPathResult { name, updated });
        }
        return Err("Unsupported file type. Use .zip or .dll".to_string());
    }

    if src.is_dir() {
        ensure_obs_not_running()?;
        let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("plugin").to_string();
        let dest = target_dir.join(&name);
        let updated = dest.exists();
        if updated {
            if load_config().auto_backup && can_write_to_dir(dest.parent()) {
                let _ = backup_plugin_folder_inner(dest.to_string_lossy().to_string());
            }
            std::fs::remove_dir_all(&dest).map_err(|e| format_io_error(e, "remove old plugin"))?;
        }
        copy_dir_all(src, &dest)?;
        log_action(&format!(
            "{} folder from: {} -> {}",
            if updated { "Updated" } else { "Installed" },
            path,
            name
        ));
        return Ok(InstallFromPathResult { name, updated });
    }

    Err("Unsupported path.".to_string())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

const OBS_FORUM_PLUGINS_URL: &str = "https://obsproject.com/forum/plugins/";
const OBS_FORUM_THEMES_URL: &str = "https://obsproject.com/forum/resources/categories/themes.10/";
const OBS_FORUM_TOOLS_URL: &str = "https://obsproject.com/forum/resources/categories/tools.4/";
const OBS_FORUM_SCRIPTS_URL: &str = "https://obsproject.com/forum/resources/categories/scripts.5/";

/// Check if href looks like a resource link: .../name.123 or .../name.123/
fn is_resource_url(href: &str) -> bool {
    let href = href.trim().trim_end_matches('/');
    if !href.contains("/forum/resources/") {
        return false;
    }
    let rest = href
        .split("/forum/resources/")
        .nth(1)
        .unwrap_or("");
    let mut parts = rest.split('.');
    let _name = parts.next();
    let last = parts.next();
    match last {
        Some(s) => s.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// Normalize forum resource URL to full form.
fn normalize_resource_url(href: &str) -> String {
    let href = href.trim().trim_end_matches('/');
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else if href.starts_with("/") {
        format!("https://obsproject.com{}", href)
    } else {
        format!("https://obsproject.com/forum/resources/{}", href)
    }
}

/// Extract resource id from URL (the number after the last dot).
fn resource_id_from_url(href: &str) -> Option<String> {
    let href = href.trim().trim_end_matches('/');
    let rest = href.split("/forum/resources/").nth(1)?;
    let name_part = rest.split('.').next_back()?;
    if name_part.chars().all(|c| c.is_ascii_digit()) {
        Some(name_part.to_string())
    } else {
        None
    }
}

/// Parse "1,618" -> 1618.
fn parse_download_count(s: &str) -> Option<u32> {
    let n: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    n.parse().ok()
}

fn category_base_url(category: &str) -> &'static str {
    match category {
        "themes" => OBS_FORUM_THEMES_URL,
        "tools" => OBS_FORUM_TOOLS_URL,
        "scripts" => OBS_FORUM_SCRIPTS_URL,
        _ => OBS_FORUM_PLUGINS_URL,
    }
}

fn fetch_forum_resources_page(
    client: &reqwest::blocking::Client,
    category: &str,
    page: u32,
) -> Result<Vec<ForumPlugin>, String> {
    let base = category_base_url(category);
    let url = if page <= 1 {
        base.to_string()
    } else if category == "plugins" {
        format!("https://obsproject.com/forum/plugins/?page={}", page)
    } else {
        format!("{}?page={}", base.trim_end_matches('/'), page)
    };
    let body = client
        .get(&url)
        .send()
        .map_err(|e| format!("Network error: {}", e))?
        .text()
        .map_err(|e| e.to_string())?;

    let doc = Html::parse_document(&body);
    let item_sel = Selector::parse("div.structItem.structItem--resource").map_err(|e| e.to_string())?;
    // These selectors target the OBS forum HTML structure; parse errors indicate selector bugs
    let title_sel = Selector::parse("div.structItem-title a[href*='/forum/resources/']")
        .expect("valid forum title selector");
    let version_sel = Selector::parse("div.structItem-title span.u-muted").expect("valid version selector");
    let author_sel = Selector::parse("a.username").expect("valid author selector");
    let desc_sel = Selector::parse("div.structItem-resourceTagLine").expect("valid desc selector");
    let rating_sel = Selector::parse("span.ratingStars").expect("valid rating selector");
    let rating_text_sel = Selector::parse("span.ratingStarsRow-text").expect("valid rating text selector");
    let downloads_sel = Selector::parse("dl.structItem-metaItem--downloads dd").expect("valid downloads selector");
    let updated_sel = Selector::parse("dl.structItem-metaItem--lastUpdate dd").expect("valid updated selector");
    let icon_sel =
        Selector::parse("div.structItem-iconContainer img[src*='resource_icons']").expect("valid icon selector");
    let prefix_sel = Selector::parse("span.label--prefix, a.tagItem--prefix").expect("valid prefix selector");

    let mut list = Vec::new();
    for item in doc.select(&item_sel) {
        let title_link = item.select(&title_sel).next();
        let href = match title_link.and_then(|a| a.value().attr("href")) {
            Some(h) => h,
            None => continue,
        };
        if !is_resource_url(href) {
            continue;
        }
        let id = match resource_id_from_url(href) {
            Some(id) => id,
            None => continue,
        };
        let resource_url = normalize_resource_url(href);
        let download_url = Some(format!("{}/download", resource_url.trim_end_matches('/')));

        let title = title_link
            .map(|a| {
                a.text()
                    .collect::<Vec<_>>()
                    .join("")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        if title.is_empty() || title.len() < 2 {
            continue;
        }

        let version = item
            .select(&version_sel)
            .next()
            .map(|e| e.text().collect::<Vec<_>>().join("").trim().to_string());

        let author = item
            .select(&author_sel)
            .next()
            .map(|e| e.text().collect::<Vec<_>>().join("").trim().to_string());

        let description = item
            .select(&desc_sel)
            .next()
            .map(|e| e.text().collect::<Vec<_>>().join("").trim().to_string());

        let (rating, rating_count) = item
            .select(&rating_sel)
            .next()
            .and_then(|r| {
                let title_attr = r.value().attr("title")?;
                let rating = title_attr.replace(" star(s)", "").trim().to_string();
                let rc = item
                    .select(&rating_text_sel)
                    .next()
                    .map(|e| e.text().collect::<Vec<_>>().join("").trim().to_string());
                Some((rating, rc))
            })
            .unwrap_or((String::new(), None));
        let rating = if rating.is_empty() { None } else { Some(rating) };

        let downloads = item
            .select(&downloads_sel)
            .next()
            .and_then(|dd| parse_download_count(&dd.text().collect::<Vec<_>>().join("")));

        let updated = item
            .select(&updated_sel)
            .next()
            .map(|dd| dd.text().collect::<Vec<_>>().join("").trim().to_string());

        let icon_url = item
            .select(&icon_sel)
            .next()
            .and_then(|img| img.value().attr("src"))
            .map(|s| {
                if s.starts_with("http") {
                    s.to_string()
                } else {
                    format!("https://obsproject.com{}", s)
                }
            });

        let prefix = item
            .select(&prefix_sel)
            .next()
            .map(|e| e.text().collect::<Vec<_>>().join("").trim().to_string())
            .filter(|s| !s.is_empty());

        list.push(ForumPlugin {
            id: id.clone(),
            title,
            url: resource_url,
            category: Some(category.to_string()),
            download_url,
            description: description.filter(|s| !s.is_empty()),
            author: author.filter(|s| !s.is_empty()),
            version: version.filter(|s| !s.is_empty()),
            rating,
            rating_count,
            downloads,
            updated,
            icon_url,
            prefix,
        });
    }
    Ok(list)
}

#[tauri::command]
async fn fetch_forum_plugins(
    category: Option<String>,
    force_refresh: Option<bool>,
    max_pages: Option<u32>,
) -> Result<Vec<ForumPlugin>, String> {
    run_blocking(move || {
        let cat = category.as_deref().unwrap_or("plugins");
        fetch_forum_plugins_impl(cat, force_refresh.unwrap_or(false), max_pages.unwrap_or(3))
    })
    .await
}

fn fetch_forum_plugins_impl(
    category: &str,
    force_refresh: bool,
    max_pages: u32,
) -> Result<Vec<ForumPlugin>, String> {
    if !force_refresh {
        if let Some(cached) = load_forum_cache(category) {
            return Ok(cached);
        }
    }

    let client = http_client(30)?;

    let mut by_id: HashMap<String, ForumPlugin> = HashMap::new();
    let pages = max_pages.clamp(1, 5);

    for page in 1..=pages {
        match fetch_forum_resources_page(&client, category, page) {
            Ok(plugins) => {
                for p in plugins {
                    by_id.entry(p.id.clone()).or_insert(p);
                }
            }
            Err(e) => {
                if page == 1 {
                    return Err(e);
                }
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }

    let mut list: Vec<ForumPlugin> = by_id.into_values().collect();
    list.sort_by_key(|a| a.title.to_lowercase());
    save_forum_cache(category, &list);
    Ok(list)
}

#[tauri::command]
async fn search_forum_resources(keywords: String) -> Result<Vec<ForumPlugin>, String> {
    run_blocking(move || search_forum_resources_sync(keywords)).await
}

fn search_forum_resources_sync(keywords: String) -> Result<Vec<ForumPlugin>, String> {
    let kw = keywords.trim().to_lowercase();
    if kw.is_empty() {
        return Ok(Vec::new());
    }
    let client = http_client(30)?;

    let mut by_id: HashMap<String, ForumPlugin> = HashMap::new();
    for category in &["plugins", "themes", "tools", "scripts"] {
        if let Ok(plugins) = fetch_forum_resources_page(&client, category, 1) {
            for p in plugins {
                let matches = p.title.to_lowercase().contains(&kw)
                    || p.author.as_ref().is_some_and(|a| a.to_lowercase().contains(&kw))
                    || p.description.as_ref().is_some_and(|d| d.to_lowercase().contains(&kw));
                if matches {
                    by_id.entry(p.id.clone()).or_insert(p);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let mut list: Vec<ForumPlugin> = by_id.into_values().collect();
    list.sort_by_key(|p| std::cmp::Reverse(p.downloads.unwrap_or(0)));
    Ok(list)
}

/// Info about an available plugin update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUpdateInfo {
    pub plugin_name: String,
    pub installed_version: Option<String>,
    pub available_version: Option<String>,
    pub forum_url: String,
}

fn version_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let norm = |s: &str| {
        s.trim_start_matches('v')
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter_map(|p| p.parse::<u32>().ok())
            .collect::<Vec<_>>()
    };
    let aa = norm(a);
    let bb = norm(b);
    for (x, y) in aa.iter().zip(bb.iter()) {
        match x.cmp(y) {
            std::cmp::Ordering::Equal => {}
            o => return o,
        }
    }
    aa.len().cmp(&bb.len())
}

#[tauri::command]
async fn check_plugin_updates() -> Result<Vec<PluginUpdateInfo>, String> {
    run_blocking(check_plugin_updates_sync).await
}

fn check_plugin_updates_sync() -> Result<Vec<PluginUpdateInfo>, String> {
    let installed = list_obs_plugins();
    let forum = fetch_forum_plugins_impl("plugins", false, 2)?;
    let mut updates = Vec::new();
    for inst in &installed {
        let inst_name_lower = inst.name.to_lowercase().replace(['-', '_', ' '], "");
        let inst_ver = inst.version.clone();
        for fp in &forum {
            let fp_title_lower = fp.title.to_lowercase().replace(['-', '_', ' '], "");
            if inst_name_lower.contains(&fp_title_lower)
                || fp_title_lower.contains(&inst_name_lower)
                || inst.name.eq_ignore_ascii_case(&fp.title)
            {
                let forum_ver: String = fp.version.clone().unwrap_or_default();
                let has_newer = match (&inst_ver, forum_ver.as_str()) {
                    (Some(i), f) if !f.is_empty() => version_compare(f, i) == std::cmp::Ordering::Greater,
                    (None, f) if !f.is_empty() => true,
                    _ => false,
                };
                if has_newer {
                    updates.push(PluginUpdateInfo {
                        plugin_name: inst.name.clone(),
                        installed_version: inst_ver.clone(),
                        available_version: fp.version.clone(),
                        forum_url: fp.url.clone(),
                    });
                }
                break;
            }
        }
    }
    Ok(updates)
}

/// Fetches available download options for a forum resource (forum files + GitHub releases).
#[tauri::command]
async fn fetch_plugin_download_options(resource_url: String) -> Result<Vec<DownloadOption>, String> {
    run_blocking(move || fetch_plugin_download_options_sync(resource_url)).await
}

fn fetch_plugin_download_options_sync(resource_url: String) -> Result<Vec<DownloadOption>, String> {
    let client = http_client(30)?;

    let mut options = Vec::new();

    // Step 1: Fetch forum download page to list available file attachments
    let download_page = resource_url.trim_end_matches('/').to_string() + "/download";
    if let Ok(resp) = client.get(&download_page).send() {
        if let Ok(body) = resp.text() {
            let doc = Html::parse_document(&body);
            let row_sel = Selector::parse("li.block-row").expect("valid row selector");
            let link_sel = Selector::parse("a[href*='/download?file=']").expect("valid link selector");
            let title_sel = Selector::parse("h3.contentRow-title").expect("valid title selector");
            let minor_sel = Selector::parse("div.contentRow-minor").expect("valid minor selector");
            for row in doc.select(&row_sel) {
                if let Some(link) = row.select(&link_sel).next() {
                    let href = link.value().attr("href").unwrap_or("");
                    let url = if href.starts_with("http") {
                        href.to_string()
                    } else {
                        format!("https://obsproject.com{}", href)
                    };
                    let label = row
                        .select(&title_sel)
                        .next()
                        .map(|h| h.text().collect::<Vec<_>>().join("").trim().to_string())
                        .unwrap_or_else(|| url.clone());
                    let size = row
                        .select(&minor_sel)
                        .next()
                        .map(|m| m.text().collect::<Vec<_>>().join("").trim().to_string())
                        .filter(|s| !s.is_empty());
                    options.push(DownloadOption {
                        label,
                        url,
                        size,
                        source: Some("forum".to_string()),
                    });
                }
            }
        }
    }

    // Step 2: Fetch resource page to find GitHub repository URL
    let resource_page = resource_url.trim_end_matches('/').to_string();
    let mut github_url: Option<String> = None;
    if let Ok(resp) = client.get(&resource_page).send() {
        if let Ok(body) = resp.text() {
            let doc = Html::parse_document(&body);
            let dd_sel = Selector::parse("dd").expect("valid dd selector");
            let gh_sel = Selector::parse("a[href*='github.com']").expect("valid github link selector");
            for dd in doc.select(&dd_sel) {
                if let Some(a) = dd.select(&gh_sel).next() {
                    if let Some(href) = a.value().attr("href") {
                        github_url = Some(href.to_string());
                        break;
                    }
                }
            }
        }
    }

    // Step 3: Fetch GitHub releases API for .zip/.exe assets
    if let Some(gh) = github_url {
        if let Some((owner, repo)) = parse_github_repo(&gh) {
            let api_url =
                format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo);
            if let Ok(resp) = client.get(&api_url).header("Accept", "application/vnd.github.v3+json").send() {
                if let Ok(json) = resp.json::<serde_json::Value>() {
                    if let Some(assets) = json.get("assets").and_then(|a| a.as_array()) {
                        for asset in assets {
                            if let (Some(name), Some(url)) = (
                                asset.get("name").and_then(|n| n.as_str()),
                                asset.get("browser_download_url").and_then(|u| u.as_str()),
                            ) {
                                if name.ends_with(".zip") || name.ends_with(".exe") {
                                    let size = asset
                                        .get("size")
                                        .and_then(|s| s.as_u64())
                                        .map(format_size);
                                    options.push(DownloadOption {
                                        label: name.to_string(),
                                        url: url.to_string(),
                                        size,
                                        source: Some("github".to_string()),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if options.is_empty() {
        return Err("No download options found. Try opening the plugin page in browser.".to_string());
    }
    Ok(options)
}

fn parse_github_repo(url: &str) -> Option<(String, String)> {
    let s = url.trim().trim_end_matches('/');
    let s = s.strip_prefix("https://github.com/").or_else(|| s.strip_prefix("http://github.com/"))?;
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() >= 2 {
        let owner = parts[0].to_string();
        let mut repo = parts[1].to_string();
        if repo.ends_with(".git") {
            repo = repo.strip_suffix(".git").unwrap_or(&repo).to_string();
        }
        return Some((owner, repo));
    }
    None
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

/// Sets `enabled` on every entry named `module_name`, returning the new file text.
///
/// Entries are edited as raw `Value`s so fields this app does not model - OBS is
/// free to add more - survive the rewrite untouched.
fn set_enabled_in_modules_json(
    raw: &str,
    module_name: &str,
    enabled: bool,
) -> Result<String, String> {
    let mut modules: Vec<serde_json::Value> =
        serde_json::from_str(raw).map_err(|e| format!("Unexpected modules.json format: {}", e))?;

    let mut found = false;
    for module in modules.iter_mut() {
        let matches = module
            .get("module_name")
            .and_then(|n| n.as_str())
            .is_some_and(|n| n == module_name);
        if matches {
            if let Some(obj) = module.as_object_mut() {
                obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
                found = true;
            }
        }
    }
    if !found {
        return Err(format!("OBS does not list a module named {}.", module_name));
    }
    serde_json::to_string_pretty(&modules).map_err(|e| e.to_string())
}

/// Returns OBS 32's own module list, or an empty list when OBS does not track one.
#[tauri::command(async)]
fn get_obs_modules() -> Vec<ObsModuleInfo> {
    load_obs_modules()
}

/// Path of the OBS modules.json this app reads, for the diagnostics panel.
#[tauri::command(async)]
fn get_obs_modules_path() -> Option<String> {
    obs_modules_json_path()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

/// Flips a module's `enabled` flag in OBS's own plugin manager state.
///
/// This is the mechanism OBS 32 itself uses, so unlike renaming a folder to
/// `.disabled` it stays consistent with what OBS shows. The file is rewritten
/// from parsed `Value`s so any field this app does not model is preserved.
#[tauri::command]
async fn set_module_enabled(module_name: String, enabled: bool) -> Result<(), String> {
    run_blocking(move || set_module_enabled_sync(module_name, enabled)).await
}

fn set_module_enabled_sync(module_name: String, enabled: bool) -> Result<(), String> {
    if load_config().read_only {
        return Err("Read-only mode: changing modules is disabled.".to_string());
    }
    // OBS rewrites this file when it exits, which would silently undo the change.
    ensure_obs_not_running()?;
    let _guard = lock_plugin_mutations();

    let path = obs_modules_json_path().ok_or("OBS configuration folder not found.")?;
    if !path.is_file() {
        return Err(
            "OBS does not expose a plugin manager state file. This needs OBS Studio 32 or newer."
                .to_string(),
        );
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format_io_error(e, "read modules.json"))?;
    let json = set_enabled_in_modules_json(&raw, &module_name, enabled)?;

    // Keep one restore point next to the file before the first rewrite.
    let backup = path.with_extension("json.lamaworlds-backup");
    if !backup.exists() {
        let _ = std::fs::copy(&path, &backup);
    }

    std::fs::write(&path, json).map_err(|e| format_io_error(e, "write modules.json"))?;
    log_action(&format!(
        "OBS module {}: {}",
        module_name,
        if enabled { "enabled" } else { "disabled" }
    ));
    Ok(())
}

#[tauri::command(async)]
fn get_favorites() -> Vec<String> {
    load_config().forum_favorites
}

#[tauri::command(async)]
fn set_favorites(ids: Vec<String>) -> Result<(), String> {
    let mut config = load_config();
    config.forum_favorites = ids;
    save_config(&config)
}

/// Hardcoded popular plugins (fallback; Discover uses the live forum scrape).
#[tauri::command]
fn get_plugin_catalog() -> Vec<CatalogPlugin> {
    vec![
        CatalogPlugin {
            id: "obs-websocket".to_string(),
            name: "obs-websocket".to_string(),
            description: "WebSocket API pour OBS Studio".to_string(),
            download_url: "https://github.com/obsproject/obs-websocket/releases/latest/download/obs-websocket-Windows.zip".to_string(),
            version: None,
        },
        CatalogPlugin {
            id: "obs-ndi".to_string(),
            name: "obs-ndi".to_string(),
            description: "Support NDI pour OBS".to_string(),
            download_url: "https://github.com/obs-ndi/obs-ndi/releases/latest/download/obs-ndi-4.x.x-windows-x64-Installer.zip".to_string(),
            version: None,
        },
        CatalogPlugin {
            id: "streamfx".to_string(),
            name: "StreamFX".to_string(),
            description: "Effets et sources avancés".to_string(),
            download_url: "https://github.com/Xaymar/obs-StreamFX/releases/latest/download/StreamFX-0.15.x-windows-x64.zip".to_string(),
            version: None,
        },
        CatalogPlugin {
            id: "move".to_string(),
            name: "Move".to_string(),
            description: "Déplace sources et valeurs (transitions)".to_string(),
            download_url: "https://github.com/exeldro/obs-move-transition/releases/latest/download/obs-move-transition-windows.zip".to_string(),
            version: None,
        },
        CatalogPlugin {
            id: "advanced-scene-switcher".to_string(),
            name: "Advanced Scene Switcher".to_string(),
            description: "Automatise scènes et tâches".to_string(),
            download_url: "https://github.com/WarmUpTill/SceneSwitcher/releases/latest/download/Advanced_Scene_Switcher-Windows.zip".to_string(),
            version: None,
        },
        CatalogPlugin {
            id: "obs-shaderfilter".to_string(),
            name: "obs-shaderfilter".to_string(),
            description: "Effets shader personnalisés sur les sources".to_string(),
            download_url: "https://github.com/exeldro/obs-shaderfilter/releases/latest/download/obs-shaderfilter-windows.zip".to_string(),
            version: None,
        },
    ]
}

/// Opens a web URL in the default browser.
///
/// Restricted to http/https: forum URLs are scraped from untrusted HTML, and
/// `open::that` on Windows would happily launch a local executable or a
/// `file:`/`shell:` target handed to it.
#[tauri::command(async)]
fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err(format!("Refused to open non-web URL: {}", trimmed));
    }
    open::that(trimmed).map_err(|e| e.to_string())
}

/// Open the plugins dir in Explorer; creates it if missing.
#[tauri::command(async)]
fn open_plugins_folder(folder_override: Option<String>) -> Result<(), String> {
    let folder = folder_override.or_else(|| {
        get_target_plugins_dir().ok().map(|p| p.to_string_lossy().to_string())
    });
    let folder = folder.ok_or_else(|| "No OBS plugin folder found. Configure path in Options.".to_string())?;
    let path = Path::new(&folder);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::create_dir_all(path);
    }
    if !path.exists() {
        return Err(format!("Could not create folder: {}. Check path in Options.", folder));
    }
    open::that(&folder).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_action("Plugin Manager started");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_obs_paths,
            get_config,
            set_config,
            validate_path,
            list_obs_plugins,
            uninstall_plugin,
            disable_plugin,
            enable_plugin,
            install_plugin_from_url,
            install_plugin_from_path,
            get_plugin_catalog,
            fetch_forum_plugins,
            search_forum_resources,
            check_plugin_updates,
            fetch_plugin_download_options,
            get_favorites,
            set_favorites,
            export_plugins_list_json,
            export_plugins_list_csv,
            open_plugins_folder,
            open_url,
            is_obs_running,
            backup_plugin_folder,
            backup_all_plugins,
            export_config_json,
            write_text_file,
            read_text_file,
            check_paths_valid,
            get_config_dir,
            open_log_folder,
            read_log_file,
            open_downloads_folder,
            test_forum_connection,
            get_obs_modules,
            get_obs_modules_path,
            set_module_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like a real OBS 32 modules.json, including a field this app does
    /// not model (`id`) and the " (N)" suffix OBS appends to duplicate modules.
    const SAMPLE: &str = r#"[
      {"display_name":"","enabled":true,"encoders":[],"id":"","module_name":"tuna",
       "outputs":[],"services":[],"sources":["progress_bar"],"version":""},
      {"display_name":"APPLET_OBS_NAME","enabled":true,"encoders":[],"id":"",
       "module_name":"logi_obs_plugin_x64 (1)","outputs":[],"services":[],
       "sources":[],"version":""}
    ]"#;

    fn plugin(name: &str, modules: &[&str]) -> ObsPluginInfo {
        ObsPluginInfo {
            name: name.to_string(),
            path: String::new(),
            uninstall_path: String::new(),
            enabled: true,
            version: None,
            modified_time: None,
            module_names: modules.iter().map(|m| m.to_string()).collect(),
            obs_enabled: None,
            obs_managed: false,
            obs_display_name: None,
            support_dll: false,
        }
    }

    #[test]
    fn parses_obs_module_list() {
        let modules: Vec<ObsModuleInfo> = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(modules.len(), 2);
        assert_eq!(modules[0].module_name, "tuna");
        assert_eq!(modules[0].sources, vec!["progress_bar".to_string()]);
        assert_eq!(
            modules[1].display_name.as_deref(),
            Some("APPLET_OBS_NAME")
        );
    }

    #[test]
    fn a_bare_dll_that_obs_ignores_is_not_a_plugin() {
        let modules: Vec<ObsModuleInfo> = serde_json::from_str(SAMPLE).unwrap();
        let mut builtin = plugin("obs-ffmpeg", &["obs-ffmpeg"]);
        builtin.uninstall_path = "C:/obs/obs-plugins/64bit/obs-ffmpeg.dll".to_string();
        let mut tracked = plugin("tuna", &["tuna"]);
        tracked.uninstall_path = "C:/obs/obs-plugins/64bit/tuna.dll".to_string();
        // A folder plugin OBS has not loaded yet: unknown, but never a built-in.
        let mut fresh = plugin("brand-new", &["brand-new"]);
        fresh.uninstall_path = "C:/obs/plugins/brand-new".to_string();

        let mut plugins = vec![builtin, tracked, fresh];
        apply_module_states(&mut plugins, &modules);

        assert!(plugins[0].support_dll, "OBS built-in should be flagged");
        assert!(!plugins[1].support_dll, "a tracked module is not a support DLL");
        assert!(
            !plugins[2].support_dll,
            "a folder plugin awaiting its first OBS launch must not be flagged"
        );
    }

    #[test]
    fn marks_plugins_that_obs_tracks() {
        let modules: Vec<ObsModuleInfo> = serde_json::from_str(SAMPLE).unwrap();
        let mut plugins = vec![
            plugin("tuna", &["tuna"]),
            plugin("obs-ffmpeg", &["obs-ffmpeg"]),
        ];
        apply_module_states(&mut plugins, &modules);

        assert!(plugins[0].obs_managed);
        assert_eq!(plugins[0].obs_enabled, Some(true));
        // A built-in OBS module has no entry, so it must stay unmanaged: the UI
        // relies on this to keep users from uninstalling part of OBS itself.
        assert!(!plugins[1].obs_managed);
        assert_eq!(plugins[1].obs_enabled, None);
    }

    #[test]
    fn a_plugin_is_enabled_only_when_all_its_modules_are() {
        let raw = set_enabled_in_modules_json(SAMPLE, "tuna", false).unwrap();
        let modules: Vec<ObsModuleInfo> = serde_json::from_str(&raw).unwrap();
        let mut plugins = vec![plugin("bundle", &["tuna", "logi_obs_plugin_x64 (1)"])];
        apply_module_states(&mut plugins, &modules);
        assert_eq!(plugins[0].obs_enabled, Some(false));
    }

    #[test]
    fn disabling_preserves_unmodelled_fields() {
        let updated = set_enabled_in_modules_json(SAMPLE, "tuna", false).unwrap();
        let value: serde_json::Value = serde_json::from_str(&updated).unwrap();
        let first = &value[0];
        assert_eq!(first["enabled"], serde_json::Value::Bool(false));
        // `id`, `outputs`, `services` and `encoders` are round-tripped even
        // though ObsModuleInfo does not declare them.
        assert!(first.get("id").is_some(), "id field was dropped");
        assert!(first.get("outputs").is_some(), "outputs field was dropped");
        assert!(first.get("services").is_some(), "services field was dropped");
        assert!(first.get("encoders").is_some(), "encoders field was dropped");
        // Untouched entries keep their state.
        assert_eq!(value[1]["enabled"], serde_json::Value::Bool(true));
    }

    #[test]
    fn rejects_an_unknown_module() {
        let err = set_enabled_in_modules_json(SAMPLE, "not-installed", false).unwrap_err();
        assert!(err.contains("not-installed"), "unhelpful error: {}", err);
    }

    #[test]
    fn module_names_come_from_dll_stems() {
        let dir = std::env::temp_dir().join("lamaworlds_module_names_test");
        let bin = dir.join("bin").join("64bit");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("my-plugin.dll"), b"").unwrap();
        std::fs::write(bin.join("my-plugin.pdb"), b"").unwrap();

        let mut names = module_names_for(&dir);
        names.sort();
        assert_eq!(names, vec!["my-plugin".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn module_name_of_a_disabled_legacy_dll_drops_both_suffixes() {
        let dir = std::env::temp_dir().join("lamaworlds_disabled_dll_test");
        std::fs::create_dir_all(&dir).unwrap();
        let disabled = dir.join("tuna.dll.disabled");
        std::fs::write(&disabled, b"").unwrap();
        let active = dir.join("obs-shaderfilter.dll");
        std::fs::write(&active, b"").unwrap();

        // A disabled plugin must still resolve to the module name OBS knows,
        // otherwise re-enabling it could never be matched back to modules.json.
        assert_eq!(module_names_for(&disabled), vec!["tuna".to_string()]);
        assert_eq!(
            module_names_for(&active),
            vec!["obs-shaderfilter".to_string()]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_comparison_orders_releases() {
        use std::cmp::Ordering;
        assert_eq!(version_compare("1.2.0", "1.10.0"), Ordering::Less);
        assert_eq!(version_compare("v2.0", "1.9.9"), Ordering::Greater);
        assert_eq!(version_compare("1.0.0", "1.0.0"), Ordering::Equal);
    }

}
