/**
 * LamaWorlds OBS Plugin Manager - Main UI
 *
 * Manages OBS plugins: list, install from forum/URL, disable/enable, uninstall.
 * Pages: Home (plugins), Options (config), Discover (forum catalog).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, openFolderDialog } from "./tauriApi";
import { ask, save, open } from "@tauri-apps/plugin-dialog";
import logo from "./image/logo_64x64.png";
import { t, getLang, setLang, type Lang } from "./i18n";
import "./App.css";

interface ObsPluginInfo {
  name: string;
  path: string;
  uninstall_path: string;
  enabled: boolean;
  version: string | null;
  modified_time?: number | null;
}

interface ObsPaths {
  plugins_path: string | null;
  obs_install_path: string | null;
  appdata_plugins: string | null;
  custom_plugins_path: string | null;
  custom_obs_install_path: string | null;
}

interface AppConfig {
  custom_plugins_path?: string | null;
  custom_obs_install_path?: string | null;
  forum_favorites?: string[];
  auto_backup?: boolean;
  read_only?: boolean;
}

interface ForumPlugin {
  id: string;
  title: string;
  url: string;
  category?: string | null;
  download_url?: string | null;
  description?: string | null;
  author?: string | null;
  version?: string | null;
  rating?: string | null;
  rating_count?: string | null;
  downloads?: number | null;
  updated?: string | null;
  icon_url?: string | null;
  prefix?: string | null;
}

interface PluginUpdateInfo {
  plugin_name: string;
  installed_version: string | null;
  available_version: string | null;
  forum_url: string;
}

interface DownloadOption {
  label: string;
  url: string;
  size?: string | null;
  source?: string | null;
}

interface ActionLog {
  id: string;
  action: string;
  plugin?: string;
  details?: string;
  time: string;
  date: string;
}

type Page = "home" | "options" | "discover" | "logs";
type SortBy = "name" | "path" | "date";
type StatusFilter = "all" | "active" | "disabled";
type ViewMode = "list" | "grid";

const OBS_FORUM_PLUGINS_URL = "https://obsproject.com/forum/plugins/";
const MAX_ACTION_LOG = 100;

/** Formats a Unix timestamp (seconds) as locale date string. */
function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Home page: lists installed OBS plugins with search, sort, filter.
 * Shows paths, plugin actions (disable/enable/uninstall), and action history.
 */
function HomePage({
  plugins,
  paths,
  loading,
  searchQuery,
  sortBy,
  statusFilter,
  viewMode,
  searchInputRef,
  onSearchChange,
  onSortChange,
  onStatusFilterChange,
  onViewModeChange,
  onRefresh,
  onOpenPluginsFolder,
  onExportPluginsJson,
  onExportPluginsCsv,
  onInstallFromUrl,
  onImportFromFile,
  onInstallFromPastePath,
  onOpenDownloads,
  importLoading,
  importHistory,
  onReimportFromHistory,
  onUninstall,
  onDisable,
  onEnable,
  onOpenPluginUrl,
  onOpenPluginFolder,
  obsRunning,
  pathValid,
  readOnly,
  compactMode,
  onCompactModeChange,
  toast,
  pluginUpdates,
  onUpdatePlugin,
  updatingPlugins,
}: {
  plugins: ObsPluginInfo[];
  paths: ObsPaths | null;
  loading: boolean;
  searchQuery: string;
  sortBy: SortBy;
  statusFilter: StatusFilter;
  viewMode: ViewMode;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (v: string) => void;
  onSortChange: (v: SortBy) => void;
  onStatusFilterChange: (v: StatusFilter) => void;
  onViewModeChange: (v: ViewMode) => void;
  onRefresh: () => void;
  onOpenPluginsFolder: () => void;
  onExportPluginsJson: () => void;
  onExportPluginsCsv: () => void;
  onInstallFromUrl: (url: string) => void;
  onImportFromFile: () => void;
  onInstallFromPastePath: (path: string) => void;
  onOpenDownloads: () => void;
  importLoading: boolean;
  importHistory: string[];
  onReimportFromHistory: (path: string) => void;
  onUninstall: (plugin: ObsPluginInfo) => void;
  onDisable: (plugin: ObsPluginInfo) => void;
  onEnable: (plugin: ObsPluginInfo) => void;
  onOpenPluginUrl?: (url: string) => void;
  onOpenPluginFolder?: (path: string) => void;
  obsRunning: boolean;
  pathValid: boolean;
  readOnly: boolean;
  compactMode: boolean;
  onCompactModeChange: (v: boolean) => void;
  toast: string | null;
  pluginUpdates?: PluginUpdateInfo[];
  onUpdatePlugin?: (update: PluginUpdateInfo) => void;
  updatingPlugins?: Set<string>;
}) {
  const [installUrl, setInstallUrl] = useState("");
  const [installLoading, setInstallLoading] = useState(false);
  const [pastePath, setPastePath] = useState("");

  const handleInstallFromUrl = useCallback(async () => {
    if (!installUrl.trim()) return;
    setInstallLoading(true);
    try {
      await onInstallFromUrl(installUrl.trim());
      setInstallUrl("");
    } finally {
      setInstallLoading(false);
    }
  }, [installUrl, onInstallFromUrl]);

  const hasPaths =
    paths &&
    (paths.custom_plugins_path ||
      paths.plugins_path ||
      paths.obs_install_path ||
      paths.appdata_plugins ||
      paths.custom_obs_install_path);

  // Filter by status (all/active/disabled), search query, then sort
  const filteredPlugins = useMemo(() => {
    let list = [...plugins];
    if (statusFilter === "active") list = list.filter((p) => p.enabled);
    else if (statusFilter === "disabled") list = list.filter((p) => !p.enabled);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
      );
    }
    if (sortBy === "name")
      list.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
    else if (sortBy === "path")
      list.sort((a, b) => a.path.localeCompare(b.path));
    else if (sortBy === "date")
      list.sort((a, b) => (b.modified_time ?? 0) - (a.modified_time ?? 0));
    return list;
  }, [plugins, searchQuery, sortBy, statusFilter]);

  return (
    <>
      {toast && <div className="toast">{toast}</div>}
      <section className="card home-import-card home-import-top">
        <h2>{t.installFromUrl}</h2>
        <p className="card-desc">{t.installFromUrlDesc}</p>
        <div className="install-url-row">
          <input
            type="url"
            placeholder="https://.../plugin.zip"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            className="input input-sm"
            aria-label="Plugin ZIP or DLL URL"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleInstallFromUrl}
            disabled={!installUrl.trim() || installLoading || readOnly}
          >
            {installLoading ? t.installing : t.install}
          </button>
        </div>
        <div className="install-paste-row">
          <input
            type="text"
            placeholder={t.pastePathHint}
            value={pastePath}
            onChange={(e) => setPastePath(e.target.value)}
            className="input input-sm"
            onKeyDown={(e) => { if (e.key === "Enter") { onInstallFromPastePath(pastePath); setPastePath(""); } }}
          />
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => { onInstallFromPastePath(pastePath); setPastePath(""); }}
            disabled={!pastePath.trim() || readOnly || importLoading}
          >
            {t.install}
          </button>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`drop-zone ${readOnly ? "drop-zone-disabled" : ""} ${importLoading ? "drop-zone-loading" : ""}`}
          onClick={() => !readOnly && !importLoading && onImportFromFile()}
          onKeyDown={(e) => e.key === "Enter" && !readOnly && !importLoading && onImportFromFile()}
          onContextMenu={(e) => {
            e.preventDefault();
            if (readOnly || importLoading) return;
            const menu = document.createElement("div");
            menu.className = "context-menu";
            menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
            const btn = document.createElement("button");
            btn.textContent = t.importFromFile;
            btn.onclick = () => { onImportFromFile(); close(); };
            menu.appendChild(btn);
            const close = () => { menu.remove(); document.removeEventListener("click", close); };
            document.body.appendChild(menu);
            requestAnimationFrame(() => document.addEventListener("click", close));
          }}
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("drop-zone-active"); }}
          onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove("drop-zone-active"); }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("drop-zone-active");
            if (readOnly || importLoading) return;
            const files = Array.from(e.dataTransfer.files);
            files.forEach((f) => {
              if (f.name.endsWith(".zip") || f.name.endsWith(".dll")) {
                onInstallFromPastePath((f as File & { path?: string }).path ?? f.name);
              }
            });
          }}
          title={t.dropZoneHint}
        >
          <span className="drop-zone-icon">📦</span>
          <span>{importLoading ? t.installing : t.dropZoneHint}</span>
        </div>
        <div className="import-extra-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onOpenDownloads}
            title={t.openDownloads}
          >
            {t.openDownloads}
          </button>
        </div>
        {importHistory.length > 0 && (
          <div className="import-history">
            <span className="import-history-label">{t.recentImports}:</span>
            {importHistory.slice(0, 5).map((p: string) => (
              <button
                key={p}
                type="button"
                className="btn btn-ghost btn-xs import-history-item"
                onClick={() => onReimportFromHistory(p)}
                disabled={readOnly || importLoading}
                title={p}
              >
                {p.split(/[/\\]/).pop() || p}
              </button>
            ))}
          </div>
        )}
      </section>
      {(obsRunning || !pathValid) && (
        <div className="alerts">
          {obsRunning && (
            <div className="alert alert-warning">
              {t.obsRunning}
            </div>
          )}
          {hasPaths && !pathValid && (
            <div className="alert alert-error">
              {t.pathNotExist}
            </div>
          )}
        </div>
      )}
      <section className="card paths-card">
        <h2>{t.obsFolders}</h2>
        {hasPaths ? (
          <>
            <div className="paths-grid">
              {paths?.custom_plugins_path && (
                <div className="path-chip path-custom">
                  <span className="path-label">{t.customPlugins}</span>
                  <code>{paths.custom_plugins_path}</code>
                </div>
              )}
              {paths?.plugins_path && (
                <div className="path-chip">
                  <span className="path-label">ProgramData</span>
                  <code>{paths.plugins_path}</code>
                </div>
              )}
              {paths?.appdata_plugins && (
                <div className="path-chip">
                  <span className="path-label">AppData</span>
                  <code>{paths.appdata_plugins}</code>
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onOpenPluginsFolder}
            >
              {t.openFolder}
            </button>
          </>
        ) : (
          <p className="empty-hint">
            {t.noFolderDetected}
          </p>
        )}
      </section>

      <section className="card plugins-card">
        <div className="card-header">
          <h2>{t.installedPlugins} <span className="plugin-count">({plugins.length} installed)</span></h2>
          <div className="toolbar">
            <input
              type="search"
              ref={searchInputRef}
              placeholder={t.search}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search plugins"
              className="input-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => onStatusFilterChange(e.target.value as StatusFilter)}
              className="select-sm"
              aria-label="Filter by status (all, active, disabled)"
            >
              <option value="all">{t.all}</option>
              <option value="active">{t.active}</option>
              <option value="disabled">{t.disabled}</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortBy)}
              className="select-sm"
              aria-label="Sort plugins by name, path, or date"
            >
              <option value="name">{t.name}</option>
              <option value="path">{t.path}</option>
              <option value="date">{t.date}</option>
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={onRefresh} title={t.shortcuts}>
              {t.refresh}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onExportPluginsJson} title="Export list as JSON">
              {t.exportJson}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onExportPluginsCsv} title="Export list as CSV">
              {t.exportCsv}
            </button>
            <div className="view-mode-toggle" role="group" aria-label="View mode">
              <button type="button" className={`btn btn-ghost btn-sm ${viewMode === "list" ? "active" : ""}`} onClick={() => onViewModeChange("list")} title={t.listView}>{t.listView}</button>
              <button type="button" className={`btn btn-ghost btn-sm ${viewMode === "grid" ? "active" : ""}`} onClick={() => onViewModeChange("grid")} title={t.gridView}>{t.gridView}</button>
            </div>
            <label className="compact-toggle" title="Denser list" aria-label="Use compact plugin list">
              <input type="checkbox" checked={compactMode} onChange={(e) => onCompactModeChange(e.target.checked)} />
              <span>{t.compact}</span>
            </label>
          </div>
        </div>
        {loading ? (
          <div className="loading-state">
            <div className="spinner" />
            <span>{t.loading}</span>
          </div>
        ) : filteredPlugins.length > 0 ? (
          <ul className={`plugin-list ${compactMode ? "compact" : ""} view-${viewMode}`}>
            {filteredPlugins.map((plugin) => {
              const updateInfo = pluginUpdates?.find((u) => u.plugin_name === plugin.name);
              return (
              <li
                key={`${plugin.name}-${plugin.path}`}
                className={`plugin-item ${!plugin.enabled ? "disabled" : ""} ${updateInfo ? "has-update" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const menu = document.createElement("div");
                  menu.className = "context-menu";
                  menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
                  const items: { label: string; onClick: () => void }[] = [];
                  if (updateInfo && onUpdatePlugin && !readOnly) {
                    items.unshift({ label: t.updatePlugin, onClick: () => onUpdatePlugin(updateInfo) });
                  }
                  if (updateInfo && onOpenPluginUrl) items.push({ label: t.viewOnForum, onClick: () => onOpenPluginUrl(updateInfo.forum_url) });
                  if (onOpenPluginFolder) items.push({ label: t.openInFolder, onClick: () => onOpenPluginFolder(plugin.path) });
                  if (!readOnly) {
                    if (plugin.enabled) items.push({ label: t.disable, onClick: () => onDisable(plugin) });
                    else items.push({ label: t.enable, onClick: () => onEnable(plugin) });
                    items.push({ label: t.uninstall, onClick: () => onUninstall(plugin) });
                  }
                  items.forEach(({ label, onClick }) => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.textContent = label;
                    btn.onclick = () => { onClick(); menu.remove(); };
                    menu.appendChild(btn);
                  });
                  const close = () => { menu.remove(); document.removeEventListener("click", close); };
                  document.body.appendChild(menu);
                  requestAnimationFrame(() => document.addEventListener("click", close));
                }}
              >
                <div className="plugin-main">
                  <span className="plugin-name">
                    {plugin.name}
                    {plugin.version && (
                      <span className="plugin-version"> v{plugin.version}</span>
                    )}
                    {updateInfo && <span className="badge badge-update" title={t.updatesAvailable}>↑</span>}
                    {!plugin.enabled && (
                      <span className="badge badge-muted">{t.disabled}</span>
                    )}
                  </span>
                  <span className="plugin-path">{plugin.path}</span>
                  {plugin.modified_time && (
                    <span className="plugin-meta">
                      {formatDate(plugin.modified_time)}
                    </span>
                  )}
                </div>
                <div className="plugin-btns">
                  {updateInfo && onUpdatePlugin && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => onUpdatePlugin(updateInfo)}
                      disabled={readOnly || updatingPlugins?.has(plugin.name)}
                      title={t.updatePlugin}
                    >
                      {updatingPlugins?.has(plugin.name) ? t.installing : t.updatePlugin}
                    </button>
                  )}
                  {plugin.enabled ? (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => onDisable(plugin)}
                      disabled={readOnly}
                      title={t.disable}
                    >
                      {t.disable}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-success btn-sm"
                      onClick={() => onEnable(plugin)}
                      disabled={readOnly}
                      title={t.enable}
                    >
                      {t.enable}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => onUninstall(plugin)}
                    disabled={readOnly}
                    title={t.uninstall}
                  >
                    {t.uninstall}
                  </button>
                </div>
              </li>
            );
            })}
          </ul>
        ) : (
          <p className="empty-hint">
            {searchQuery || statusFilter !== "all"
              ? t.noPluginMatch
              : t.noPlugin}
          </p>
        )}
      </section>
    </>
  );
}

type ForumSort = "name" | "id" | "downloads" | "rating";
type ForumCategory = "plugins" | "themes" | "tools" | "scripts";

const PLUGINS_PER_PAGE = 24;

/**
 * Discover page: OBS forum plugins, install from URL, drag-drop, download modal.
 * Fetches/scrapes forum, supports search, favorites, category switching.
 */
function DiscoverPage({
  installedPluginNames,
  favorites,
  searchInputRef,
  onToggleFavorite,
  onOpenForum,
  onOpenPluginUrl,
  onInstallFromUrl,
  onTestForum,
  readOnly,
  toast,
}: {
  installedPluginNames: string[];
  favorites: string[];
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onToggleFavorite: (forumId: string) => void;
  onOpenForum: () => void;
  onOpenPluginUrl: (url: string) => void;
  onInstallFromUrl: (url: string) => void;
  onTestForum: () => void;
  readOnly: boolean;
  toast: string | null;
}) {
  const [forumPlugins, setForumPlugins] = useState<ForumPlugin[]>([]);
  const [forumLoading, setForumLoading] = useState(false);
  const [forumError, setForumError] = useState<string | null>(null);
  const [forumSearch, setForumSearch] = useState("");
  const [forumSort, setForumSort] = useState<ForumSort>("name");
  const [forumCategory, setForumCategory] = useState<ForumCategory>("plugins");
  const [forumFetched, setForumFetched] = useState(false);
  const [searchResults, setSearchResults] = useState<ForumPlugin[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showNotInstalledOnly, setShowNotInstalledOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [downloadModal, setDownloadModal] = useState<{
    plugin: ForumPlugin;
    options: DownloadOption[];
    loading: boolean;
    error?: string;
  } | null>(null);

  const openDownloadModal = useCallback(
    async (plugin: ForumPlugin) => {
      if (readOnly) return;
      setDownloadModal({ plugin, options: [], loading: true });
      try {
        const opts = await invoke<DownloadOption[]>("fetch_plugin_download_options", {
          resourceUrl: plugin.url,
        });
        setDownloadModal((m) => (m ? { ...m, options: opts, loading: false } : null));
      } catch (e) {
        setDownloadModal((m) =>
          m ? { ...m, options: [], loading: false, error: String(e) } : null
        );
      }
    },
    [readOnly]
  );

  const loadForumPlugins = useCallback(async (forceRefresh = false, category?: ForumCategory) => {
    const cat = category ?? forumCategory;
    setForumLoading(true);
    setForumError(null);
    setSearchResults(null);
    try {
      const list = await invoke<ForumPlugin[]>("fetch_forum_plugins", {
        category: cat,
        forceRefresh,
        maxPages: 5,
      });
      setForumPlugins(list);
      setForumFetched(true);
    } catch (e) {
      setForumError(String(e));
      if (!forumFetched) setForumPlugins([]);
    } finally {
      setForumLoading(false);
    }
  }, [forumFetched, forumCategory]);

  // Load forum plugins on mount (run once with default category)
  useEffect(() => {
    loadForumPlugins(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: run once on mount
  }, []);

  const searchForum = useCallback(async () => {
    const q = forumSearch.trim();
    if (!q) return;
    setSearchLoading(true);
    setForumError(null);
    try {
      const list = await invoke<ForumPlugin[]>("search_forum_resources", { keywords: q });
      setSearchResults(list);
    } catch (e) {
      setForumError(String(e));
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [forumSearch]);

  const baseList = searchResults ?? forumPlugins;
  const filteredForumPlugins = useMemo(() => {
    let list = [...baseList];
    if (searchResults === null) {
      if (showFavoritesOnly && favorites.length > 0) {
        const set = new Set(favorites);
        list = list.filter((p) => set.has(p.id));
      }
      if (forumSearch.trim()) {
        const q = forumSearch.toLowerCase().trim();
        list = list.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            (p.author?.toLowerCase().includes(q) ?? false) ||
            p.id.includes(q)
        );
      }
    }
    if (forumSort === "name") {
      list.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
      );
    } else if (forumSort === "downloads") {
      list.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    } else if (forumSort === "rating") {
      list.sort((a, b) => {
        const ra = parseFloat(a.rating ?? "0");
        const rb = parseFloat(b.rating ?? "0");
        return rb - ra;
      });
    } else {
      list.sort((a, b) => Number(b.id) - Number(a.id));
    }
    return list;
  }, [baseList, forumSearch, forumSort, showFavoritesOnly, favorites, searchResults]);

  const topResources = filteredForumPlugins.slice(0, 5);

  const isInstalled = useCallback(
    (title: string) => {
      const lower = title.toLowerCase();
      return installedPluginNames.some(
        (n) => n.toLowerCase() === lower || lower.includes(n.toLowerCase()) || n.toLowerCase().includes(lower)
      );
    },
    [installedPluginNames]
  );

  const filteredForumPluginsWithNotInstalled = useMemo(() => {
    if (!showNotInstalledOnly) return filteredForumPlugins;
    return filteredForumPlugins.filter((p) => !isInstalled(p.title));
  }, [filteredForumPlugins, showNotInstalledOnly, isInstalled]);

  const effectiveFilteredPlugins = filteredForumPluginsWithNotInstalled;
  const totalPagesEffective = Math.max(1, Math.ceil(effectiveFilteredPlugins.length / PLUGINS_PER_PAGE));
  const paginatedPluginsEffective = useMemo(() => {
    const start = (currentPage - 1) * PLUGINS_PER_PAGE;
    return effectiveFilteredPlugins.slice(start, start + PLUGINS_PER_PAGE);
  }, [effectiveFilteredPlugins, currentPage]);

  return (
    <section className="discover-page">
      {toast && <div className="toast">{toast}</div>}
      {downloadModal && (
        <div className="modal-overlay" onClick={() => setDownloadModal(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t.chooseDownload}</h3>
              <span className="modal-plugin-name">{downloadModal.plugin.title}</span>
              <button type="button" className="btn-close" onClick={() => setDownloadModal(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              {downloadModal.loading && (
                <div className="loading-state">
                  <div className="spinner" />
                  <span>{t.loading}</span>
                </div>
              )}
              {downloadModal.error && (
                <div className="alert alert-error">
                  {downloadModal.error}
                  <br />
                  <a href={downloadModal.plugin.url} target="_blank" rel="noopener noreferrer" className="link">
                    Open in browser
                  </a>
                </div>
              )}
              {!downloadModal.loading && !downloadModal.error && downloadModal.options.length > 0 && (
                <ul className="download-options-list">
                  {downloadModal.options.map((opt, i) => (
                    <li key={i} className="download-option">
                      <div className="download-option-info">
                        <span className="download-option-label">{opt.label}</span>
                        {opt.size && <span className="download-option-size">{opt.size}</span>}
                        {opt.source && <span className="download-option-source">{opt.source}</span>}
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={async () => {
                          try {
                            await onInstallFromUrl(opt.url);
                            setDownloadModal(null);
                          } catch (e) {
                            // keep modal open, toast will show error
                          }
                        }}
                      >
                        {t.install}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card discover-forum-card discover-toolbar-card">
        <div className="card-header discover-forum-header">
          <div>
            <h2>{t.forumPlugins}</h2>
            <p className="card-desc">{t.forumDesc}</p>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onOpenForum} title="Open forum in browser">
              {t.openForum}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={searchForum}
              disabled={!forumSearch.trim() || searchLoading}
              title="Search forum and show results in-app"
            >
              {searchLoading ? t.loading : "Search in-app"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const q = forumSearch.trim();
                const url = q
                  ? `https://obsproject.com/forum/search/?type=resource&keywords=${encodeURIComponent(q)}`
                  : "https://obsproject.com/forum/search/?type=resource";
                invoke("open_url", { url });
              }}
              title="Open forum search in browser"
            >
              {t.searchOnForum}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onTestForum} disabled={forumLoading} title="Test connection">
              {t.testForum}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => loadForumPlugins(false)} disabled={forumLoading} title="Use cache (20 min)">
              {t.load}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => loadForumPlugins(true)} disabled={forumLoading}>
              {forumLoading ? t.loading : t.refresh}
            </button>
          </div>
        </div>
      </div>

      {forumLoading && (
        <div className="loading-state discover-loading">
          <div className="spinner" />
          <span>{t.loadForum}</span>
        </div>
      )}

      {forumError && (
        <div className="alert alert-error discover-alert">
          <div className="error-detail">
            <strong>Error:</strong>
            <code className="error-raw">{forumError}</code>
          </div>
          <button type="button" className="btn btn-ghost btn-sm retry-btn" onClick={() => loadForumPlugins(true)}>{t.retry}</button>
        </div>
      )}

      {forumFetched && !forumLoading && !forumError && (
        <div className="discover-layout">
          <aside className="discover-sidebar card">
            <h3 className="sidebar-title">{t.categories}</h3>
            <ul className="sidebar-list">
              {(["plugins", "themes", "tools", "scripts"] as ForumCategory[]).map((cat) => (
                <li
                  key={cat}
                  className={`sidebar-item ${forumCategory === cat ? "active" : ""}`}
                  onClick={() => {
                    setForumCategory(cat);
                    setSearchResults(null);
                    loadForumPlugins(false, cat);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && (setForumCategory(cat), setSearchResults(null), loadForumPlugins(false, cat))}
                >
                  {cat === "plugins" ? "OBS Studio Plugins" : cat.charAt(0).toUpperCase() + cat.slice(1)}
                </li>
              ))}
            </ul>
            <h3 className="sidebar-title">{t.topResources}</h3>
            <ul className="sidebar-top-list">
              {topResources.length === 0 ? (
                <li className="sidebar-top-item empty">{t.clickToLoad}</li>
              ) : (
                topResources.map((p) => (
                  <li key={p.id} className="sidebar-top-item">
                    {p.icon_url ? (
                      <img src={p.icon_url} alt="" className="sidebar-top-icon-img" />
                    ) : (
                      <div className="sidebar-top-icon" />
                    )}
                    <div className="sidebar-top-info">
                      <span className="sidebar-top-name">{p.title}</span>
                      <span className="sidebar-top-meta">{p.author || "—"} · {p.id}</span>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </aside>

          <main className="discover-main">
            <div className="discover-header-row">
              <h1 className="discover-page-title">
                {forumCategory === "plugins" ? "OBS Studio Plugins" : forumCategory.charAt(0).toUpperCase() + forumCategory.slice(1)}
              </h1>
              <span className="discover-live-badge" title="Data from obsproject.com/forum">● Live · obsproject.com</span>
            </div>
            <p className="discover-page-subtitle">
              {forumCategory === "plugins" ? "Plugins for use with OBS Studio." : `OBS ${forumCategory} from the forum.`}
            </p>

            <div className="discover-filters">
              <input
                ref={searchInputRef}
                type="text"
                className="input input-sm discover-search"
                placeholder={t.search}
                value={forumSearch}
                onChange={(e) => { setForumSearch(e.target.value); setCurrentPage(1); }}
                aria-label="Search plugins"
              />
              <label className="forum-filter-favorites" aria-label="Show favorites only">
                <input type="checkbox" checked={showFavoritesOnly} onChange={(e) => setShowFavoritesOnly(e.target.checked)} />
                <span>{t.favorites}</span>
              </label>
              <label className="forum-filter-favorites" aria-label="Show not installed only">
                <input type="checkbox" checked={showNotInstalledOnly} onChange={(e) => { setShowNotInstalledOnly(e.target.checked); setCurrentPage(1); }} />
                <span>{t.notInstalled}</span>
              </label>
              <select className="select-sm" value={forumSort} onChange={(e) => setForumSort(e.target.value as ForumSort)} aria-label="Sort forum resources">
                <option value="name">{t.sortByName}</option>
                <option value="id">{t.sortByRecent}</option>
                <option value="downloads">Sort by downloads</option>
                <option value="rating">Sort by rating</option>
              </select>
            </div>

            <div className="discover-pagination">
              {Array.from({ length: totalPagesEffective }, (_, i) => i + 1).slice(0, 8).map((n) => (
                <button key={n} type="button" className={`pagination-btn ${n === currentPage ? "active" : ""}`} onClick={() => setCurrentPage(n)}>
                  {n}
                </button>
              ))}
              {totalPagesEffective > 8 && <span className="pagination-ellipsis">…</span>}
              <button type="button" className="pagination-btn" onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPagesEffective))} disabled={currentPage >= totalPagesEffective}>
                Next →
              </button>
            </div>

            <div className="forum-resources-grid">
              {filteredForumPlugins.length === 0 ? (
                <p className="empty-hint grid-full">{showFavoritesOnly ? t.noFavorite : t.noForumPlugin}</p>
              ) : (
                paginatedPluginsEffective.map((p) => (
                  <article key={p.id} className="resource-card">
                    <div className="resource-card-header">
                      {p.icon_url ? (
                        <img src={p.icon_url} alt="" className="resource-card-icon" />
                      ) : (
                        <div className="resource-card-icon resource-card-icon-placeholder" />
                      )}
                      <div className="resource-card-title-block">
                        <h3 className="resource-card-title">{p.title}{p.version ? ` ${p.version}` : ""}</h3>
                        <div className="resource-card-meta">
                          {p.prefix && <span className="resource-prefix">{p.prefix}</span>}
                          <span>{p.author || "—"}</span>
                        </div>
                      </div>
                      <div className="resource-card-badges">
                        {isInstalled(p.title) && <span className="badge badge-installed">{t.installed}</span>}
                        <button type="button" className={`btn-icon favorite-btn ${favorites.includes(p.id) ? "is-favorite" : ""}`} onClick={() => onToggleFavorite(p.id)} title={favorites.includes(p.id) ? t.removeFromFav : t.addToFav} aria-label="Favorite">♥</button>
                      </div>
                    </div>
                    {p.description && <p className="resource-card-desc">{p.description}</p>}
                    <div className="resource-card-stats">
                      {p.downloads != null && <span className="resource-stat">↓ {p.downloads.toLocaleString()}</span>}
                      {p.rating && <span className="resource-stat resource-rating">★ {p.rating}{p.rating_count ? ` (${p.rating_count})` : ""}</span>}
                      {p.updated && <span className="resource-stat">Updated {p.updated}</span>}
                    </div>
                    <div className="resource-card-actions">
                      {!readOnly && <button type="button" className="btn btn-primary btn-sm" onClick={() => openDownloadModal(p)}>{t.install}</button>}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(p.url)}>{t.viewOnForum}</button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </main>
        </div>
      )}
    </section>
  );
}

/**
 * Options page: custom paths, auto-backup, read-only, theme, export/import.
 */
function OptionsPage({
  customPluginsPath,
  customObsPath,
  autoBackup,
  onAutoBackupChange,
  readOnly,
  onReadOnlyChange,
  configPath,
  saving,
  pathErrors,
  onPluginsPathChange,
  onObsPathChange,
  onBrowsePlugins,
  onBrowseObs,
  onSave,
  onExport,
  onImport,
  onOpenLog,
  onExportFavorites,
  onImportFavorites,
  onBackupAll,
  onSaveProfile,
  onApplyProfile,
  theme,
  onThemeChange,
  lang,
  onLangChange,
}: {
  customPluginsPath: string;
  customObsPath: string;
  autoBackup: boolean;
  onAutoBackupChange: (v: boolean) => void;
  readOnly: boolean;
  onReadOnlyChange: (v: boolean) => void;
  configPath: string | null;
  saving: boolean;
  pathErrors: { plugins?: string; obs?: string };
  onPluginsPathChange: (v: string) => void;
  onObsPathChange: (v: string) => void;
  onBrowsePlugins: () => void;
  onBrowseObs: () => void;
  onSave: () => void;
  onExport: () => void;
  onImport: () => void;
  onOpenLog: () => void;
  onExportFavorites: () => void;
  onImportFavorites: () => void;
  onBackupAll: () => void;
  onSaveProfile: () => void;
  onApplyProfile: () => void;
  theme: "dark" | "light" | "system";
  onThemeChange: (v: "dark" | "light" | "system") => void;
  lang: Lang;
  onLangChange: (v: Lang) => void;
}) {
  return (
    <section className="options-page card">
      <h2>{t.customPaths}</h2>
      <p>{t.customPathsDesc}</p>
      <div className="form-group">
        <label>{t.pluginsFolder}</label>
        <div className="input-row">
          <input
            type="text"
            value={customPluginsPath}
            onChange={(e) => onPluginsPathChange(e.target.value)}
            placeholder="C:\ProgramData\obs-studio\plugins"
            className={`input ${pathErrors.plugins ? "input-error" : ""}`}
          />
          <button type="button" className="btn btn-ghost" onClick={onBrowsePlugins}>
            {t.browse}
          </button>
        </div>
        {pathErrors.plugins && <span className="field-error">{pathErrors.plugins}</span>}
      </div>
      <div className="form-group">
        <label>{t.obsInstallFolder}</label>
        <div className="input-row">
          <input
            type="text"
            value={customObsPath}
            onChange={(e) => onObsPathChange(e.target.value)}
            placeholder="C:\Program Files\obs-studio"
            className={`input ${pathErrors.obs ? "input-error" : ""}`}
          />
          <button type="button" className="btn btn-ghost" onClick={onBrowseObs}>
            {t.browse}
          </button>
        </div>
        {pathErrors.obs && <span className="field-error">{pathErrors.obs}</span>}
      </div>
      <div className="form-group options-checkbox">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={autoBackup}
            onChange={(e) => onAutoBackupChange(e.target.checked)}
          />
          <span>{t.autoBackup}</span>
        </label>
        <p className="option-hint">{t.autoBackupDesc}</p>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onSave}
        disabled={saving || !!(pathErrors.plugins || pathErrors.obs)}
      >
        {saving ? t.saving : t.save}
      </button>

      <hr className="options-separator" />

      <h2>{t.backupAll}</h2>
      <p className="option-hint">{t.backupAllDesc}</p>
      <div className="btn-row options-export-row">
        <button type="button" className="btn btn-ghost" onClick={onBackupAll}>
          {t.backupAll}
        </button>
      </div>

      <hr className="options-separator" />

      <h2>{t.profiles}</h2>
      <p className="option-hint">{t.profilesDesc}</p>
      <div className="btn-row options-export-row">
        <button type="button" className="btn btn-ghost" onClick={onSaveProfile} disabled={readOnly}>
          {t.saveProfile}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onApplyProfile} disabled={readOnly}>
          {t.applyProfile}
        </button>
      </div>

      <hr className="options-separator" />

      <h2>{t.backupRestore}</h2>
      <p className="option-hint">{t.backupRestoreDesc}</p>
      <div className="btn-row options-export-row">
        <button type="button" className="btn btn-ghost" onClick={onExport}>
          {t.exportConfig}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onImport}>
          {t.importConfig}
        </button>
      </div>

      <hr className="options-separator" />

      <h2>Debug</h2>
      <p className="option-hint">{t.configPath}: <code className="config-path">{configPath || "—"}</code></p>
      <div className="btn-row options-export-row">
        <button type="button" className="btn btn-ghost" onClick={onOpenLog}>
          {t.openLog}
        </button>
      </div>

      <hr className="options-separator" />

      <h2>{t.theme}</h2>
      <div className="form-group options-checkbox">
        <div className="btn-row">
          <button
            type="button"
            className={`btn ${theme === "dark" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onThemeChange("dark")}
          >
            {t.darkMode}
          </button>
          <button
            type="button"
            className={`btn ${theme === "light" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onThemeChange("light")}
          >
            {t.lightMode}
          </button>
          <button
            type="button"
            className={`btn ${theme === "system" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onThemeChange("system")}
          >
            {t.systemTheme}
          </button>
        </div>
      </div>

      <h2>{t.language}</h2>
      <div className="form-group options-checkbox">
        <select
          value={lang}
          onChange={(e) => onLangChange(e.target.value as Lang)}
          className="select-sm"
          aria-label="Language"
        >
          <option value="en">English</option>
          <option value="fr">Français</option>
        </select>
      </div>

      <hr className="options-separator" />

      <h2>Advanced</h2>
      <div className="form-group options-checkbox">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => onReadOnlyChange(e.target.checked)}
          />
          <span>{t.readOnly}</span>
        </label>
        <p className="option-hint">{t.readOnlyDesc}</p>
      </div>
      <div className="btn-row options-export-row">
        <button type="button" className="btn btn-ghost" onClick={onExportFavorites}>
          {t.exportFavorites}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onImportFavorites}>
          {t.importFavorites}
        </button>
      </div>
    </section>
  );
}

/**
 * Logs page: action history (detailed) and backend log file.
 */
function LogsPage({
  actionLog,
  onOpenLog,
}: {
  actionLog: ActionLog[];
  onOpenLog: () => void;
}) {
  const [backendLog, setBackendLog] = useState<string | null>(null);
  const [backendLogError, setBackendLogError] = useState<string | null>(null);
  const [backendLogLoading, setBackendLogLoading] = useState(true);
  const [logDir, setLogDir] = useState<string | null>(null);

  const loadBackendLog = useCallback(() => {
    setBackendLogLoading(true);
    setBackendLogError(null);
    invoke<string>("read_log_file")
      .then(setBackendLog)
      .catch((e) => setBackendLogError(String(e)))
      .finally(() => setBackendLogLoading(false));
  }, []);

  useEffect(() => {
    loadBackendLog();
    invoke<string | null>("get_config_dir")
      .then((dir) => setLogDir(dir ?? null))
      .catch(() => setLogDir(null));
  }, [loadBackendLog, actionLog]);

  return (
    <section className="logs-page-container">
      <div className="card logs-page">
        <div className="logs-page-header">
          <h2>{t.actionHistory}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
            {t.openLog}
          </button>
        </div>
        {actionLog.length > 0 ? (
          <ul className="logs-list logs-list-detailed">
            {actionLog.map((a) => (
              <li key={a.id} className="logs-item logs-item-detailed">
                <span className="logs-datetime" title={a.date}>
                  {a.date} {a.time}
                </span>
                <span className="logs-action">{a.action}</span>
                {a.plugin && <span className="logs-plugin">{a.plugin}</span>}
                {a.details && (
                  <span className="logs-details" title={a.details}>
                    {a.details.length > 80 ? `${a.details.slice(0, 80)}…` : a.details}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-hint">{t.noRecentAction}</p>
        )}
      </div>

      <div className="card logs-backend">
        <div className="logs-page-header">
          <h2>{t.backendLog}</h2>
          <div className="logs-backend-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadBackendLog}>
              {t.refresh}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
              {t.openLog}
            </button>
          </div>
        </div>
        {backendLogError && (
          <p className="alert alert-error">{backendLogError}</p>
        )}
        {logDir && (
          <p className="empty-hint config-path">
            {t.logPath}: <code>{logDir}</code>
          </p>
        )}
        {backendLogLoading ? (
          <div className="loading-state">
            <div className="spinner" />
            <span>{t.loading}</span>
          </div>
        ) : !backendLogError && backendLog?.trim() ? (
          <pre className="logs-backend-content">{backendLog}</pre>
        ) : !backendLogError ? (
          <p className="empty-hint">{t.logEmpty}</p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Main App: routing (Home/Discover/Options/Logs), global state, Tauri IPC.
 */
function App() {
  const [page, setPage] = useState<Page>("home");
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
          if (!ok) errs.plugins = "This folder does not exist.";
        } catch {
          errs.plugins = "Unable to verify.";
        }
      }
      if (customObsPath.trim()) {
        try {
          const ok = await invoke<boolean>("validate_path", {
            path: customObsPath.trim(),
          });
          if (!ok) errs.obs = "This folder does not exist.";
        } catch {
          errs.obs = "Unable to verify.";
        }
      }
      setPathErrors(errs);
    };
    const timeoutId = setTimeout(validatePaths, 400);
    return () => clearTimeout(timeoutId);
  }, [customPluginsPath, customObsPath]);

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
        showToast(`Forum OK: ${result.count ?? 0} plugins found.`);
      } else {
        showToast(`Forum error: ${result.error ?? "unknown"}`);
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
        { title: "Confirm", kind: "warning" }
      );
    } catch {
      ok = window.confirm(`Uninstall "${plugin.name}"?`);
    }
    if (!ok) return;
    try {
      if (plugin.path === plugin.uninstall_path) {
        try {
          await invoke("backup_plugin_folder", { pluginPath: plugin.path });
          addAction("Backup created", plugin.name, plugin.path);
        } catch {
          // continue without backup
        }
      }
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
        setError(`No download found for "${update.plugin_name}"`);
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

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="app" ref={contentRef}>
      <header className="header">
        <img src={logo} alt="LamaWorlds" className="header-logo" />
        <div className="header-text">
          <h1>LamaWorlds OBS Plugin Manager</h1>
          <p className="subtitle">{t.subtitle}</p>
        </div>
        <button
          type="button"
          className="header-options-btn"
          onClick={() => setPage("options")}
          title={t.options}
          aria-label={t.options}
        >
          ⚙
        </button>
      </header>

      <nav className="nav-tabs" role="navigation" aria-label="Main navigation">
        <button
          type="button"
          className={`nav-tab ${page === "home" ? "active" : ""}`}
          onClick={() => setPage("home")}
          aria-current={page === "home" ? "page" : undefined}
          aria-label="Home"
        >
          {t.home}
        </button>
        <button
          type="button"
          className={`nav-tab ${page === "discover" ? "active" : ""}`}
          onClick={() => setPage("discover")}
          title={t.shortcuts}
          aria-current={page === "discover" ? "page" : undefined}
          aria-label="Discover"
        >
          {t.discover}
        </button>
        <button
          type="button"
          className={`nav-tab ${page === "logs" ? "active" : ""}`}
          onClick={() => setPage("logs")}
          aria-current={page === "logs" ? "page" : undefined}
          aria-label="Logs"
        >
          {t.logs}
        </button>
      </nav>

      {pluginUpdates.length > 0 && (
        <div className="alert alert-warning plugin-updates-alert">
          <strong>{t.updatesAvailable}:</strong>{" "}
          {pluginUpdates.map((u) => (
            <span key={u.plugin_name} className="plugin-update-item">
              <span>{u.plugin_name}</span>
              {u.installed_version && <span className="version-diff">v{u.installed_version} → v{u.available_version ?? "?"}</span>}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => updatePluginFromForum(u)}
                disabled={readOnly || updatingPlugins.has(u.plugin_name)}
              >
                {updatingPlugins.has(u.plugin_name) ? t.installing : t.updatePlugin}
              </button>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => openPluginUrl(u.forum_url)}>
                {t.viewOnForum}
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setPage("discover")}>
                {t.viewInDiscover}
              </button>
            </span>
          ))}
        </div>
      )}
      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      )}

      <div className={`content ${page === "discover" ? "content--discover" : ""}`}>
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
            toast={toast}
            pluginUpdates={pluginUpdates}
            onUpdatePlugin={updatePluginFromForum}
            updatingPlugins={updatingPlugins}
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
            toast={toast}
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
      </div>

      {showScrollTop && (
        <button
          type="button"
          className="scroll-top-btn"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          ↑
        </button>
      )}
    </main>
  );
}

export default App;
