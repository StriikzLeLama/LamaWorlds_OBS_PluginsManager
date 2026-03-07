//! LamaWorlds OBS Addon Manager - Backend
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
use walkdir::WalkDir;

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

fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("com", "lamaworlds", "addon-manager")
        .map(|d| d.config_dir().join("config.json"))
}

fn config_dir() -> Option<PathBuf> {
    ProjectDirs::from("com", "lamaworlds", "addon-manager").map(|d| d.config_dir().to_path_buf())
}

fn forum_cache_path(category: &str) -> PathBuf {
    config_dir()
        .map(|d| d.join(format!("forum_cache_{}.json", category)))
        .unwrap_or_else(|| PathBuf::from("forum_cache.json"))
}

fn log_file_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("addon-manager.log"))
}

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

fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path().ok_or("Could not determine config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsPaths {
    pub plugins_path: Option<String>,
    pub obs_install_path: Option<String>,
    pub appdata_plugins: Option<String>,
    pub custom_plugins_path: Option<String>,
    pub custom_obs_install_path: Option<String>,
}

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

#[tauri::command]
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

#[tauri::command]
fn get_config() -> AppConfig {
    load_config()
}

#[tauri::command]
fn set_config(config: AppConfig) -> Result<(), String> {
    save_config(&config)
}

#[tauri::command]
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
                            e.path().extension().map_or(false, |ext| ext == "dll")
                        })
                    })
                    .unwrap_or(false);
                if has_dll {
                    let version = try_read_plugin_version(&entry_path, &plugin_name);
                    let modified_time = get_modified_time(&entry_path);
                    plugins.push(ObsPluginInfo {
                        name: plugin_name,
                        path: entry_path.to_string_lossy().to_string(),
                        uninstall_path: entry_path.to_string_lossy().to_string(),
                        enabled,
                        version,
                        modified_time,
                    });
                }
            }
        }
    }

    plugins
}

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
        } else if entry_path.extension().map_or(false, |ext| ext == "dll") {
            (true, entry_path.file_stem().and_then(|n| n.to_str()).unwrap_or("").to_string())
        } else {
            continue;
        };
        if !plugin_name.is_empty() {
            let modified_time = get_modified_time(&entry_path);
            plugins.push(ObsPluginInfo {
                name: plugin_name,
                path: bin_64.to_string_lossy().to_string(),
                uninstall_path: entry_path.to_string_lossy().to_string(),
                enabled,
                version: None,
                modified_time,
            });
        }
    }
    plugins
}

#[tauri::command]
fn list_obs_plugins() -> Vec<ObsPluginInfo> {
    let mut all_plugins = Vec::new();
    let mut seen_names = std::collections::HashSet::new();
    let paths = get_obs_paths();

    let mut plugin_paths: Vec<Option<String>> = vec![
        paths.custom_plugins_path,
        paths.plugins_path,
        paths.appdata_plugins,
    ];
    for obs in [paths.custom_obs_install_path.as_deref(), paths.obs_install_path.as_deref()].into_iter().flatten() {
        plugin_paths.push(Some(Path::new(obs).join("data").join("plugins").to_string_lossy().to_string()));
    }

    for path_opt in plugin_paths {
        if let Some(path_str) = path_opt {
            let path = Path::new(&path_str);
            for plugin in find_plugins_in_directory(path) {
                if seen_names.insert(plugin.name.clone()) {
                    all_plugins.push(plugin);
                }
            }
        }
    }

    let obs_paths: Vec<Option<String>> = vec![
        paths.custom_obs_install_path,
        paths.obs_install_path,
    ];
    for obs_path_opt in obs_paths {
        if let Some(obs_path) = obs_path_opt {
            let obs_plugins = Path::new(&obs_path).join("obs-plugins");
            for plugin in find_plugins_in_obs_plugins(&obs_plugins) {
                if seen_names.insert(plugin.name.clone()) {
                    all_plugins.push(plugin);
                }
            }
        }
    }

    all_plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    all_plugins
}

fn remove_dir_all_recursive(p: &Path) -> Result<(), String> {
    if p.is_dir() {
        for entry in std::fs::read_dir(p).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            remove_dir_all_recursive(&entry.path())?;
        }
        std::fs::remove_dir(p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn is_obs_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let output = Command::new("tasklist")
            .output()
            .map_err(|_| ())
            .ok();
        if let Some(ok) = output {
            let stdout = String::from_utf8_lossy(&ok.stdout);
            stdout.to_lowercase().contains("obs64.exe")
        } else {
            false
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn backup_plugin_folder(plugin_path: String) -> Result<String, String> {
    let src = Path::new(&plugin_path);
    if !src.exists() || !src.is_dir() {
        return Err("Plugin folder not found.".to_string());
    }
    if !is_path_in_plugin_dirs(src) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("plugin");
    let parent = src.parent().ok_or("Chemin invalide")?;
    let zip_path = parent.join(format!("{}-backup.zip", name));
    let file = File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip_writer = zip::ZipWriter::new(BufWriter::new(file));
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    for entry in WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let name_in_zip = path.strip_prefix(src).unwrap_or(path);
            let name_str = name_in_zip.to_string_lossy().replace('\\', "/");
            zip_writer
                .start_file(&name_str, options)
                .map_err(|e| e.to_string())?;
            let mut f = File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip_writer).map_err(|e| e.to_string())?;
        }
    }
    zip_writer.finish().map_err(|e| e.to_string())?;
    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
fn uninstall_plugin(uninstall_path: String) -> Result<(), String> {
    if load_config().read_only {
        return Err("Read-only mode: uninstall disabled.".to_string());
    }
    let path = Path::new(&uninstall_path);
    if !path.exists() {
        return Err(format!("File or folder does not exist: {}", uninstall_path));
    }
    if !is_path_in_plugin_dirs(path) {
        return Err("Path must be inside a configured OBS plugin folder.".to_string());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if load_config().auto_backup && path.is_dir() {
        let _ = backup_plugin_folder(uninstall_path.clone());
    }
    log_action(&format!("Uninstall: {}", name));
    if path.is_dir() {
        remove_dir_all_recursive(path)
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
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
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Reads a file. Path is user-chosen via open dialog; no server-side validation.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
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

#[tauri::command]
fn export_plugins_list_csv() -> Result<String, String> {
    let plugins = list_obs_plugins();
    let mut csv = String::from("name,path,version,enabled\n");
    for p in &plugins {
        let version = p.version.as_deref().unwrap_or("");
        let enabled = if p.enabled { "yes" } else { "no" };
        let path_esc = p.path.replace('"', "\"\"");
        csv.push_str(&format!("\"{}\",\"{}\",\"{}\",\"{}\"\n", p.name, path_esc, version, enabled));
    }
    Ok(csv)
}

#[tauri::command]
fn get_config_dir() -> Option<String> {
    config_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let dir = config_dir().ok_or("Config directory not found")?;
    open::that(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn test_forum_connection() -> Result<serde_json::Value, String> {
    match fetch_forum_plugins_impl("plugins", true, 1) {
        Ok(plugins) => Ok(serde_json::json!({ "count": plugins.len(), "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
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

#[tauri::command]
fn disable_plugin(plugin_path: String) -> Result<(), String> {
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

#[tauri::command]
fn enable_plugin(plugin_path: String) -> Result<(), String> {
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

#[tauri::command]
fn install_plugin_from_url(url: String) -> Result<String, String> {
    if load_config().read_only {
        return Err("Read-only mode: install disabled.".to_string());
    }
    let target_dir = get_target_plugins_dir()?;

    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Download error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed (code {})", response.status()));
    }

    let bytes = response.bytes().map_err(|e| e.to_string())?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid ZIP file: {}", e))?;

    let mut installed_name: Option<String> = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();

        if name.ends_with('/') {
            continue;
        }

        let path = Path::new(&name);
        // Reject path traversal (Zip Slip): absolute paths and ".." escape target
        if path.is_absolute()
            || path.components().any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }

        let parts: Vec<&str> = path.components().map(|c| c.as_os_str().to_str().unwrap_or("")).collect();

        let root = parts.first().filter(|s| !s.is_empty()).map_or("", |s| *s);
        if installed_name.is_none() && !root.is_empty() {
            installed_name = Some(root.to_string());
        }

        let out_path = target_dir.join(path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if file.is_file() {
            let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out_file).map_err(|e| e.to_string())?;
        }
    }

    let name = installed_name.ok_or_else(|| "Archive ZIP invalide (structure non reconnue).".to_string())?;
    log_action(&format!("Installed from URL: {} -> {}", url, name));
    Ok(name)
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
    let name_part = rest.split('.').last()?;
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
    let title_sel = Selector::parse("div.structItem-title a[href*='/forum/resources/']").unwrap();
    let version_sel = Selector::parse("div.structItem-title span.u-muted").unwrap();
    let author_sel = Selector::parse("a.username").unwrap();
    let desc_sel = Selector::parse("div.structItem-resourceTagLine").unwrap();
    let rating_sel = Selector::parse("span.ratingStars").unwrap();
    let rating_text_sel = Selector::parse("span.ratingStarsRow-text").unwrap();
    let downloads_sel = Selector::parse("dl.structItem-metaItem--downloads dd").unwrap();
    let updated_sel = Selector::parse("dl.structItem-metaItem--lastUpdate dd").unwrap();
    let icon_sel = Selector::parse("div.structItem-iconContainer img[src*='resource_icons']").unwrap();

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
        });
    }
    Ok(list)
}

#[tauri::command]
fn fetch_forum_plugins(
    category: Option<String>,
    force_refresh: Option<bool>,
    max_pages: Option<u32>,
) -> Result<Vec<ForumPlugin>, String> {
    let cat = category.as_deref().unwrap_or("plugins");
    fetch_forum_plugins_impl(cat, force_refresh.unwrap_or(false), max_pages.unwrap_or(3))
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

    let client = reqwest::blocking::Client::builder()
        .user_agent("LamaWorlds-OBS-AddonManager/1.0 (Desktop; OBS Plugin Manager)")
        .build()
        .map_err(|e| e.to_string())?;

    let mut by_id: HashMap<String, ForumPlugin> = HashMap::new();
    let pages = max_pages.max(1).min(5);

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
    list.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    save_forum_cache(category, &list);
    Ok(list)
}

#[tauri::command]
fn search_forum_resources(keywords: String) -> Result<Vec<ForumPlugin>, String> {
    let kw = keywords.trim().to_lowercase();
    if kw.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("LamaWorlds-OBS-AddonManager/1.0 (Desktop; OBS Plugin Manager)")
        .build()
        .map_err(|e| e.to_string())?;

    let mut by_id: HashMap<String, ForumPlugin> = HashMap::new();
    for category in &["plugins", "themes", "tools", "scripts"] {
        if let Ok(plugins) = fetch_forum_resources_page(&client, category, 1) {
            for p in plugins {
                let matches = p.title.to_lowercase().contains(&kw)
                    || p.author.as_ref().map_or(false, |a| a.to_lowercase().contains(&kw))
                    || p.description.as_ref().map_or(false, |d| d.to_lowercase().contains(&kw));
                if matches {
                    by_id.entry(p.id.clone()).or_insert(p);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let mut list: Vec<ForumPlugin> = by_id.into_values().collect();
    list.sort_by(|a, b| b.downloads.unwrap_or(0).cmp(&a.downloads.unwrap_or(0)));
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
fn check_plugin_updates() -> Result<Vec<PluginUpdateInfo>, String> {
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

#[tauri::command]
fn fetch_plugin_download_options(resource_url: String) -> Result<Vec<DownloadOption>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("LamaWorlds-OBS-AddonManager/1.0 (Desktop; OBS Plugin Manager)")
        .build()
        .map_err(|e| e.to_string())?;

    let mut options = Vec::new();

    // 1. Fetch forum download page for file list
    let download_page = resource_url.trim_end_matches('/').to_string() + "/download";
    if let Ok(resp) = client.get(&download_page).send() {
        if let Ok(body) = resp.text() {
            let doc = Html::parse_document(&body);
            let row_sel = Selector::parse("li.block-row").unwrap();
            let link_sel = Selector::parse("a[href*='/download?file=']").unwrap();
            let title_sel = Selector::parse("h3.contentRow-title").unwrap();
            let minor_sel = Selector::parse("div.contentRow-minor").unwrap();
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

    // 2. Fetch resource page for GitHub source URL
    let resource_page = resource_url.trim_end_matches('/').to_string();
    let mut github_url: Option<String> = None;
    if let Ok(resp) = client.get(&resource_page).send() {
        if let Ok(body) = resp.text() {
            let doc = Html::parse_document(&body);
            for dd in doc.select(&Selector::parse("dd").unwrap()) {
                if let Some(a) = dd.select(&Selector::parse("a[href*='github.com']").unwrap()).next() {
                    if let Some(href) = a.value().attr("href") {
                        github_url = Some(href.to_string());
                        break;
                    }
                }
            }
        }
    }

    // 3. Fetch GitHub releases if we have a repo URL
    if let Some(gh) = github_url {
        if let Some((owner, repo)) = parse_github_repo(&gh) {
            let api_url = format!(
                "https://api.github.com/repos/{}/releases/latest",
                format!("{}/{}", owner, repo)
            );
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

#[tauri::command]
fn get_favorites() -> Vec<String> {
    load_config().forum_favorites
}

#[tauri::command]
fn set_favorites(ids: Vec<String>) -> Result<(), String> {
    let mut config = load_config();
    config.forum_favorites = ids;
    save_config(&config)
}

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

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
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
        let _ = std::fs::create_dir_all(&path);
    }
    if !path.exists() {
        return Err(format!("Could not create folder: {}. Check path in Options.", folder));
    }
    open::that(&folder).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            export_config_json,
            write_text_file,
            read_text_file,
            check_paths_valid,
            get_config_dir,
            open_log_folder,
            test_forum_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
