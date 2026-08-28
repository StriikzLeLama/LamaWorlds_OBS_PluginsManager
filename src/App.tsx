/**
 * App shell: sidebar navigation, page routing, and Tauri command orchestration.
 *
 * Pages keep UI only; this file owns plugin/config state and talks to the Rust backend.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import {
  OBS_FORUM_PLUGINS_URL,
  MAX_ACTION_LOG,
  IMPORT_HISTORY_KEY,
  MAX_IMPORT_HISTORY,
  PATH_VALIDATE_DEBOUNCE_MS,
  SIDEBAR_COLLAPSED_KEY,
} from "./types";
import { HomePage, OptionsPage, LogsPage, DiscoverPage } from "./pages";
import { Toast } from "./components/Toast";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { readStorage, writeStorage, readJson } from "./utils/storage";
import "./App.css";

function App() {
  const [page, setPage] = useState<Page>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStorage(SIDEBAR_COLLAPSED_KEY) === "1",
  );
  const [plugins, setPlugins] = useState<ObsPluginInfo[]>([]);
  const [paths, setPaths] = useState<ObsPaths | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [lang, setLangState] = useState<Lang>(getLang);
  const [pluginUpdates, setPluginUpdates] = useState<PluginUpdateInfo[]>([]);
  const [updatingPlugins, setUpdatingPlugins] = useState<Set<string>>(new Set());
  const [importHistory, setImportHistory] = useState<string[]>(() =>
    readJson<string[]>(IMPORT_HISTORY_KEY, []),
  );
  const [importLoading, setImportLoading] = useState(false);
  /** Path of OBS's own modules.json; null when OBS is older than 32. */
  const [obsModulesPath, setObsModulesPath] = useState<string | null>(null);

  const { theme, setTheme } = useTheme();
  const { toast, showToast, clearToast } = useToast();
  const homeSearchRef = useRef<HTMLInputElement>(null);
  const discoverSearchRef = useRef<HTMLInputElement>(null);

  /**
   * Run a Tauri/async action. `{ ok: false }` means the error banner was already set.
   * Use this instead of comparing the payload to `undefined` — void commands return `null`.
   */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      setError(String(e));
      return { ok: false };
    }
  }, []);

  const addToImportHistory = useCallback((path: string) => {
    setImportHistory((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_IMPORT_HISTORY);
      writeStorage(IMPORT_HISTORY_KEY, JSON.stringify(next));
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

  const currentConfig = useCallback(
    (): AppConfig => ({
      custom_plugins_path: customPluginsPath.trim() || null,
      custom_obs_install_path: customObsPath.trim() || null,
      forum_favorites: configData?.forum_favorites ?? [],
      auto_backup: autoBackup,
      read_only: readOnly,
    }),
    [customPluginsPath, customObsPath, configData, autoBackup, readOnly],
  );

  /**
   * Persists a Behavior switch straight away: those toggles sit in their own
   * section with no Save button, so without this the backend keeps using the
   * previous value and the UI silently disagrees with it.
   *
   * Built from the last saved config rather than the path inputs, which have
   * their own Save button and may hold unsaved edits.
   */
  const persistBehavior = useCallback(
    async (patch: { auto_backup?: boolean; read_only?: boolean }) => {
      const base = configData;
      const next: AppConfig = {
        custom_plugins_path: base?.custom_plugins_path ?? null,
        custom_obs_install_path: base?.custom_obs_install_path ?? null,
        forum_favorites: base?.forum_favorites ?? [],
        auto_backup: autoBackup,
        read_only: readOnly,
        ...patch,
      };
      const result = await run(() => invoke("set_config", { config: next }));
      if (result.ok) setConfigData(next);
    },
    [configData, autoBackup, readOnly, run],
  );

  const handleAutoBackupChange = useCallback(
    (value: boolean) => {
      setAutoBackup(value);
      void persistBehavior({ auto_backup: value });
    },
    [persistBehavior],
  );

  const handleReadOnlyChange = useCallback(
    (value: boolean) => {
      setReadOnly(value);
      void persistBehavior({ read_only: value });
    },
    [persistBehavior],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pluginsList, pathsData, config, obsRun, valid, cfgDir, modulesPath] =
        await Promise.all([
          invoke<ObsPluginInfo[]>("list_obs_plugins"),
          invoke<ObsPaths>("get_obs_paths"),
          invoke<AppConfig>("get_config"),
          invoke<boolean>("is_obs_running"),
          invoke<boolean>("check_paths_valid"),
          invoke<string | null>("get_config_dir").catch(() => null),
          invoke<string | null>("get_obs_modules_path").catch(() => null),
        ]);
      setPlugins(pluginsList);
      setPaths(pathsData);
      setConfigData(config);
      setAutoBackup(config.auto_backup ?? true);
      setReadOnly(config.read_only ?? false);
      setConfigPath(cfgDir ?? null);
      setObsModulesPath(modulesPath ?? null);
      setCustomPluginsPath(config.custom_plugins_path ?? "");
      setCustomObsPath(config.custom_obs_install_path ?? "");
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
    void loadData();
  }, [loadData]);

  const checkPluginUpdates = useCallback(async () => {
    try {
      setPluginUpdates(await invoke<PluginUpdateInfo[]>("check_plugin_updates"));
    } catch {
      setPluginUpdates([]);
    }
  }, []);

  useEffect(() => {
    void checkPluginUpdates();
  }, [checkPluginUpdates, plugins]);

  // Debounced existence check for custom OBS paths typed in Options.
  useEffect(() => {
    const validate = async () => {
      const errs: { plugins?: string; obs?: string } = {};
      for (const [key, value] of [
        ["plugins", customPluginsPath],
        ["obs", customObsPath],
      ] as const) {
        if (!value.trim()) continue;
        try {
          const ok = await invoke<boolean>("validate_path", { path: value.trim() });
          if (!ok) errs[key] = t.pathDoesNotExist;
        } catch {
          errs[key] = t.unableToVerify;
        }
      }
      setPathErrors(errs);
    };
    const id = setTimeout(validate, PATH_VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [customPluginsPath, customObsPath, lang]);

  async function saveCustomPaths() {
    if (pathErrors.plugins || pathErrors.obs) return;
    setSaving(true);
    setError(null);
    const result = await run(async () => {
      await invoke("set_config", { config: currentConfig() });
      await loadData();
    });
    if (result.ok) {
      addAction("Options saved");
      showToast(t.optionsSaved);
    }
    setSaving(false);
  }

  async function toggleFavorite(forumId: string) {
    const current = configData?.forum_favorites ?? [];
    const next = current.includes(forumId)
      ? current.filter((id) => id !== forumId)
      : [...current, forumId];
    await run(async () => {
      await invoke("set_favorites", { ids: next });
      setConfigData((prev) => (prev ? { ...prev, forum_favorites: next } : null));
    });
  }

  async function exportFavoritesList() {
    await run(async () => {
      const json = JSON.stringify(
        { favorites: configData?.forum_favorites ?? [], exportedAt: new Date().toISOString() },
        null,
        2,
      );
      const path = await save({
        defaultPath: "obs-forum-favorites.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: json });
      addAction("Export favorites");
      showToast(t.favoritesExported);
    });
  }

  async function importFavoritesList() {
    await run(async () => {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path || typeof path !== "string") return;
      const contents = await invoke<string>("read_text_file", { path });
      const data = JSON.parse(contents);
      if (!Array.isArray(data.favorites)) return;
      await invoke("set_favorites", { ids: data.favorites });
      setConfigData((prev) => (prev ? { ...prev, forum_favorites: data.favorites } : null));
      addAction("Import favorites");
      showToast(t.favoritesImported);
    });
  }

  async function browsePluginsFolder() {
    await run(async () => {
      const selected = await openFolderDialog("Select OBS plugins folder");
      if (selected) setCustomPluginsPath(selected);
    });
  }

  async function browseObsFolder() {
    await run(async () => {
      const selected = await openFolderDialog("Select OBS folder");
      if (selected) setCustomObsPath(selected);
    });
  }

  const openPluginsFolder = useCallback(async () => {
    await run(() => invoke("open_plugins_folder"));
  }, [run]);

  const openPluginFolder = useCallback(
    async (path: string) => {
      await run(() => invoke("open_plugins_folder", { folderOverride: path }));
    },
    [run],
  );

  async function testForumConnection() {
    await run(async () => {
      const result = await invoke<{ ok: boolean; count?: number; error?: string }>("test_forum_connection");
      showToast(result.ok ? t.forumOk(result.count ?? 0) : t.forumError(result.error ?? "unknown"));
    });
  }

  async function openForum() {
    await run(() => invoke("open_url", { url: OBS_FORUM_PLUGINS_URL }));
  }

  async function openPluginUrl(url: string) {
    await run(() => invoke("open_url", { url }));
  }

  async function disablePlugin(plugin: ObsPluginInfo) {
    if (!plugin.enabled) return;
    const result = await run(() => invoke("disable_plugin", { pluginPath: plugin.uninstall_path }));
    if (!result.ok) return;
    addAction("Disabled", plugin.name, plugin.path);
    showToast(t.disabledPlugin(plugin.name));
    await loadData();
  }

  async function enablePlugin(plugin: ObsPluginInfo) {
    if (plugin.enabled) return;
    const result = await run(() => invoke("enable_plugin", { pluginPath: plugin.uninstall_path }));
    if (!result.ok) return;
    addAction("Enabled", plugin.name, plugin.path);
    showToast(t.enabledPlugin(plugin.name));
    await loadData();
  }

  async function uninstallPlugin(plugin: ObsPluginInfo) {
    let confirmed = false;
    try {
      confirmed = await ask(t.confirmUninstall(plugin.name), { title: t.confirm, kind: "warning" });
    } catch {
      confirmed = window.confirm(t.confirmUninstall(plugin.name));
    }
    if (!confirmed) return;
    // Backup is created by the Rust backend when auto_backup is enabled.
    const result = await run(() => invoke("uninstall_plugin", { uninstallPath: plugin.uninstall_path }));
    if (!result.ok) return;
    addAction("Uninstalled", plugin.name, plugin.path);
    showToast(t.uninstalledPlugin(plugin.name));
    await loadData();
  }

  async function installFromUrl(url: string) {
    const result = await run(() =>
      invoke<{ name: string; updated: boolean }>("install_plugin_from_url", { url }),
    );
    if (!result.ok) return;
    const res = result.value;
    addAction(res.updated ? "Updated" : "Installed", res.name, "from URL");
    showToast(res.updated ? t.updatedPlugin(res.name) : t.installedPlugin(res.name));
    await loadData();
    await checkPluginUpdates();
  }

  const updatePluginFromForum = useCallback(
    async (update: PluginUpdateInfo) => {
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
    },
    [readOnly, obsRunning, addAction, showToast, loadData, checkPluginUpdates],
  );

  const installFromPath = useCallback(
    async (path: string) => {
      const result = await run(() =>
        invoke<{ name: string; updated: boolean }>("install_plugin_from_path", { path }),
      );
      if (!result.ok) return;
      const res = result.value;
      addAction(res.updated ? "Updated" : "Installed", res.name, path);
      showToast(res.updated ? t.updatedPlugin(res.name) : t.installedPlugin(res.name));
      await loadData();
    },
    [run, addAction, showToast, loadData],
  );

  const importFromFile = useCallback(async () => {
    setImportLoading(true);
    await run(async () => {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Plugin (.zip, .dll)", extensions: ["zip", "dll"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      const paths = selected
        ? (Array.isArray(selected) ? selected : [selected]).filter(
            (p): p is string => typeof p === "string",
          )
        : [];
      for (const p of paths) {
        await installFromPath(p);
        addToImportHistory(p);
      }
    });
    setImportLoading(false);
  }, [run, installFromPath, addToImportHistory]);

  const installFromPastePath = useCallback(
    async (pathInput: string) => {
      const p = pathInput.trim().replace(/^["']|["']$/g, "");
      if (!p) return;
      setImportLoading(true);
      await installFromPath(p);
      addToImportHistory(p);
      setImportLoading(false);
    },
    [installFromPath, addToImportHistory],
  );

  const openDownloads = useCallback(async () => {
    await run(() => invoke("open_downloads_folder"));
  }, [run]);

  const reimportFromHistory = useCallback(
    async (path: string) => {
      setImportLoading(true);
      await installFromPath(path);
      setImportLoading(false);
    },
    [installFromPath],
  );

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let mounted = true;
    listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
      const dropped = event.payload?.paths;
      if (!dropped?.length || readOnly) return;
      // Sequential on purpose: each install mutates the same plugins folder and
      // then refreshes the list, so running them in parallel interleaves both.
      void (async () => {
        setImportLoading(true);
        try {
          for (const droppedPath of dropped) {
            await installFromPath(droppedPath);
            addToImportHistory(droppedPath);
          }
        } finally {
          setImportLoading(false);
        }
      })();
    }).then((u) => {
      unsub = u;
      if (!mounted) u();
    });
    return () => {
      mounted = false;
      unsub?.();
    };
  }, [readOnly, installFromPath, addToImportHistory]);

  async function backupAllPlugins() {
    const result = await run(() => invoke<string>("backup_all_plugins"));
    if (!result.ok) return;
    addAction("Backup all plugins");
    showToast(t.backupAllDone);
  }

  async function saveProfile() {
    await run(async () => {
      const enabled = plugins.filter((p) => p.enabled).map((p) => p.name);
      const json = JSON.stringify(
        { name: "Profile", enabled, exportedAt: new Date().toISOString() },
        null,
        2,
      );
      const path = await save({
        defaultPath: "obs-plugin-profile.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: json });
      addAction("Profile saved", undefined, "obs-plugin-profile.json");
      showToast(t.profileSaved);
    });
  }

  async function applyProfile() {
    await run(async () => {
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
    });
  }

  async function exportConfig() {
    await run(async () => {
      const json = await invoke<string>("export_config_json");
      const path = await save({
        defaultPath: "obs-plugin-manager-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: json });
      addAction("Config exported");
      showToast(t.configExported);
    });
  }

  async function importConfig() {
    await run(async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;
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
    });
  }

  async function exportPluginsJson() {
    await run(async () => {
      const json = await invoke<string>("export_plugins_list_json");
      const path = await save({
        defaultPath: "obs-plugins-list.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: json });
      addAction("Export list", undefined, "JSON");
      showToast(t.listExported);
    });
  }

  async function exportPluginsCsv() {
    await run(async () => {
      const csv = await invoke<string>("export_plugins_list_csv");
      const path = await save({
        defaultPath: "obs-plugins-list.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, contents: csv });
      addAction("Export list", undefined, "CSV");
      showToast(t.listExportedCsv);
    });
  }

  /**
   * Flips a plugin in OBS's own plugin manager rather than renaming its folder,
   * so the app and OBS agree. A plugin can ship several modules; all are set.
   */
  const setModuleEnabled = useCallback(
    async (plugin: ObsPluginInfo, enabled: boolean) => {
      const modules = plugin.module_names ?? [];
      if (modules.length === 0) return;
      const result = await run(async () => {
        for (const moduleName of modules) {
          await invoke("set_module_enabled", { moduleName, enabled });
        }
      });
      if (!result.ok) return;
      addAction(enabled ? "Enabled" : "Disabled", plugin.name, "OBS module list");
      showToast(enabled ? t.enabledPlugin(plugin.name) : t.disabledPlugin(plugin.name));
      await loadData();
    },
    [run, addAction, showToast, loadData],
  );

  const clearAlerts = useCallback(() => {
    clearToast();
    setError(null);
  }, [clearToast]);

  const focusSearch = useCallback(() => {
    if (page === "home") homeSearchRef.current?.focus();
    else if (page === "discover") discoverSearchRef.current?.focus();
  }, [page]);

  useKeyboardShortcuts({
    onRefresh: loadData,
    onClearAlerts: clearAlerts,
    onFocusSearch: focusSearch,
    onOpenPluginsFolder: openPluginsFolder,
    onImport: importFromFile,
    onSetPage: setPage,
  });

  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop((window.scrollY ?? 0) > 200);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeStorage(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  // `lang` is a dependency so nav labels refresh after setLang().
  const navItems = useMemo(
    () => [
      { id: "home" as const, icon: "ti-home", label: t.home },
      { id: "discover" as const, icon: "ti-compass", label: t.discover },
      { id: "logs" as const, icon: "ti-list-check", label: t.logs },
      { id: "options" as const, icon: "ti-settings", label: t.options },
    ],
    [lang],
  );

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
          {navItems.map((item) => (
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

      <main className={`app-content ${page === "discover" ? "app-content--wide" : ""}`}>
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
            obsModulesAvailable={obsModulesPath !== null}
            onSetModuleEnabled={setModuleEnabled}
          />
        )}
        {page === "discover" && (
          <DiscoverPage
            installedPluginNames={plugins.map((p) => p.name)}
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
            onAutoBackupChange={handleAutoBackupChange}
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
            onReadOnlyChange={handleReadOnlyChange}
            configPath={configPath}
            obsModulesPath={obsModulesPath}
            onOpenLog={() => void run(() => invoke("open_log_folder"))}
            onExportFavorites={exportFavoritesList}
            onImportFavorites={importFavoritesList}
            onBackupAll={backupAllPlugins}
            onSaveProfile={saveProfile}
            onApplyProfile={applyProfile}
            theme={theme}
            onThemeChange={setTheme}
            lang={lang}
            onLangChange={(l) => {
              setLang(l);
              setLangState(l);
            }}
          />
        )}
        {page === "logs" && (
          <LogsPage actionLog={actionLog} onOpenLog={() => void run(() => invoke("open_log_folder"))} />
        )}
      </main>

      {showScrollTop && (
        <button
          type="button"
          className="scroll-top-btn"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label={t.scrollToTop}
        >
          <i className="ti ti-arrow-up" />
        </button>
      )}
    </div>
  );
}

export default App;
