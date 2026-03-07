/**
 * LamaWorlds OBS Addon Manager - Main UI
 *
 * Manages OBS plugins: list, install from forum/URL, disable/enable, uninstall.
 * Pages: Home (plugins), Options (config), Discover (forum catalog).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke, openFolderDialog } from "./tauriApi";
import { ask, save, open } from "@tauri-apps/plugin-dialog";
import logo from "./image/logo_64x64.png";
import { t } from "./i18n";
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
  time: string;
}

type Page = "home" | "options" | "discover";
type SortBy = "name" | "path" | "date";
type StatusFilter = "all" | "active" | "disabled";

const OBS_FORUM_PLUGINS_URL = "https://obsproject.com/forum/plugins/";
const MAX_ACTION_LOG = 20;

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function HomePage({
  plugins,
  paths,
  loading,
  searchQuery,
  sortBy,
  statusFilter,
  searchInputRef,
  onSearchChange,
  onSortChange,
  onStatusFilterChange,
  onRefresh,
  onOpenPluginsFolder,
  onExportPluginsJson,
  onExportPluginsCsv,
  onUninstall,
  onDisable,
  onEnable,
  obsRunning,
  pathValid,
  readOnly,
  compactMode,
  onCompactModeChange,
  actionLog,
  toast,
}: {
  plugins: ObsPluginInfo[];
  paths: ObsPaths | null;
  loading: boolean;
  searchQuery: string;
  sortBy: SortBy;
  statusFilter: StatusFilter;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (v: string) => void;
  onSortChange: (v: SortBy) => void;
  onStatusFilterChange: (v: StatusFilter) => void;
  onRefresh: () => void;
  onOpenPluginsFolder: () => void;
  onExportPluginsJson: () => void;
  onExportPluginsCsv: () => void;
  onUninstall: (plugin: ObsPluginInfo) => void;
  onDisable: (plugin: ObsPluginInfo) => void;
  onEnable: (plugin: ObsPluginInfo) => void;
  obsRunning: boolean;
  pathValid: boolean;
  readOnly: boolean;
  compactMode: boolean;
  onCompactModeChange: (v: boolean) => void;
  actionLog: ActionLog[];
  toast: string | null;
}) {
  const hasPaths =
    paths &&
    (paths.custom_plugins_path ||
      paths.plugins_path ||
      paths.obs_install_path ||
      paths.appdata_plugins ||
      paths.custom_obs_install_path);

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
            >
              <option value="all">{t.all}</option>
              <option value="active">{t.active}</option>
              <option value="disabled">{t.disabled}</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortBy)}
              className="select-sm"
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
            <label className="compact-toggle" title="Denser list">
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
          <ul className={`plugin-list ${compactMode ? "compact" : ""}`}>
            {filteredPlugins.map((plugin) => (
              <li
                key={`${plugin.name}-${plugin.path}`}
                className={`plugin-item ${!plugin.enabled ? "disabled" : ""}`}
              >
                <div className="plugin-main">
                  <span className="plugin-name">
                    {plugin.name}
                    {plugin.version && (
                      <span className="plugin-version"> v{plugin.version}</span>
                    )}
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
            ))}
          </ul>
        ) : (
          <p className="empty-hint">
            {searchQuery || statusFilter !== "all"
              ? t.noPluginMatch
              : t.noPlugin}
          </p>
        )}
      </section>

      <section className="card actions-card">
        <h2>{t.actionHistory}</h2>
        {actionLog.length > 0 ? (
          <ul className="action-list">
            {actionLog.map((a) => (
              <li key={a.id} className="action-item">
                <span className="action-text">{a.action}</span>
                {a.plugin && <span className="action-plugin">{a.plugin}</span>}
                <span className="action-time">{a.time}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-hint">{t.noRecentAction}</p>
        )}
      </section>
    </>
  );
}

type ForumSort = "name" | "id" | "downloads" | "rating";
type ForumCategory = "plugins" | "themes" | "tools" | "scripts";

const PLUGINS_PER_PAGE = 12;

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
  const [installUrl, setInstallUrl] = useState("");
  const [installLoading, setInstallLoading] = useState(false);
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
          resource_url: plugin.url,
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
        maxPages: 3,
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

  const totalPages = Math.max(1, Math.ceil(filteredForumPlugins.length / PLUGINS_PER_PAGE));
  const paginatedPlugins = useMemo(() => {
    const start = (currentPage - 1) * PLUGINS_PER_PAGE;
    return filteredForumPlugins.slice(start, start + PLUGINS_PER_PAGE);
  }, [filteredForumPlugins, currentPage]);

  const featuredPlugins = filteredForumPlugins.slice(0, 3);
  const topResources = filteredForumPlugins.slice(0, 5);

  const isInstalled = useCallback(
    (title: string) => {
      const t = title.toLowerCase();
      return installedPluginNames.some(
        (n) => n.toLowerCase() === t || t.includes(n.toLowerCase()) || n.toLowerCase().includes(t)
      );
    },
    [installedPluginNames]
  );

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
            <h2>{t.forumAddons}</h2>
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
        <div className="install-url-row">
          <input
            type="url"
            placeholder="https://.../plugin.zip"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            className="input input-sm"
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={async () => {
            if (!installUrl.trim()) return;
            setInstallLoading(true);
            try {
              await onInstallFromUrl(installUrl.trim());
              setInstallUrl("");
            } finally { setInstallLoading(false); }
          }} disabled={!installUrl.trim() || installLoading || readOnly}>
            {installLoading ? t.installing : t.install}
          </button>
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
            <h1 className="discover-page-title">OBS Studio Plugins</h1>
            <p className="discover-page-subtitle">Plugins for use with OBS Studio.</p>

            {featuredPlugins.length > 0 && (
              <section className="discover-featured">
                <h3 className="section-label">{t.featured}</h3>
                <div className="featured-grid">
                  {featuredPlugins.map((p) => (
                    <div key={p.id} className="featured-card">
                      {p.icon_url ? (
                        <img src={p.icon_url} alt="" className="featured-icon-img" />
                      ) : (
                        <div className="featured-icon" />
                      )}
                      <h4 className="featured-title">{p.title}</h4>
                      <p className="featured-desc">{p.description || `${p.author || ""}`.trim() || "—"}</p>
                      <div className="featured-meta">{p.author || "—"} · {p.downloads != null ? `${p.downloads.toLocaleString()} downloads` : p.id}</div>
                      {p.rating && <span className="featured-rating">★ {p.rating}{p.rating_count ? ` (${p.rating_count})` : ""}</span>}
                      <div className="featured-btns">
                        {!readOnly && (
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => openDownloadModal(p)} title="Choose download variant">
                            {t.install}
                          </button>
                        )}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(p.url)}>
                          {t.viewOnForum}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

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
              <label className="forum-filter-favorites">
                <input type="checkbox" checked={showFavoritesOnly} onChange={(e) => setShowFavoritesOnly(e.target.checked)} />
                <span>{t.favorites}</span>
              </label>
              <select className="select-sm" value={forumSort} onChange={(e) => setForumSort(e.target.value as ForumSort)}>
                <option value="name">{t.sortByName}</option>
                <option value="id">{t.sortByRecent}</option>
                <option value="downloads">Sort by downloads</option>
                <option value="rating">Sort by rating</option>
              </select>
            </div>

            <div className="discover-pagination">
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 8).map((n) => (
                <button key={n} type="button" className={`pagination-btn ${n === currentPage ? "active" : ""}`} onClick={() => setCurrentPage(n)}>
                  {n}
                </button>
              ))}
              {totalPages > 8 && <span className="pagination-ellipsis">…</span>}
              <button type="button" className="pagination-btn" onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))} disabled={currentPage >= totalPages}>
                Next →
              </button>
            </div>

            <div className="forum-plugins-list forum-plugins-detailed">
              {filteredForumPlugins.length === 0 ? (
                <p className="empty-hint">{showFavoritesOnly ? t.noFavorite : t.noAddon}</p>
              ) : (
                paginatedPlugins.map((p) => (
                  <div key={p.id} className="forum-plugin-card forum-plugin-card-detailed">
                    {p.icon_url ? (
                      <img src={p.icon_url} alt="" className="forum-plugin-icon-img" />
                    ) : (
                      <div className="forum-plugin-icon" />
                    )}
                    <div className="forum-plugin-info">
                      <div className="forum-plugin-title-row">
                        <h3 className="forum-plugin-title">{p.title}{p.version ? ` ${p.version}` : ""}</h3>
                        <div className="forum-plugin-badges">
                          {isInstalled(p.title) && <span className="badge badge-installed">{t.installed}</span>}
                          <button type="button" className={`btn-icon favorite-btn ${favorites.includes(p.id) ? "is-favorite" : ""}`} onClick={() => onToggleFavorite(p.id)} title={favorites.includes(p.id) ? t.removeFromFav : t.addToFav} aria-label={favorites.includes(p.id) ? "Remove from favorites" : "Add to favorites"}>♥</button>
                        </div>
                      </div>
                      <div className="forum-plugin-meta">
                        {p.author || "—"}
                        {p.downloads != null && <> · {p.downloads.toLocaleString()} downloads</>}
                        {p.updated && <> · Updated {p.updated}</>}
                      </div>
                      {p.description && <p className="forum-plugin-desc">{p.description}</p>}
                      {p.rating && (
                        <span className="forum-plugin-rating">
                          ★ {p.rating}{p.rating_count ? ` (${p.rating_count})` : ""}
                        </span>
                      )}
                    </div>
                    <div className="forum-plugin-actions">
                      {!readOnly && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => openDownloadModal(p)} title="Choose download variant">
                          {t.install}
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm forum-plugin-open" onClick={() => onOpenPluginUrl(p.url)}>
                        {t.viewOnForum}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </main>
        </div>
      )}
    </section>
  );
}

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
  theme,
  onThemeChange,
  appUpdateCheck,
  onCheckAppUpdate,
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
  theme: "dark" | "light";
  onThemeChange: (v: "dark" | "light") => void;
  appUpdateCheck?: { status: string; version?: string };
  onCheckAppUpdate?: () => void;
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
        </div>
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
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const s = localStorage.getItem("theme");
      return s === "light" ? "light" : "dark";
    } catch { return "dark"; }
  });
  const [pluginUpdates, setPluginUpdates] = useState<PluginUpdateInfo[]>([]);

  const addAction = useCallback((action: string, plugin?: string) => {
    const entry: ActionLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      action,
      plugin,
      time: new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
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
    } catch (e) {
      setError(String(e));
      setPlugins([]);
      setPaths(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* ignore */ }
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
    const t = setTimeout(validatePaths, 400);
    return () => clearTimeout(t);
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
      showToast("Options saved.");
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
        showToast("Favorites exported.");
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
          showToast("Favorites imported.");
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

  async function openPluginsFolder() {
    try {
      await invoke("open_plugins_folder");
    } catch (e) {
      setError(String(e));
    }
  }

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
      addAction("Disabled", plugin.name);
      showToast(`"${plugin.name}" disabled.`);
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function enablePlugin(plugin: ObsPluginInfo) {
    if (plugin.enabled) return;
    try {
      await invoke("enable_plugin", { pluginPath: plugin.uninstall_path });
      addAction("Enabled", plugin.name);
      showToast(`"${plugin.name}" enabled.`);
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function uninstallPlugin(plugin: ObsPluginInfo) {
    let ok = false;
    try {
      ok = await ask(
        `Uninstall "${plugin.name}"? A .zip backup will be created in the plugin folder.`,
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
          addAction("Backup created", plugin.name);
        } catch {
          // continue without backup
        }
      }
      await invoke("uninstall_plugin", { uninstallPath: plugin.uninstall_path });
      addAction("Uninstalled", plugin.name);
      showToast(`"${plugin.name}" uninstalled.`);
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function installFromUrl(url: string) {
    try {
      const name = await invoke<string>("install_plugin_from_url", { url });
      addAction("Installed", name);
      showToast(`"${name}" installed.`);
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportConfig() {
    try {
      const json = await invoke<string>("export_config_json");
      const path = await save({
        defaultPath: "obs-addon-manager-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, contents: json });
        addAction("Config exported");
        showToast("Configuration exported.");
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
        addAction("Config imported");
        showToast("Configuration imported.");
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
        showToast("List exported (JSON).");
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
        showToast("List exported (CSV).");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const homeSearchRef = useRef<HTMLInputElement>(null);
  const discoverSearchRef = useRef<HTMLInputElement>(null);

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
      if (e.ctrlKey && e.key === "o") {
        e.preventDefault();
        openPluginsFolder();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loadData, page]);

  return (
    <main className="app">
      <header className="header">
        <img src={logo} alt="LamaWorlds" className="header-logo" />
        <div className="header-text">
          <h1>LamaWorlds OBS Addon Manager</h1>
          <p className="subtitle">{t.subtitle}</p>
        </div>
      </header>

      <nav className="nav-tabs">
        <button
          type="button"
          className={`nav-tab ${page === "home" ? "active" : ""}`}
          onClick={() => setPage("home")}
        >
          {t.home}
        </button>
        <button
          type="button"
          className={`nav-tab ${page === "discover" ? "active" : ""}`}
          onClick={() => setPage("discover")}
          title={t.shortcuts}
        >
          {t.discover}
        </button>
        <button
          type="button"
          className={`nav-tab ${page === "options" ? "active" : ""}`}
          onClick={() => setPage("options")}
        >
          {t.options}
        </button>
      </nav>

      {pluginUpdates.length > 0 && (
        <div className="alert alert-warning">
          <strong>{t.updatesAvailable}:</strong>{" "}
          {pluginUpdates.map((u) => u.plugin_name).join(", ")}{" "}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); setPage("discover"); }}
            className="link"
          >
            View in Discover
          </a>
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
            searchInputRef={homeSearchRef}
            onSearchChange={setSearchQuery}
            onSortChange={setSortBy}
            onStatusFilterChange={setStatusFilter}
            onRefresh={loadData}
            onOpenPluginsFolder={openPluginsFolder}
            onExportPluginsJson={exportPluginsJson}
            onExportPluginsCsv={exportPluginsCsv}
            onUninstall={uninstallPlugin}
            onDisable={disablePlugin}
            onEnable={enablePlugin}
            obsRunning={obsRunning}
            pathValid={pathValid}
            readOnly={readOnly}
            compactMode={compactMode}
            onCompactModeChange={setCompactMode}
            actionLog={actionLog}
            toast={toast}
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
            theme={theme}
            onThemeChange={setTheme}
          />
        )}
      </div>
    </main>
  );
}

export default App;
