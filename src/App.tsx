/**
 * LamaWorlds OBS Plugin Manager - Main UI
 *
 * Manages OBS plugins: list, install from forum/URL, disable/enable, uninstall.
 * Pages: Home (plugins), Options (config), Discover (forum catalog).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, openFolderDialog } from "./tauriApi";
import { ask, save, open } from "@tauri-apps/plugin-dialog";
import logo from "./image/logo_64x64.png";
import { t, getLang, setLang, type Lang } from "./i18n";
import type {
  ObsPluginInfo,
  ObsPaths,
  AppConfig,
  PluginUpdateInfo,
  DownloadOption,
  ActionLog,
  Page,
  SortBy,
  StatusFilter,
  ViewMode,
} from "./types";
import { OBS_FORUM_PLUGINS_URL, MAX_ACTION_LOG } from "./types";
import { HomePage, OptionsPage, LogsPage, DiscoverPage } from "./pages";
import { Toast } from "./components/Toast";
import "./App.css";

function App() {
  const [page, setPage] = useState<Page>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "1"; } catch { return false; }
  });
  const [plugins, setPlugins] = useState<ObsPluginInfo[]>([]);
  const [paths, setPaths] = useState<ObsPaths | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [customPluginsPath, setCustomPluginsPath] = useState("");
  const [customObsPath, setCustomObsPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [pathErrors, setPathErrors] = useState<{ plugins?: string; obs?: string }>({});
  const [obsRunning, setObsRunning] = useState(false);
  const [pathValid, setPathValid] = useState(true);
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [configData, setConfigData] = useState<AppConfig | null>(null);
  const [autoBackup, setAutoBackup] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [compactMode, setCompactMode] = useState(false);
  // Theme: dark | light | system (system uses prefers-color-scheme)
  const [theme, setTheme] = useState<"dark" | "light" | "system">(() => {
    try {
      const s = localStorage.getItem("theme");
      if (s === "light" || s === "system") return s;
      return "dark";
    } catch { return "dark"; }
  });
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [lang, setLangState] = useState<Lang>(getLang);
  const [pluginUpdates, setPluginUpdates] = useState<PluginUpdateInfo[]>([]);
  const [updatingPlugins, setUpdatingPlugins] = useState<Set<string>>(new Set());
  const IMPORT_HISTORY_KEY = "obs-plugin-manager-import-history";
  const MAX_IMPORT_HISTORY = 5;
  const [importHistory, setImportHistory] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem(IMPORT_HISTORY_KEY);
      return s ? JSON.parse(s) : [];
    } catch { return []; }
  });
  const [importLoading, setImportLoading] = useState(false);

  const addToImportHistory = useCallback((path: string) => {
    setImportHistory((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_IMPORT_HISTORY);
      try { localStorage.setItem(IMPORT_HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const addAction = useCallback((action: string, plugin?: string, details?: string) => {
    const now = new Date();
    const entry: ActionLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      action,
      plugin,
      details,
      time: now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      date: now.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }),
    };
    setActionLog((prev) => [entry, ...prev].slice(0, MAX_ACTION_LOG));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pluginsList, pathsData, configData, obsRun, valid, cfgDir] =
        await Promise.all([
          invoke<ObsPluginInfo[]>("list_obs_plugins"),
          invoke<ObsPaths>("get_obs_paths"),
          invoke<AppConfig>("get_config"),
          invoke<boolean>("is_obs_running"),
          invoke<boolean>("check_paths_valid"),
          invoke<string | null>("get_config_dir").catch(() => null),
        ]);
      setPlugins(pluginsList);
      setPaths(pathsData);
      setConfigData(configData);
      setAutoBackup(configData.auto_backup ?? true);
      setReadOnly(configData.read_only ?? false);
      setConfigPath(cfgDir ?? null);
      setCustomPluginsPath(configData.custom_plugins_path ?? "");
      setCustomObsPath(configData.custom_obs_install_path ?? "");
      setObsRunning(obsRun);
      setPathValid(valid);
      addAction("Refresh", undefined, `${pluginsList.length} plugins loaded`);
    } catch (e) {
      setError(String(e));
      setPlugins([]);
      setPaths(null);
    } finally {
      setLoading(false);
    }
  }, [addAction]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    try { localStorage.setItem("theme", theme); } catch { /* ignore */ }
  }, [theme]);
  useEffect(() => {
    if (theme !== "system") return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", m.matches ? "dark" : "light");
    };
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, [theme]);

  const checkPluginUpdates = useCallback(async () => {
    try {
      const updates = await invoke<PluginUpdateInfo[]>("check_plugin_updates");
      setPluginUpdates(updates);
    } catch { setPluginUpdates([]); }
  }, []);

  useEffect(() => {
    checkPluginUpdates();
  }, [checkPluginUpdates, plugins]);

  useEffect(() => {
    const validatePaths = async () => {
      const errs: { plugins?: string; obs?: string } = {};
      if (customPluginsPath.trim()) {
        try {
          const ok = await invoke<boolean>("validate_path", {
            path: customPluginsPath.trim(),
          });
          if (!ok) errs.plugins = t.pathDoesNotExist;
        } catch {
          errs.plugins = t.unableToVerify;
        }
      }
      if (customObsPath.trim()) {
        try {
          const ok = await invoke<boolean>("validate_path", {
            path: customObsPath.trim(),
          });
          if (!ok) errs.obs = t.pathDoesNotExist;
        } catch {
          errs.obs = t.unableToVerify;
        }
      }
      setPathErrors(errs);
    };
    const timeoutId = setTimeout(validatePaths, 400);
    return () => clearTimeout(timeoutId);
  }, [customPluginsPath, customObsPath, lang]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  async function saveCustomPaths() {
    if (pathErrors.plugins || pathErrors.obs) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("set_config", {
        config: {
          custom_plugins_path: customPluginsPath.trim() || null,
          custom_obs_install_path: customObsPath.trim() || null,
          forum_favorites: configData?.forum_favorites ?? [],
          auto_backup: autoBackup,
          read_only: readOnly,
        },
      });
      await loadData();
      addAction("Options saved");
      showToast(t.optionsSaved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleFavorite(forumId: string) {
    const current = configData?.forum_favorites ?? [];
    const next = current.includes(forumId)
      ? current.filter((id) => id !== forumId)
      : [...current, forumId];
    try {
      await invoke("set_favorites", { ids: next });
      setConfigData((prev) => (prev ? { ...prev, forum_favorites: next } : null));
    } catch (e) {
      setError(String(e));
    }
  }

  async function openLogFolder() {
    try {
      await invoke("open_log_folder");
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportFavoritesList() {
    try {
      const favs = configData?.forum_favorites ?? [];
      const json = JSON.stringify({ favorites: favs, exportedAt: new Date().toISOString() }, null, 2);
      const path = await save({ defaultPath: "obs-forum-favorites.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        await invoke("write_text_file", { path, contents: json });
        addAction("Export favorites");
        showToast(t.favoritesExported);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function importFavoritesList() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path && typeof path === "string") {
        const contents = await invoke<string>("read_text_file", { path });
        const data = JSON.parse(contents);
        if (Array.isArray(data.favorites)) {
          await invoke("set_favorites", { ids: data.favorites });
          setConfigData((prev) => (prev ? { ...prev, forum_favorites: data.favorites } : null));
          addAction("Import favorites");
        showToast(t.favoritesImported);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function browsePluginsFolder() {
    try {
      const selected = await openFolderDialog("Select OBS plugins folder");
      if (selected) setCustomPluginsPath(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  async function browseObsFolder() {
    try {
      const selected = await openFolderDialog("Select OBS folder");
      if (selected) setCustomObsPath(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  const openPluginsFolder = useCallback(async () => {
    try {
      await invoke("open_plugins_folder");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openPluginFolder = useCallback(async (path: string) => {
    try {
      await invoke("open_plugins_folder", { folderOverride: path });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  async function testForumConnection() {
    try {
      const result = await invoke<{ ok: boolean; count?: number; error?: string }>("test_forum_connection");
      if (result.ok) {
        showToast(t.forumOk(result.count ?? 0));
      } else {
        showToast(t.forumError(result.error ?? "unknown"));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function openForum() {
    try {
      await invoke("open_url", { url: OBS_FORUM_PLUGINS_URL });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openPluginUrl(url: string) {
    try {
      await invoke("open_url", { url });
    } catch (e) {
      setError(String(e));
    }
  }

  async function disablePlugin(plugin: ObsPluginInfo) {
    if (!plugin.enabled) return;
    try {
      await invoke("disable_plugin", { pluginPath: plugin.uninstall_path });
      addAction("Disabled", plugin.name, plugin.path);
      showToast(t.disabledPlugin(plugin.name));
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function enablePlugin(plugin: ObsPluginInfo) {
    if (plugin.enabled) return;
    try {
      await invoke("enable_plugin", { pluginPath: plugin.uninstall_path });
      addAction("Enabled", plugin.name, plugin.path);
      showToast(t.enabledPlugin(plugin.name));
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function uninstallPlugin(plugin: ObsPluginInfo) {
    let ok = false;
    try {
      ok = await ask(
        t.confirmUninstall(plugin.name),
        { title: t.confirm, kind: "warning" }
      );
    } catch {
      ok = window.confirm(t.confirmUninstall(plugin.name));
    }
    if (!ok) return;
    try {
      // Backup is handled by the Rust backend when auto_backup is enabled
      await invoke("uninstall_plugin", { uninstallPath: plugin.uninstall_path });
      addAction("Uninstalled", plugin.name, plugin.path);
      showToast(t.uninstalledPlugin(plugin.name));
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function installFromUrl(url: string) {
    try {
      const res = await invoke<{ name: string; updated: boolean }>("install_plugin_from_url", { url });
      addAction(res.updated ? "Updated" : "Installed", res.name, "from URL");
      showToast(res.updated ? t.updatedPlugin(res.name) : t.installedPlugin(res.name));
      await loadData();
      await checkPluginUpdates();
    } catch (e) {
      setError(String(e));
    }
  }

  const updatePluginFromForum = useCallback(async (update: PluginUpdateInfo) => {
    if (readOnly) return;
    try {
      const running = await invoke<boolean>("is_obs_running");
      if (running) {
        setObsRunning(true);
        setError(t.obsRunning);
        return;
      }
    } catch {
      if (obsRunning) {
        setError(t.obsRunning);
        return;
      }
    }
    setUpdatingPlugins((prev) => new Set(prev).add(update.plugin_name));
    try {
      const opts = await invoke<DownloadOption[]>("fetch_plugin_download_options", {
        resourceUrl: update.forum_url,
      });
      const pick =
        opts.find((o) => /\.zip(\?|$)/i.test(o.url) || o.label.toLowerCase().includes(".zip")) ??
        opts[0];
      if (!pick) {
        setError(t.noDownloadFound(update.plugin_name));
        return;
      }
      const res = await invoke<{ name: string; updated: boolean }>("install_plugin_from_url", {
        url: pick.url,
      });
      addAction(res.updated ? "Updated" : "Installed", res.name, update.forum_url);
      showToast(res.updated ? t.updatedPlugin(res.name) : t.installedPlugin(res.name));
      await loadData();
      await checkPluginUpdates();
    } catch (e) {
      setError(String(e));
    } finally {
      setUpdatingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(update.plugin_name);
        return next;
      });
    }
  }, [readOnly, obsRunning, addAction, showToast, loadData, checkPluginUpdates]);

  const installFromPath = useCallback(async (path: string) => {
    try {
      const res = await invoke<{ name: string; updated: boolean }>("install_plugin_from_path", { path });
      addAction(res.updated ? "Updated" : "Installed", res.name, path);
      showToast(res.updated ? t.updatedPlugin(res.name) : t.installedPlugin(res.name));
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }, [addAction, showToast, loadData]);

  const importFromFile = useCallback(async () => {
    setImportLoading(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Plugin (.zip, .dll)", extensions: ["zip", "dll"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      const paths = selected
        ? (Array.isArray(selected) ? selected : [selected]).filter((p): p is string => typeof p === "string")
        : [];
      for (const p of paths) {
        await installFromPath(p);
        addToImportHistory(p);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setImportLoading(false);
    }
  }, [installFromPath, addToImportHistory]);

  const installFromPastePath = useCallback(async (pathInput: string) => {
    const p = pathInput.trim().replace(/^["']|["']$/g, "");
    if (!p) return;
    setImportLoading(true);
    try {
      await installFromPath(p);
      addToImportHistory(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setImportLoading(false);
    }
  }, [installFromPath, addToImportHistory]);

  const openDownloads = useCallback(async () => {
    try {
      await invoke("open_downloads_folder");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const reimportFromHistory = useCallback(async (path: string) => {
    setImportLoading(true);
    try {
      await installFromPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setImportLoading(false);
    }
  }, [installFromPath]);

  // Listen for drag-drop; cleanup on unmount (handle async listen promise)
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let mounted = true;
    listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
      const paths = event.payload?.paths;
      if (paths?.length && !readOnly) {
        paths.forEach((p) => installFromPath(p));
      }
    }).then((u) => {
      unsub = u;
      if (!mounted) u(); // Unmounted before listen resolved; unsubscribe immediately
    });
    return () => {
      mounted = false;
      unsub?.();
    };
  }, [readOnly, installFromPath]);

  async function backupAllPlugins() {
    try {
      await invoke<string>("backup_all_plugins");
      addAction("Backup all plugins");
      showToast(t.backupAllDone);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveProfile() {
    try {
      const enabled = plugins.filter((p) => p.enabled).map((p) => p.name);
      const json = JSON.stringify({ name: "Profile", enabled, exportedAt: new Date().toISOString() }, null, 2);
      const path = await save({ defaultPath: "obs-plugin-profile.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        await invoke("write_text_file", { path, contents: json });
        addAction("Profile saved", undefined, "obs-plugin-profile.json");
        showToast(t.profileSaved);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyProfile() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path || typeof path !== "string") return;
      const contents = await invoke<string>("read_text_file", { path });
      const data = JSON.parse(contents);
      const enabledNames: string[] = Array.isArray(data.enabled) ? data.enabled : [];
      const enabledSet = new Set(enabledNames.map((n: string) => n.toLowerCase()));
      for (const plugin of plugins) {
        const shouldEnable = enabledSet.has(plugin.name.toLowerCase());
        if (shouldEnable && !plugin.enabled) {
          await invoke("enable_plugin", { pluginPath: plugin.uninstall_path });
          addAction("Enabled", plugin.name, "profile");
        } else if (!shouldEnable && plugin.enabled) {
          await invoke("disable_plugin", { pluginPath: plugin.uninstall_path });
          addAction("Disabled", plugin.name, "profile");
        }
      }
      addAction("Profile applied", undefined, `${enabledNames.length} enabled`);
        showToast(t.profileApplied);
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportConfig() {
    try {
      const json = await invoke<string>("export_config_json");
      const path = await save({
        defaultPath: "obs-plugin-manager-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, contents: json });
        addAction("Config exported");
        showToast(t.configExported);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function importConfig() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path && typeof path === "string") {
        const contents = await invoke<string>("read_text_file", { path });
        const data = JSON.parse(contents);
        if (data.config) {
          await invoke("set_config", {
            config: {
              custom_plugins_path: data.config.custom_plugins_path ?? null,
              custom_obs_install_path: data.config.custom_obs_install_path ?? null,
              forum_favorites: data.config.forum_favorites ?? [],
              auto_backup: data.config.auto_backup ?? true,
              read_only: data.config.read_only ?? false,
            },
          });
        }
        addAction("Config imported", undefined, "Backup");
        showToast(t.configImported);
        await loadData();
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportPluginsJson() {
    try {
      const json = await invoke<string>("export_plugins_list_json");
      const path = await save({
        defaultPath: "obs-plugins-list.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, contents: json });
        addAction("Export list", undefined, "JSON");
        showToast(t.listExported);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportPluginsCsv() {
    try {
      const csv = await invoke<string>("export_plugins_list_csv");
      const path = await save({
        defaultPath: "obs-plugins-list.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, contents: csv });
        addAction("Export list", undefined, "CSV");
        showToast(t.listExportedCsv);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const homeSearchRef = useRef<HTMLInputElement>(null);
  const discoverSearchRef = useRef<HTMLInputElement>(null);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setToast(null);
        setError(null);
        return;
      }
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        loadData();
        return;
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        if (page === "home") homeSearchRef.current?.focus();
        else if (page === "discover") discoverSearchRef.current?.focus();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        loadData();
      }
      if (e.ctrlKey && e.key === "o" && !e.shiftKey) {
        e.preventDefault();
        openPluginsFolder();
      }
      if (e.ctrlKey && e.key === "1") {
        e.preventDefault();
        setPage("home");
      }
      if (e.ctrlKey && e.key === "2") {
        e.preventDefault();
        setPage("discover");
      }
      if (e.ctrlKey && e.key === "3") {
        e.preventDefault();
        setPage("options");
      }
      if (e.ctrlKey && e.key === "4") {
        e.preventDefault();
        setPage("logs");
      }
      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        setPage("discover");
      }
      if (e.ctrlKey && e.key === "i") {
        e.preventDefault();
        setPage("home");
        importFromFile();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "O") {
        e.preventDefault();
        setPage("options");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loadData, page, openPluginsFolder, importFromFile]);

  const contentRef = useRef<HTMLElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY ?? document.documentElement.scrollTop ?? 0;
      setShowScrollTop(y > 200);
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("sidebar-collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // lang in deps forces nav labels to refresh when language changes
  const NAV_ITEMS: { id: Page; icon: string; label: string }[] = [
    { id: "home",     icon: "ti-home",        label: t.home     },
    { id: "discover", icon: "ti-compass",     label: t.discover },
    { id: "logs",     icon: "ti-list-check",  label: t.logs     },
    { id: "options",  icon: "ti-settings",    label: t.options  },
  ];
  void lang;

  return (
    <div className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
      <aside className="app-sidebar">
        <div className="app-sidebar-logo">
          <img src={logo} alt="LamaWorlds" className="app-sidebar-logo-img" />
          <div className="app-sidebar-logo-text">
            <span className="app-sidebar-brand">LamaWorlds</span>
            <span className="app-sidebar-sub">{t.brandSub}</span>
          </div>
        </div>

        <nav className="app-sidebar-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              type="button"
              className={`app-nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <i className={`ti ${item.icon} app-nav-icon`} aria-hidden="true" />
              <span className="app-nav-label">{item.label}</span>
              {item.id === "home" && pluginUpdates.length > 0 && (
                <span className="app-nav-badge" title={t.updatesAvailableCount(pluginUpdates.length)}>
                  {pluginUpdates.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="app-sidebar-bottom">
          <div
            className="app-obs-status"
            title={obsRunning ? `${t.obsStudio} — ${t.running}` : `${t.obsStudio} — ${t.notRunning}`}
          >
            <span className={`app-obs-dot ${obsRunning ? "app-obs-dot--on" : "app-obs-dot--off"}`} />
            <span className="app-obs-label">OBS {obsRunning ? t.running : t.notRunning}</span>
          </div>
          {readOnly && (
            <div className="app-readonly-badge">
              <i className="ti ti-lock" /> <span>{t.readOnlyBadge}</span>
            </div>
          )}
          <button
            type="button"
            className="app-sidebar-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? t.expandSidebar : t.collapseSidebar}
            aria-label={sidebarCollapsed ? t.expandSidebar : t.collapseSidebar}
          >
            <i className={`ti ${sidebarCollapsed ? "ti-chevron-right" : "ti-chevron-left"}`} />
          </button>
        </div>
      </aside>

      <div className="app-global-toast">
        <Toast message={toast} />
      </div>

      <main className={`app-content ${page === "discover" ? "app-content--wide" : ""}`} ref={contentRef}>
        {error && (
          <div className="alert alert-error app-global-alert">
            <i className="ti ti-alert-circle" />
            <span>{error}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)} aria-label={t.clear}>
              <i className="ti ti-x" />
            </button>
          </div>
        )}

        {page === "home" && (
          <HomePage
            plugins={plugins}
            paths={paths}
            loading={loading}
            searchQuery={searchQuery}
            sortBy={sortBy}
            statusFilter={statusFilter}
            viewMode={viewMode}
            searchInputRef={homeSearchRef}
            onSearchChange={setSearchQuery}
            onSortChange={setSortBy}
            onStatusFilterChange={setStatusFilter}
            onViewModeChange={setViewMode}
            onRefresh={loadData}
            onOpenPluginsFolder={openPluginsFolder}
            onExportPluginsJson={exportPluginsJson}
            onExportPluginsCsv={exportPluginsCsv}
            onInstallFromUrl={installFromUrl}
            onImportFromFile={importFromFile}
            onInstallFromPastePath={installFromPastePath}
            onOpenDownloads={openDownloads}
            importLoading={importLoading}
            importHistory={importHistory}
            onReimportFromHistory={reimportFromHistory}
            onUninstall={uninstallPlugin}
            onDisable={disablePlugin}
            onEnable={enablePlugin}
            onOpenPluginUrl={openPluginUrl}
            onOpenPluginFolder={openPluginFolder}
            obsRunning={obsRunning}
            pathValid={pathValid}
            readOnly={readOnly}
            compactMode={compactMode}
            onCompactModeChange={setCompactMode}
            pluginUpdates={pluginUpdates}
            onUpdatePlugin={updatePluginFromForum}
            updatingPlugins={updatingPlugins}
          />
        )}
        {page === "discover" && (
          <DiscoverPage
            installedPluginNames={plugins.map(p => p.name)}
            favorites={configData?.forum_favorites ?? []}
            searchInputRef={discoverSearchRef}
            onToggleFavorite={toggleFavorite}
            onOpenForum={openForum}
            onOpenPluginUrl={openPluginUrl}
            onInstallFromUrl={installFromUrl}
            onTestForum={testForumConnection}
            readOnly={readOnly}
          />
        )}
        {page === "options" && (
          <OptionsPage
            customPluginsPath={customPluginsPath}
            customObsPath={customObsPath}
            autoBackup={autoBackup}
            onAutoBackupChange={setAutoBackup}
            saving={saving}
            pathErrors={pathErrors}
            onPluginsPathChange={setCustomPluginsPath}
            onObsPathChange={setCustomObsPath}
            onBrowsePlugins={browsePluginsFolder}
            onBrowseObs={browseObsFolder}
            onSave={saveCustomPaths}
            onExport={exportConfig}
            onImport={importConfig}
            readOnly={readOnly}
            onReadOnlyChange={setReadOnly}
            configPath={configPath}
            onOpenLog={openLogFolder}
            onExportFavorites={exportFavoritesList}
            onImportFavorites={importFavoritesList}
            onBackupAll={backupAllPlugins}
            onSaveProfile={saveProfile}
            onApplyProfile={applyProfile}
            theme={theme}
            onThemeChange={setTheme}
            lang={lang}
            onLangChange={(l) => { setLang(l); setLangState(l); }}
          />
        )}
        {page === "logs" && (
          <LogsPage actionLog={actionLog} onOpenLog={openLogFolder} />
        )}
      </main>

      {showScrollTop && (
        <button type="button" className="scroll-top-btn" onClick={scrollToTop} aria-label={t.scrollToTop}>
          <i className="ti ti-arrow-up" />
        </button>
      )}
    </div>
  );
}

export default App;
