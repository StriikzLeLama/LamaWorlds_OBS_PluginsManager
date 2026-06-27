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
// ─────────────────────────────────────────────────────────────────────────
// Home Page
// ─────────────────────────────────────────────────────────────────────────
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
  const [installPanelOpen, setInstallPanelOpen] = useState(false);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);

  const handleInstallFromUrl = useCallback(async () => {
    if (!installUrl.trim()) return;
    setInstallLoading(true);
    try { await onInstallFromUrl(installUrl.trim()); setInstallUrl(""); }
    finally { setInstallLoading(false); }
  }, [installUrl, onInstallFromUrl]);

  const filteredPlugins = useMemo(() => {
    let list = [...plugins];
    if (statusFilter === "active")   list = list.filter(p => p.enabled);
    if (statusFilter === "disabled") list = list.filter(p => !p.enabled);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    }
    if (sortBy === "name") list.sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    else if (sortBy === "path") list.sort((a,b) => a.path.localeCompare(b.path));
    else list.sort((a,b) => (b.modified_time ?? 0) - (a.modified_time ?? 0));
    return list;
  }, [plugins, searchQuery, sortBy, statusFilter]);

  const activeCount   = plugins.filter(p => p.enabled).length;
  const disabledCount = plugins.filter(p => !p.enabled).length;
  const updateCount   = pluginUpdates?.length ?? 0;

  const hasPaths = paths && (
    paths.custom_plugins_path || paths.plugins_path ||
    paths.obs_install_path || paths.appdata_plugins || paths.custom_obs_install_path
  );

  return (
    <div className="home-layout">
      {toast && <div className="toast">{toast}</div>}

      {/* ─── Status alerts ─── */}
      {(obsRunning || (!pathValid && hasPaths)) && (
        <div className="home-alerts">
          {obsRunning && (
            <div className="alert alert-warning">
              <i className="ti ti-alert-triangle" /> {t.obsRunning}
            </div>
          )}
          {hasPaths && !pathValid && (
            <div className="alert alert-error">
              <i className="ti ti-folder-off" /> {t.pathNotExist}
            </div>
          )}
        </div>
      )}

      {/* ─── Dashboard stat cards ─── */}
      <div className="home-stats">
        <div className="hstat-card">
          <div className="hstat-icon hstat-icon--total"><i className="ti ti-puzzle" /></div>
          <div className="hstat-body">
            <span className="hstat-num">{plugins.length}</span>
            <span className="hstat-lbl">Total plugins</span>
          </div>
        </div>
        <div className="hstat-card">
          <div className="hstat-icon hstat-icon--active"><i className="ti ti-check" /></div>
          <div className="hstat-body">
            <span className="hstat-num hstat-num--green">{activeCount}</span>
            <span className="hstat-lbl">Active</span>
          </div>
        </div>
        <div className="hstat-card">
          <div className="hstat-icon hstat-icon--off"><i className="ti ti-eye-off" /></div>
          <div className="hstat-body">
            <span className="hstat-num hstat-num--muted">{disabledCount}</span>
            <span className="hstat-lbl">Disabled</span>
          </div>
        </div>
        {updateCount > 0 && (
          <div className="hstat-card hstat-card--updates">
            <div className="hstat-icon hstat-icon--update"><i className="ti ti-arrow-up" /></div>
            <div className="hstat-body">
              <span className="hstat-num hstat-num--orange">{updateCount}</span>
              <span className="hstat-lbl">Updates</span>
            </div>
          </div>
        )}
        <div className="hstat-card hstat-card--obs">
          <div className="hstat-icon" style={{ background: obsRunning ? "var(--danger-bg)" : "var(--surface-2)", color: obsRunning ? "var(--danger)" : "var(--success)" }}>
            <i className={`ti ${obsRunning ? "ti-player-stop" : "ti-circle-check"}`} />
          </div>
          <div className="hstat-body">
            <span className="hstat-num" style={{ color: obsRunning ? "var(--danger)" : "var(--success)", fontSize: "0.85rem", fontWeight: 600 }}>
              {obsRunning ? "Running" : "Not running"}
            </span>
            <span className="hstat-lbl">OBS Studio</span>
          </div>
        </div>
      </div>

      {/* ─── Quick actions bar ─── */}
      <div className="home-quickbar">
        <button type="button" className="hqb-btn hqb-btn--primary" onClick={() => setInstallPanelOpen(v => !v)} disabled={readOnly}>
          <i className="ti ti-download" /> Install plugin
          <i className={`ti ti-chevron-${installPanelOpen ? "up" : "down"} hqb-chevron`} />
        </button>
        <button type="button" className="hqb-btn" onClick={onRefresh} disabled={loading}>
          <i className={`ti ti-refresh ${loading ? "spin-icon" : ""}`} /> Refresh
        </button>
        <button type="button" className="hqb-btn" onClick={onOpenPluginsFolder}>
          <i className="ti ti-folder-open" /> Open folder
        </button>
        <button type="button" className="hqb-btn" onClick={onExportPluginsJson}>
          <i className="ti ti-file-export" /> Export JSON
        </button>
        <button type="button" className="hqb-btn" onClick={onExportPluginsCsv}>
          <i className="ti ti-table-export" /> Export CSV
        </button>
        <button type="button" className="hqb-btn" onClick={onOpenDownloads}>
          <i className="ti ti-folder-down" /> Downloads
        </button>
      </div>

      {/* ─── Install panel (collapsible) ─── */}
      {installPanelOpen && (
        <div className="home-install-panel">
          <div className="hip-row">
            <div className="hip-field">
              <label className="hip-label"><i className="ti ti-link" /> Install from URL</label>
              <div className="hip-input-row">
                <input
                  type="url"
                  className="input input-sm"
                  placeholder="https://…/plugin.zip"
                  value={installUrl}
                  onChange={e => setInstallUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleInstallFromUrl(); }}
                  aria-label="Plugin URL"
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={handleInstallFromUrl} disabled={!installUrl.trim() || installLoading}>
                  {installLoading ? <><span className="hq-spinner" /> Installing…</> : "Install"}
                </button>
              </div>
            </div>
            <div className="hip-field">
              <label className="hip-label"><i className="ti ti-clipboard" /> Paste file path</label>
              <div className="hip-input-row">
                <input
                  type="text"
                  className="input input-sm"
                  placeholder="C:\path\to\plugin.zip"
                  value={pastePath}
                  onChange={e => setPastePath(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { onInstallFromPastePath(pastePath); setPastePath(""); } }}
                />
                <button type="button" className="btn btn-outline btn-sm" onClick={() => { onInstallFromPastePath(pastePath); setPastePath(""); }} disabled={!pastePath.trim() || importLoading}>
                  Install
                </button>
              </div>
            </div>
          </div>
          <div
            role="button" tabIndex={0}
            className={`hip-dropzone ${readOnly ? "hip-dropzone--disabled" : ""} ${importLoading ? "hip-dropzone--loading" : ""}`}
            onClick={() => !readOnly && !importLoading && onImportFromFile()}
            onKeyDown={e => e.key === "Enter" && !readOnly && !importLoading && onImportFromFile()}
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("hip-dropzone--active"); }}
            onDragLeave={e => { e.preventDefault(); e.currentTarget.classList.remove("hip-dropzone--active"); }}
            onDrop={e => {
              e.preventDefault(); e.currentTarget.classList.remove("hip-dropzone--active");
              if (readOnly || importLoading) return;
              Array.from(e.dataTransfer.files).forEach(f => {
                if (f.name.endsWith(".zip") || f.name.endsWith(".dll"))
                  onInstallFromPastePath((f as File & { path?: string }).path ?? f.name);
              });
            }}
          >
            <i className="ti ti-package" />
            <span>{importLoading ? "Installing…" : "Drop .zip or .dll here, or click to browse"}</span>
          </div>
          {importHistory.length > 0 && (
            <div className="hip-history">
              <span className="hip-history-lbl">Recent:</span>
              {importHistory.slice(0, 5).map(p => (
                <button key={p} type="button" className="hip-history-btn" onClick={() => onReimportFromHistory(p)} disabled={readOnly || importLoading} title={p}>
                  {p.split(/[/\\]/).pop() ?? p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── OBS paths ─── */}
      {hasPaths && (
        <div className="home-paths-bar">
          <i className="ti ti-folders home-paths-icon" />
          <div className="home-paths-chips">
            {paths?.custom_plugins_path && (
              <div className="hpath-chip hpath-chip--custom">
                <span>Custom</span><code>{paths.custom_plugins_path}</code>
              </div>
            )}
            {paths?.plugins_path && (
              <div className="hpath-chip"><span>Plugins</span><code>{paths.plugins_path}</code></div>
            )}
            {paths?.appdata_plugins && (
              <div className="hpath-chip"><span>AppData</span><code>{paths.appdata_plugins}</code></div>
            )}
          </div>
        </div>
      )}

      {/* ─── Updates banner ─── */}
      {updateCount > 0 && (
        <div className="home-updates-banner">
          <div className="hub-left">
            <i className="ti ti-arrow-up-circle" />
            <strong>{updateCount} update{updateCount > 1 ? "s" : ""} available</strong>
          </div>
          <div className="hub-items">
            {pluginUpdates?.slice(0, 3).map(u => (
              <div key={u.plugin_name} className="hub-item">
                <span className="hub-name">{u.plugin_name}</span>
                {u.installed_version && (
                  <span className="hub-ver">v{u.installed_version} → v{u.available_version ?? "?"}</span>
                )}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onUpdatePlugin?.(u)} disabled={readOnly || updatingPlugins?.has(u.plugin_name)}>
                  {updatingPlugins?.has(u.plugin_name) ? "Updating…" : "Update"}
                </button>
                {onOpenPluginUrl && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(u.forum_url)}>
                    <i className="ti ti-external-link" />
                  </button>
                )}
              </div>
            ))}
            {updateCount > 3 && <span className="hub-more">+{updateCount - 3} more</span>}
          </div>
        </div>
      )}

      {/* ─── Plugin list section ─── */}
      <div className="home-plugins-section">
        {/* toolbar */}
        <div className="hp-toolbar">
          <div className="hp-toolbar-left">
            <h2 className="hp-title">
              Installed plugins
              <span className="hp-count">{filteredPlugins.length !== plugins.length ? `${filteredPlugins.length} / ${plugins.length}` : plugins.length}</span>
            </h2>
          </div>
          <div className="hp-toolbar-right">
            <div className="hp-search-wrap">
              <i className="ti ti-search hp-search-icon" />
              <input
                ref={searchInputRef}
                type="search"
                className="hp-search-input"
                placeholder="Search…"
                value={searchQuery}
                onChange={e => onSearchChange(e.target.value)}
                aria-label="Search plugins"
              />
              {searchQuery && (
                <button type="button" className="hp-search-clear" onClick={() => onSearchChange("")} aria-label="Clear">
                  <i className="ti ti-x" />
                </button>
              )}
            </div>
            <div className="hp-filter-group">
              <button type="button" className={`hp-filter-btn ${statusFilter === "all" ? "active" : ""}`} onClick={() => onStatusFilterChange("all")}>All</button>
              <button type="button" className={`hp-filter-btn ${statusFilter === "active" ? "active" : ""}`} onClick={() => onStatusFilterChange("active")}>
                <i className="ti ti-check" /> Active
              </button>
              <button type="button" className={`hp-filter-btn ${statusFilter === "disabled" ? "active" : ""}`} onClick={() => onStatusFilterChange("disabled")}>
                <i className="ti ti-eye-off" /> Disabled
              </button>
            </div>
            <select className="dsc-sort-select" value={sortBy} onChange={e => onSortChange(e.target.value as SortBy)}>
              <option value="name">A → Z</option>
              <option value="date">Recent first</option>
              <option value="path">By path</option>
            </select>
            <div className="dsc-view-toggle">
              <button type="button" className={`dsc-view-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => onViewModeChange("list")} title="List">
                <i className="ti ti-list" />
              </button>
              <button type="button" className={`dsc-view-btn ${viewMode === "grid" ? "active" : ""}`} onClick={() => onViewModeChange("grid")} title="Grid">
                <i className="ti ti-grid-dots" />
              </button>
            </div>
            <label className="hp-compact-toggle" title="Compact mode">
              <input type="checkbox" checked={compactMode} onChange={e => onCompactModeChange(e.target.checked)} />
              <i className="ti ti-layout-distribute-vertical" />
            </label>
          </div>
        </div>

        {/* list */}
        {loading ? (
          <div className="hp-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="hp-skel">
                <div className="hp-skel-dot" />
                <div className="hp-skel-lines">
                  <div className="hp-skel-line hp-skel-name" />
                  <div className="hp-skel-line hp-skel-path" />
                </div>
                <div className="hp-skel-btns">
                  <div className="hp-skel-btn" />
                  <div className="hp-skel-btn" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredPlugins.length === 0 ? (
          <div className="hp-empty">
            <i className="ti ti-mood-empty" />
            <p>{searchQuery || statusFilter !== "all" ? t.noPluginMatch : t.noPlugin}</p>
            {!plugins.length && (
              <button type="button" className="btn btn-outline btn-sm" onClick={onOpenPluginsFolder}>
                Open plugins folder
              </button>
            )}
          </div>
        ) : (
          <ul className={`hp-list ${compactMode ? "hp-list--compact" : ""} hp-list--${viewMode}`}>
            {filteredPlugins.map(plugin => {
              const updateInfo = pluginUpdates?.find(u => u.plugin_name === plugin.name);
              const isExpanded = expandedPlugin === `${plugin.name}-${plugin.path}`;
              const key = `${plugin.name}-${plugin.path}`;

              if (viewMode === "grid") {
                return (
                  <li key={key} className={`hp-grid-card ${!plugin.enabled ? "hp-grid-card--off" : ""} ${updateInfo ? "hp-grid-card--update" : ""}`}>
                    <div className="hp-gc-head">
                      <div className={`hp-gc-dot ${plugin.enabled ? "hp-gc-dot--on" : "hp-gc-dot--off"}`} />
                      <div className="hp-gc-name">
                        {plugin.name}
                        {plugin.version && <span className="hp-ver"> v{plugin.version}</span>}
                      </div>
                      {updateInfo && <span className="hp-badge-update" title="Update available"><i className="ti ti-arrow-up" /></span>}
                    </div>
                    <div className="hp-gc-path" title={plugin.path}>{plugin.path}</div>
                    {plugin.modified_time && <div className="hp-gc-date">{formatDate(plugin.modified_time)}</div>}
                    <div className="hp-gc-actions">
                      {plugin.enabled
                        ? <button type="button" className="btn btn-outline btn-sm" onClick={() => onDisable(plugin)} disabled={readOnly}><i className="ti ti-eye-off" /></button>
                        : <button type="button" className="btn btn-success btn-sm" onClick={() => onEnable(plugin)} disabled={readOnly}><i className="ti ti-eye" /></button>
                      }
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => onUninstall(plugin)} disabled={readOnly}><i className="ti ti-trash" /></button>
                      {onOpenPluginFolder && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginFolder(plugin.path)} title="Open folder"><i className="ti ti-folder" /></button>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li key={key} className={`hp-item ${!plugin.enabled ? "hp-item--off" : ""} ${updateInfo ? "hp-item--update" : ""} ${compactMode ? "" : "hp-item--expandable"}`}>
                  <div className="hp-item-main" onClick={() => !compactMode && setExpandedPlugin(isExpanded ? null : key)} style={{ cursor: compactMode ? "default" : "pointer" }}>
                    <div className={`hp-status-dot ${plugin.enabled ? "hp-status-dot--on" : "hp-status-dot--off"}`} title={plugin.enabled ? "Active" : "Disabled"} />
                    <div className="hp-item-info">
                      <div className="hp-item-name">
                        {plugin.name}
                        {plugin.version && <span className="hp-ver"> v{plugin.version}</span>}
                        {!plugin.enabled && <span className="hp-badge-off">Disabled</span>}
                        {updateInfo && <span className="hp-badge-update"><i className="ti ti-arrow-up" /> Update</span>}
                      </div>
                      {(compactMode || !isExpanded) && (
                        <div className="hp-item-path" title={plugin.path}>{plugin.path}</div>
                      )}
                    </div>
                    {plugin.modified_time && !compactMode && (
                      <span className="hp-item-date">{formatDate(plugin.modified_time)}</span>
                    )}
                  </div>

                  {/* Expanded details */}
                  {isExpanded && !compactMode && (
                    <div className="hp-item-detail">
                      <div className="hp-detail-row">
                        <i className="ti ti-folder" /><code>{plugin.path}</code>
                      </div>
                      {plugin.modified_time && (
                        <div className="hp-detail-row">
                          <i className="ti ti-clock" /><span>Last modified: {formatDate(plugin.modified_time)}</span>
                        </div>
                      )}
                      {updateInfo && (
                        <div className="hp-detail-row hp-detail-update">
                          <i className="ti ti-arrow-up-circle" />
                          <span>Update available: v{updateInfo.installed_version} → v{updateInfo.available_version ?? "?"}</span>
                          {onOpenPluginUrl && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(updateInfo.forum_url)}>
                              <i className="ti ti-external-link" /> Forum
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="hp-item-btns">
                    {updateInfo && onUpdatePlugin && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => onUpdatePlugin(updateInfo)} disabled={readOnly || updatingPlugins?.has(plugin.name)}>
                        <i className="ti ti-arrow-up" /> {updatingPlugins?.has(plugin.name) ? "Updating…" : "Update"}
                      </button>
                    )}
                    {plugin.enabled
                      ? <button type="button" className="btn btn-outline btn-sm" onClick={() => onDisable(plugin)} disabled={readOnly} title="Disable"><i className="ti ti-eye-off" />{!compactMode && " Disable"}</button>
                      : <button type="button" className="btn btn-success btn-sm" onClick={() => onEnable(plugin)} disabled={readOnly} title="Enable"><i className="ti ti-eye" />{!compactMode && " Enable"}</button>
                    }
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => onUninstall(plugin)} disabled={readOnly} title="Uninstall">
                      <i className="ti ti-trash" />{!compactMode && " Uninstall"}
                    </button>
                    {onOpenPluginFolder && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginFolder(plugin.path)} title="Open in folder">
                        <i className="ti ti-folder" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Options Page
// ─────────────────────────────────────────────────────────────────────────
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
    <div className="opt-page">
      {/* ─── Appearance ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-palette" />
          <h2>Appearance</h2>
        </div>
        <div className="opt-row">
          <div className="opt-label-block">
            <span>Theme</span>
            <span className="opt-hint">Choose your preferred color scheme</span>
          </div>
          <div className="opt-theme-btns">
            {(["dark","light","system"] as const).map(v => (
              <button key={v} type="button" className={`opt-theme-btn ${theme === v ? "active" : ""}`} onClick={() => onThemeChange(v)}>
                <i className={`ti ${v === "dark" ? "ti-moon" : v === "light" ? "ti-sun" : "ti-device-laptop"}`} />
                {v === "dark" ? t.darkMode : v === "light" ? t.lightMode : t.systemTheme}
              </button>
            ))}
          </div>
        </div>
        <div className="opt-row">
          <div className="opt-label-block">
            <span>Language</span>
            <span className="opt-hint">UI display language</span>
          </div>
          <select className="dsc-sort-select" value={lang} onChange={e => onLangChange(e.target.value as Lang)} aria-label="Language">
            <option value="en">🇬🇧 English</option>
            <option value="fr">🇫🇷 Français</option>
          </select>
        </div>
      </div>

      {/* ─── Paths ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-folders" />
          <h2>Paths</h2>
          <span className="opt-section-sub">Override auto-detected OBS paths</span>
        </div>
        <div className="opt-path-row">
          <label className="opt-path-label">
            <i className="ti ti-puzzle" /> Plugins folder
          </label>
          <div className="opt-path-input">
            <input type="text" value={customPluginsPath} onChange={e => onPluginsPathChange(e.target.value)}
              placeholder="C:\ProgramData\obs-studio\plugins"
              className={`input ${pathErrors.plugins ? "input-error" : ""}`} />
            <button type="button" className="btn btn-ghost" onClick={onBrowsePlugins}><i className="ti ti-folder-open" /></button>
          </div>
          {pathErrors.plugins && <span className="opt-field-error"><i className="ti ti-alert-circle" /> {pathErrors.plugins}</span>}
        </div>
        <div className="opt-path-row">
          <label className="opt-path-label">
            <i className="ti ti-brand-obs" /> OBS install folder
          </label>
          <div className="opt-path-input">
            <input type="text" value={customObsPath} onChange={e => onObsPathChange(e.target.value)}
              placeholder="C:\Program Files\obs-studio"
              className={`input ${pathErrors.obs ? "input-error" : ""}`} />
            <button type="button" className="btn btn-ghost" onClick={onBrowseObs}><i className="ti ti-folder-open" /></button>
          </div>
          {pathErrors.obs && <span className="opt-field-error"><i className="ti ti-alert-circle" /> {pathErrors.obs}</span>}
        </div>
        <div className="opt-save-row">
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving || !!(pathErrors.plugins || pathErrors.obs)}>
            {saving ? <><span className="hq-spinner" /> Saving…</> : <><i className="ti ti-device-floppy" /> Save paths</>}
          </button>
        </div>
      </div>

      {/* ─── Behavior ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-settings" />
          <h2>Behavior</h2>
        </div>
        <div className="opt-toggle-row">
          <div className="opt-label-block">
            <span>Auto backup</span>
            <span className="opt-hint">Automatically backup plugins before uninstalling</span>
          </div>
          <label className="opt-switch">
            <input type="checkbox" checked={autoBackup} onChange={e => onAutoBackupChange(e.target.checked)} />
            <span className="opt-switch-track" />
          </label>
        </div>
        <div className="opt-toggle-row">
          <div className="opt-label-block">
            <span>Read-only mode</span>
            <span className="opt-hint">Prevent all modifications (install, uninstall, enable/disable)</span>
          </div>
          <label className="opt-switch">
            <input type="checkbox" checked={readOnly} onChange={e => onReadOnlyChange(e.target.checked)} />
            <span className="opt-switch-track" />
          </label>
        </div>
      </div>

      {/* ─── Profiles ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-user-circle" />
          <h2>Plugin profiles</h2>
          <span className="opt-section-sub">Save and restore sets of enabled plugins</span>
        </div>
        <div className="opt-action-grid">
          <button type="button" className="opt-action-btn" onClick={onSaveProfile} disabled={readOnly}>
            <i className="ti ti-device-floppy" />
            <span>Save profile</span>
            <span className="opt-action-hint">Export current enabled plugins to JSON</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onApplyProfile} disabled={readOnly}>
            <i className="ti ti-player-play" />
            <span>Apply profile</span>
            <span className="opt-action-hint">Load a profile and enable/disable matching plugins</span>
          </button>
        </div>
      </div>

      {/* ─── Backup & Config ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-database" />
          <h2>Backup &amp; config</h2>
        </div>
        <div className="opt-action-grid">
          <button type="button" className="opt-action-btn" onClick={onBackupAll}>
            <i className="ti ti-archive" />
            <span>Backup all plugins</span>
            <span className="opt-action-hint">Create a ZIP backup of all plugin files</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onExport}>
            <i className="ti ti-file-export" />
            <span>Export config</span>
            <span className="opt-action-hint">Save settings and favorites to JSON</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onImport}>
            <i className="ti ti-file-import" />
            <span>Import config</span>
            <span className="opt-action-hint">Restore settings from a backup JSON</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onExportFavorites}>
            <i className="ti ti-heart" />
            <span>Export favorites</span>
            <span className="opt-action-hint">Save your Discovery favorites list</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onImportFavorites}>
            <i className="ti ti-heart-plus" />
            <span>Import favorites</span>
            <span className="opt-action-hint">Restore a favorites list</span>
          </button>
        </div>
      </div>

      {/* ─── Debug ─── */}
      <div className="opt-section opt-section--debug">
        <div className="opt-section-head">
          <i className="ti ti-bug" />
          <h2>Debug</h2>
        </div>
        <div className="opt-debug-row">
          <span className="opt-hint">Config directory</span>
          <code className="opt-code">{configPath || "—"}</code>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
          <i className="ti ti-folder-open" /> Open log folder
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Logs Page
// ─────────────────────────────────────────────────────────────────────────
function LogsPage({
  actionLog,
  onOpenLog,
}: {
  actionLog: ActionLog[];
  onOpenLog: () => void;
}) {
  const [backendLog,        setBackendLog]        = useState<string | null>(null);
  const [backendLogError,   setBackendLogError]   = useState<string | null>(null);
  const [backendLogLoading, setBackendLogLoading] = useState(true);
  const [logDir,            setLogDir]            = useState<string | null>(null);
  const [activeTab,         setActiveTab]         = useState<"actions"|"backend">("actions");
  const [filterText,        setFilterText]        = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  const loadBackendLog = useCallback(() => {
    setBackendLogLoading(true);
    setBackendLogError(null);
    invoke<string>("read_log_file")
      .then(setBackendLog)
      .catch(e => setBackendLogError(String(e)))
      .finally(() => setBackendLogLoading(false));
  }, []);

  useEffect(() => {
    loadBackendLog();
    invoke<string | null>("get_config_dir").then(d => setLogDir(d ?? null)).catch(() => setLogDir(null));
  }, [loadBackendLog, actionLog]);

  useEffect(() => {
    if (activeTab === "backend") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [backendLog, activeTab]);

  const filteredActions = useMemo(() => {
    if (!filterText.trim()) return actionLog;
    const q = filterText.toLowerCase();
    return actionLog.filter(a =>
      a.action.toLowerCase().includes(q) ||
      (a.plugin?.toLowerCase().includes(q) ?? false) ||
      (a.details?.toLowerCase().includes(q) ?? false)
    );
  }, [actionLog, filterText]);

  const actionIcons: Record<string, string> = {
    "Refresh": "ti-refresh", "Installed": "ti-download", "Updated": "ti-arrow-up",
    "Uninstalled": "ti-trash", "Disabled": "ti-eye-off", "Enabled": "ti-eye",
    "Backup created": "ti-archive", "Export list": "ti-file-export",
    "Profile saved": "ti-device-floppy", "Profile applied": "ti-player-play",
    "Config exported": "ti-file-export", "Config imported": "ti-file-import",
  };

  return (
    <div className="logs-page-v2">
      {/* tab bar */}
      <div className="logs-tabs">
        <button type="button" className={`logs-tab ${activeTab === "actions" ? "active" : ""}`} onClick={() => setActiveTab("actions")}>
          <i className="ti ti-list-check" /> Action history
          {actionLog.length > 0 && <span className="logs-tab-badge">{actionLog.length}</span>}
        </button>
        <button type="button" className={`logs-tab ${activeTab === "backend" ? "active" : ""}`} onClick={() => setActiveTab("backend")}>
          <i className="ti ti-terminal" /> Backend log
        </button>
        <div className="logs-tabs-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
          <i className="ti ti-folder-open" /> Open log folder
        </button>
      </div>

      {/* ── actions tab ── */}
      {activeTab === "actions" && (
        <div className="logs-actions-pane">
          <div className="logs-filter-bar">
            <i className="ti ti-search" />
            <input type="search" className="logs-filter-input" placeholder="Filter events…"
              value={filterText} onChange={e => setFilterText(e.target.value)} />
            {filterText && (
              <button type="button" className="dsc-sb-search-clear" onClick={() => setFilterText("")} aria-label="Clear"><i className="ti ti-x" /></button>
            )}
            <span className="logs-filter-count">{filteredActions.length} event{filteredActions.length !== 1 ? "s" : ""}</span>
          </div>

          {filteredActions.length === 0 ? (
            <div className="logs-empty">
              <i className="ti ti-ghost" />
              <p>{filterText ? "No events match this filter" : t.noRecentAction}</p>
            </div>
          ) : (
            <ul className="logs-timeline">
              {filteredActions.map((a, idx) => {
                const icon = Object.entries(actionIcons).find(([k]) => a.action.toLowerCase().includes(k.toLowerCase()))?.[1] ?? "ti-point";
                const isFirst = idx === 0 || filteredActions[idx-1].date !== a.date;
                return (
                  <li key={a.id} className="logs-entry">
                    {isFirst && <div className="logs-date-sep">{a.date}</div>}
                    <div className="logs-entry-inner">
                      <div className="logs-entry-icon"><i className={`ti ${icon}`} /></div>
                      <div className="logs-entry-body">
                        <div className="logs-entry-top">
                          <span className="logs-entry-action">{a.action}</span>
                          {a.plugin && <span className="logs-entry-plugin"><i className="ti ti-puzzle" /> {a.plugin}</span>}
                          <span className="logs-entry-time">{a.time}</span>
                        </div>
                        {a.details && <div className="logs-entry-details">{a.details.length > 120 ? `${a.details.slice(0,120)}…` : a.details}</div>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ── backend log tab ── */}
      {activeTab === "backend" && (
        <div className="logs-backend-pane">
          <div className="logs-backend-header">
            {logDir && <code className="opt-code">{logDir}</code>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadBackendLog}>
              <i className="ti ti-refresh" /> Refresh
            </button>
          </div>
          {backendLogLoading ? (
            <div className="dsc-loading-center" style={{ padding: "3rem" }}>
              <div className="spinner" /><span>Loading log…</span>
            </div>
          ) : backendLogError ? (
            <div className="alert alert-error">{backendLogError}</div>
          ) : backendLog?.trim() ? (
            <pre className="logs-backend-pre">{backendLog}</pre>
          ) : (
            <div className="logs-empty"><i className="ti ti-ghost" /><p>{t.logEmpty}</p></div>
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// Discover Page
// ============================================================
type ForumSort = "name" | "id" | "downloads" | "rating";
type ForumCategory = "plugins" | "themes" | "tools" | "scripts";
type DiscoverView = "grid" | "list";

const PLUGINS_PER_PAGE = 30;
const SIDEBAR_CAT_META: Record<ForumCategory, { label: string; icon: string; color: string }> = {
  plugins: { label: "Plugins",  icon: "ti-puzzle",  color: "#7c6dfa" },
  themes:  { label: "Themes",   icon: "ti-palette", color: "#f07f3c" },
  tools:   { label: "Tools",    icon: "ti-tool",    color: "#3cb8f0" },
  scripts: { label: "Scripts",  icon: "ti-code",    color: "#4caf50" },
};

/**
 * Discover — store-style page with sidebar nav, search hero, grid/list toggle,
 * configurable scrape depth (1–15 pages), tag cloud, and skeleton loading.
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
  // ── data
  const [forumPlugins, setForumPlugins]     = useState<ForumPlugin[]>([]);
  const [forumLoading, setForumLoading]     = useState(false);
  const [forumError,   setForumError]       = useState<string | null>(null);
  const [forumFetched, setForumFetched]     = useState(false);
  const [searchResults, setSearchResults]   = useState<ForumPlugin[] | null>(null);
  const [searchLoading, setSearchLoading]   = useState(false);

  // ── ui state
  const [forumSearch,         setForumSearch]         = useState("");
  const [liveSearch,          setLiveSearch]           = useState("");   // debounced
  const [forumSort,           setForumSort]            = useState<ForumSort>("downloads");
  const [forumCategory,       setForumCategory]        = useState<ForumCategory>("plugins");
  const [currentPage,         setCurrentPage]          = useState(1);
  const [view,                setView]                 = useState<DiscoverView>("grid");
  const [showFavoritesOnly,   setShowFavoritesOnly]    = useState(false);
  const [showNotInstalled,    setShowNotInstalled]      = useState(false);
  const [maxPages,            setMaxPages]             = useState(5);
  const [activeTag,           setActiveTag]            = useState<string | null>(null);
  const [downloadModal, setDownloadModal] = useState<{
    plugin: ForumPlugin; options: DownloadOption[]; loading: boolean; error?: string;
  } | null>(null);

  // ── debounce live search (local filter, not API)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (val: string) => {
    setForumSearch(val);
    setCurrentPage(1);
    if (!val.trim()) { setSearchResults(null); setLiveSearch(""); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setLiveSearch(val), 300);
  };

  // ── fetch forum catalog
  const loadForumPlugins = useCallback(async (forceRefresh = false, category?: ForumCategory, pages?: number) => {
    const cat = category ?? forumCategory;
    const mp  = pages ?? maxPages;
    setForumLoading(true);
    setForumError(null);
    setSearchResults(null);
    setActiveTag(null);
    try {
      const list = await invoke<ForumPlugin[]>("fetch_forum_plugins", {
        category: cat,
        forceRefresh,
        maxPages: mp,
      });
      setForumPlugins(list);
      setForumFetched(true);
      setCurrentPage(1);
    } catch (e) {
      setForumError(String(e));
      setForumPlugins(prev => prev.length > 0 ? prev : []);
    } finally {
      setForumLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumCategory, maxPages]);

  useEffect(() => { loadForumPlugins(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // ── API search
  const searchForum = useCallback(async () => {
    const q = forumSearch.trim();
    if (!q) { setSearchResults(null); return; }
    setSearchLoading(true);
    setForumError(null);
    try {
      const list = await invoke<ForumPlugin[]>("search_forum_resources", { keywords: q });
      setSearchResults(list);
      setCurrentPage(1);
    } catch (e) {
      setForumError(String(e));
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [forumSearch]);

  // ── download modal
  const openDownloadModal = useCallback(async (plugin: ForumPlugin) => {
    if (readOnly) return;
    setDownloadModal({ plugin, options: [], loading: true });
    try {
      const opts = await invoke<DownloadOption[]>("fetch_plugin_download_options", { resourceUrl: plugin.url });
      setDownloadModal(m => m ? { ...m, options: opts, loading: false } : null);
    } catch (e) {
      setDownloadModal(m => m ? { ...m, options: [], loading: false, error: String(e) } : null);
    }
  }, [readOnly]);

  // ── helpers
  const isInstalled = useCallback((title: string) => {
    const lower = title.toLowerCase();
    return installedPluginNames.some(n =>
      n.toLowerCase() === lower || lower.includes(n.toLowerCase()) || n.toLowerCase().includes(lower)
    );
  }, [installedPluginNames]);

  // ── tag cloud from prefix field
  const tagCloud = useMemo(() => {
    const counts: Record<string, number> = {};
    forumPlugins.forEach(p => { if (p.prefix) counts[p.prefix] = (counts[p.prefix] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [forumPlugins]);

  // ── filtered + sorted list
  const baseList = searchResults ?? forumPlugins;
  const filtered = useMemo(() => {
    let list = [...baseList];
    const q = (searchResults === null ? liveSearch : "").toLowerCase().trim();
    if (q) {
      list = list.filter(p =>
        p.title.toLowerCase().includes(q) ||
        (p.author?.toLowerCase().includes(q) ?? false)
      );
    }
    if (searchResults === null) {
      if (showFavoritesOnly) {
        const set = new Set(favorites);
        list = list.filter(p => set.has(p.id));
      }
      if (activeTag) list = list.filter(p => p.prefix === activeTag);
    }
    if (showNotInstalled) list = list.filter(p => !isInstalled(p.title));
    if (forumSort === "name")      list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    else if (forumSort === "downloads") list.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    else if (forumSort === "rating")    list.sort((a, b) => parseFloat(b.rating ?? "0") - parseFloat(a.rating ?? "0"));
    else                                list.sort((a, b) => Number(b.id) - Number(a.id));
    return list;
  }, [baseList, liveSearch, searchResults, showFavoritesOnly, showNotInstalled, activeTag, favorites, forumSort, isInstalled]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PLUGINS_PER_PAGE));
  const paginated  = useMemo(() => {
    const s = (currentPage - 1) * PLUGINS_PER_PAGE;
    return filtered.slice(s, s + PLUGINS_PER_PAGE);
  }, [filtered, currentPage]);

  const isSearchMode = searchResults !== null;
  const installedCount = useMemo(() => forumPlugins.filter(p => isInstalled(p.title)).length, [forumPlugins, isInstalled]);
  const totalDownloads = useMemo(() => forumPlugins.reduce((s, p) => s + (p.downloads ?? 0), 0), [forumPlugins]);

  // ── pagination helper
  const pageNums = useMemo(() => {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
      .reduce<(number | "…")[]>((acc, n, i, arr) => {
        if (n === 1 || n === totalPages || Math.abs(n - currentPage) <= 2) {
          if (i > 0 && typeof arr[i-1] === "number" && (n as number) - (arr[i-1] as number) > 1) acc.push("…");
          acc.push(n);
        }
        return acc;
      }, []);
  }, [totalPages, currentPage]);

  return (
    <section className="dsc-page">
      {toast && <div className="toast">{toast}</div>}

      {/* ── Download modal ── */}
      {downloadModal && (
        <div className="modal-overlay" onClick={() => setDownloadModal(null)}>
          <div className="dsc-modal" onClick={e => e.stopPropagation()}>
            <div className="dsc-modal-head">
              <div className="dsc-modal-icon">
                {downloadModal.plugin.icon_url
                  ? <img src={downloadModal.plugin.icon_url} alt="" />
                  : <span className="dsc-modal-icon-placeholder"><i className="ti ti-puzzle" /></span>
                }
              </div>
              <div className="dsc-modal-title-block">
                <h3>{downloadModal.plugin.title}</h3>
                {downloadModal.plugin.author && <span>{downloadModal.plugin.author}</span>}
              </div>
              <button type="button" className="dsc-modal-close" onClick={() => setDownloadModal(null)} aria-label="Close">
                <i className="ti ti-x" />
              </button>
            </div>
            <div className="dsc-modal-body">
              {downloadModal.loading && <div className="dsc-loading-center"><div className="spinner" /><span>Fetching downloads…</span></div>}
              {downloadModal.error && (
                <div className="alert alert-error">
                  {downloadModal.error}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>Open in browser</button>
                </div>
              )}
              {!downloadModal.loading && !downloadModal.error && downloadModal.options.length === 0 && (
                <div className="dsc-modal-nofiles">
                  <i className="ti ti-file-off" />
                  <span>No direct downloads found.</span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>Open plugin page</button>
                </div>
              )}
              {!downloadModal.loading && !downloadModal.error && downloadModal.options.length > 0 && (
                <ul className="dsc-dl-list">
                  {downloadModal.options.map((opt, i) => (
                    <li key={i} className="dsc-dl-item">
                      <div className="dsc-dl-info">
                        <i className="ti ti-file-zip" />
                        <div>
                          <span className="dsc-dl-label">{opt.label}</span>
                          {opt.size   && <span className="dsc-dl-meta">{opt.size}</span>}
                          {opt.source && <span className="dsc-dl-meta">{opt.source}</span>}
                        </div>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" onClick={async () => {
                        try { await onInstallFromUrl(opt.url); setDownloadModal(null); } catch {}
                      }}>
                        <i className="ti ti-download" /> Install
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="dsc-modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>
                <i className="ti ti-external-link" /> View on forum
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Layout: sidebar + main ── */}
      <div className="dsc-layout">

        {/* ═══ SIDEBAR ═══ */}
        <aside className="dsc-sidebar">

          {/* search */}
          <div className="dsc-sb-search">
            <i className="ti ti-search dsc-sb-search-icon" />
            <input
              ref={searchInputRef}
              type="search"
              className="dsc-sb-search-input"
              placeholder="Search…"
              value={forumSearch}
              onChange={e => handleSearchChange(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") searchForum(); }}
              aria-label="Search OBS resources"
            />
            {forumSearch && (
              <button type="button" className="dsc-sb-search-clear" onClick={() => { setForumSearch(""); setLiveSearch(""); setSearchResults(null); }} aria-label="Clear">
                <i className="ti ti-x" />
              </button>
            )}
          </div>
          <button type="button" className="dsc-sb-search-btn" onClick={searchForum} disabled={!forumSearch.trim() || searchLoading || forumLoading}>
            {searchLoading ? <><span className="dsc-btn-spinner" /> Searching…</> : <><i className="ti ti-search" /> Search on forum</>}
          </button>

          <div className="dsc-sb-divider" />

          {/* categories */}
          <p className="dsc-sb-label">Browse</p>
          <nav className="dsc-sb-nav" aria-label="Categories">
            {(["plugins","themes","tools","scripts"] as ForumCategory[]).map(cat => {
              const m = SIDEBAR_CAT_META[cat];
              const active = forumCategory === cat && !isSearchMode;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`dsc-sb-cat ${active ? "active" : ""}`}
                  onClick={() => {
                    setForumCategory(cat);
                    setSearchResults(null);
                    setForumSearch("");
                    setLiveSearch("");
                    setCurrentPage(1);
                    setActiveTag(null);
                    loadForumPlugins(false, cat);
                  }}
                  disabled={forumLoading}
                  style={{ "--cat-color": m.color } as React.CSSProperties}
                >
                  <span className="dsc-sb-cat-dot" />
                  <i className={`ti ${m.icon}`} />
                  <span className="dsc-sb-cat-label">{m.label}</span>
                  {!isSearchMode && forumCategory === cat && forumPlugins.length > 0 && (
                    <span className="dsc-sb-cat-count">{forumPlugins.length.toLocaleString()}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="dsc-sb-divider" />

          {/* filters */}
          <p className="dsc-sb-label">Filters</p>
          <div className="dsc-sb-filters">
            <label className={`dsc-sb-toggle ${showFavoritesOnly ? "active" : ""}`}>
              <input type="checkbox" checked={showFavoritesOnly} onChange={e => { setShowFavoritesOnly(e.target.checked); setCurrentPage(1); }} />
              <i className="ti ti-heart" />
              Favorites
              {favorites.length > 0 && <span className="dsc-sb-cat-count">{favorites.length}</span>}
            </label>
            <label className={`dsc-sb-toggle ${showNotInstalled ? "active" : ""}`}>
              <input type="checkbox" checked={showNotInstalled} onChange={e => { setShowNotInstalled(e.target.checked); setCurrentPage(1); }} />
              <i className="ti ti-filter" />
              Not installed
            </label>
          </div>

          {/* tag cloud */}
          {tagCloud.length > 0 && !isSearchMode && (
            <>
              <div className="dsc-sb-divider" />
              <p className="dsc-sb-label">Tags</p>
              <div className="dsc-sb-tags">
                {tagCloud.map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    className={`dsc-sb-tag ${activeTag === tag ? "active" : ""}`}
                    onClick={() => { setActiveTag(activeTag === tag ? null : tag); setCurrentPage(1); }}
                  >
                    {tag}
                    <span>{count}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="dsc-sb-divider" />

          {/* scrape depth */}
          <p className="dsc-sb-label">Catalog depth</p>
          <div className="dsc-sb-depth">
            <div className="dsc-sb-depth-row">
              <span className="dsc-sb-depth-val">{maxPages} page{maxPages > 1 ? "s" : ""}</span>
              <span className="dsc-sb-depth-hint">~{maxPages * 20} resources</span>
            </div>
            <input
              type="range"
              min={1}
              max={15}
              value={maxPages}
              onChange={e => setMaxPages(Number(e.target.value))}
              className="dsc-sb-range"
              aria-label="Max pages to scrape"
            />
            <div className="dsc-sb-depth-labels"><span>Faster</span><span>More results</span></div>
            <button
              type="button"
              className="btn btn-primary btn-sm dsc-sb-load-btn"
              onClick={() => loadForumPlugins(true, forumCategory, maxPages)}
              disabled={forumLoading}
            >
              {forumLoading ? <><span className="dsc-btn-spinner" /> Loading…</> : <><i className="ti ti-refresh" /> Load catalog</>}
            </button>
          </div>

          <div className="dsc-sb-divider" />

          {/* quick links */}
          <div className="dsc-sb-links">
            <button type="button" className="dsc-sb-link" onClick={onOpenForum}>
              <i className="ti ti-external-link" /> OBS Forum
            </button>
            <button type="button" className="dsc-sb-link" onClick={onTestForum}>
              <i className="ti ti-wifi" /> Test connection
            </button>
          </div>
        </aside>

        {/* ═══ MAIN ═══ */}
        <main className="dsc-main">

          {/* ── stat bar ── */}
          {forumFetched && !isSearchMode && (
            <div className="dsc-statbar">
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">{forumPlugins.length.toLocaleString()}</span>
                <span className="dsc-stat-lbl">resources</span>
              </div>
              <div className="dsc-stat-sep" />
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">{installedCount}</span>
                <span className="dsc-stat-lbl">installed</span>
              </div>
              <div className="dsc-stat-sep" />
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">
                  {totalDownloads >= 1_000_000
                    ? `${(totalDownloads / 1_000_000).toFixed(1)}M`
                    : totalDownloads >= 1000
                    ? `${(totalDownloads / 1000).toFixed(0)}k`
                    : totalDownloads.toLocaleString()}
                </span>
                <span className="dsc-stat-lbl">total downloads</span>
              </div>
              <div className="dsc-stat-sep" />
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">{SIDEBAR_CAT_META[forumCategory].label}</span>
                <span className="dsc-stat-lbl">category</span>
              </div>
            </div>
          )}

          {/* ── error ── */}
          {forumError && (
            <div className="alert alert-error dsc-error-bar">
              <i className="ti ti-alert-circle" />
              <span>{forumError}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadForumPlugins(true)}>Retry</button>
            </div>
          )}

          {/* ── search mode header ── */}
          {isSearchMode && (
            <div className="dsc-search-header">
              <div className="dsc-search-tag">
                <i className="ti ti-search" />
                <span>Results for <strong>"{forumSearch}"</strong></span>
                <span className="dsc-search-tag-count">{filtered.length} found</span>
                <button type="button" className="dsc-tag-clear" onClick={() => { setSearchResults(null); setForumSearch(""); setLiveSearch(""); }} aria-label="Clear">
                  <i className="ti ti-x" />
                </button>
              </div>
            </div>
          )}

          {/* ── toolbar ── */}
          <div className="dsc-toolbar">
            <span className="dsc-count">
              {forumLoading
                ? <><span className="dsc-loading-dot" /> Loading…</>
                : <>{filtered.length.toLocaleString()} result{filtered.length !== 1 ? "s" : ""}{liveSearch && !isSearchMode ? ` for "${liveSearch}"` : ""}</>
              }
            </span>
            <div className="dsc-toolbar-right">
              {activeTag && (
                <button type="button" className="dsc-active-tag" onClick={() => setActiveTag(null)}>
                  <i className="ti ti-tag" /> {activeTag} <i className="ti ti-x" />
                </button>
              )}
              <select className="dsc-sort-select" value={forumSort} onChange={e => { setForumSort(e.target.value as ForumSort); setCurrentPage(1); }} aria-label="Sort">
                <option value="downloads">Most downloaded</option>
                <option value="rating">Highest rated</option>
                <option value="id">Most recent</option>
                <option value="name">A → Z</option>
              </select>
              <div className="dsc-view-toggle" role="group" aria-label="View mode">
                <button type="button" className={`dsc-view-btn ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")} title="Grid view" aria-pressed={view === "grid"}>
                  <i className="ti ti-grid-dots" />
                </button>
                <button type="button" className={`dsc-view-btn ${view === "list" ? "active" : ""}`} onClick={() => setView("list")} title="List view" aria-pressed={view === "list"}>
                  <i className="ti ti-list" />
                </button>
              </div>
            </div>
          </div>

          {/* ── skeleton loading (initial) ── */}
          {forumLoading && !forumFetched && (
            <div className={`dsc-grid dsc-grid--${view}`}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className={`dsc-skeleton ${view === "list" ? "dsc-skeleton--list" : ""}`}>
                  <div className="dsc-skel-icon" />
                  <div className="dsc-skel-lines">
                    <div className="dsc-skel-line dsc-skel-title" />
                    <div className="dsc-skel-line dsc-skel-sub" />
                    <div className="dsc-skel-line dsc-skel-desc" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── empty ── */}
          {!forumLoading && forumFetched && filtered.length === 0 && (
            <div className="dsc-empty">
              <i className="ti ti-mood-empty" />
              <p>{isSearchMode ? `No results for "${forumSearch}"` : showFavoritesOnly ? "No favorites yet" : activeTag ? `No results for tag "${activeTag}"` : "No plugins found"}</p>
              {isSearchMode && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => {
                  const url = `https://obsproject.com/forum/search/?type=resource&keywords=${encodeURIComponent(forumSearch)}`;
                  invoke("open_url", { url });
                }}>
                  <i className="ti ti-external-link" /> Search on forum website
                </button>
              )}
            </div>
          )}

          {/* ── plugin cards ── */}
          {(!forumLoading || forumFetched) && filtered.length > 0 && (
            <ul className={`dsc-grid dsc-grid--${view}`} role="list">
              {paginated.map(p => {
                const installed = isInstalled(p.title);
                const isFav    = favorites.includes(p.id);
                if (view === "list") {
                  return (
                    <li key={p.id} className={`dsc-row ${installed ? "dsc-row--installed" : ""}`} role="listitem">
                      <div className="dsc-row-icon">
                        {p.icon_url
                          ? <img src={p.icon_url} alt="" loading="lazy" />
                          : <i className="ti ti-puzzle" />
                        }
                      </div>
                      <div className="dsc-row-body">
                        <div className="dsc-row-top">
                          <h3 className="dsc-row-name">{p.title}</h3>
                          {p.prefix && <span className="dsc-prefix">{p.prefix}</span>}
                          {installed && <span className="dsc-badge-installed"><i className="ti ti-check" /> Installed</span>}
                        </div>
                        <div className="dsc-row-meta">
                          {p.author && <span><i className="ti ti-user" /> {p.author}</span>}
                          {p.version && <span>v{p.version}</span>}
                          {p.downloads != null && <span><i className="ti ti-download" /> {p.downloads >= 1000 ? `${(p.downloads/1000).toFixed(1)}k` : p.downloads}</span>}
                          {p.rating && <span className="dsc-stat--star"><i className="ti ti-star" /> {p.rating}{p.rating_count ? ` (${p.rating_count})` : ""}</span>}
                          {p.updated && <span><i className="ti ti-clock" /> {p.updated}</span>}
                        </div>
                        {p.description && <p className="dsc-row-desc">{p.description}</p>}
                      </div>
                      <div className="dsc-row-actions">
                        <button type="button" className={`dsc-fav-btn ${isFav ? "active" : ""}`} onClick={() => onToggleFavorite(p.id)} title={isFav ? "Unfavorite" : "Favorite"}>
                          <i className={`ti ti-heart${isFav ? "-filled" : ""}`} />
                        </button>
                        {!readOnly && (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => openDownloadModal(p)}>
                            <i className="ti ti-download" /> {installed ? "Reinstall" : "Install"}
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenPluginUrl(p.url)} title="Forum page">
                          <i className="ti ti-external-link" />
                        </button>
                      </div>
                    </li>
                  );
                }
                // grid card
                return (
                  <li key={p.id} className={`dsc-card ${installed ? "dsc-card--installed" : ""}`} role="listitem">
                    <div className="dsc-card-head">
                      <div className="dsc-card-icon">
                        {p.icon_url ? <img src={p.icon_url} alt="" loading="lazy" /> : <i className="ti ti-puzzle" />}
                      </div>
                      <div className="dsc-card-title-wrap">
                        <h3 className="dsc-card-name">{p.title}</h3>
                        {p.author && <span className="dsc-card-author">{p.author}</span>}
                      </div>
                      <button type="button" className={`dsc-fav-btn ${isFav ? "active" : ""}`} onClick={() => onToggleFavorite(p.id)} title={isFav ? "Unfavorite" : "Favorite"}>
                        <i className={`ti ti-heart${isFav ? "-filled" : ""}`} />
                      </button>
                    </div>
                    {p.prefix && <span className="dsc-prefix">{p.prefix}</span>}
                    {p.description && <p className="dsc-card-desc">{p.description}</p>}
                    <div className="dsc-card-stats">
                      {p.downloads != null && <span className="dsc-stat"><i className="ti ti-download" />{p.downloads >= 1000 ? `${(p.downloads/1000).toFixed(1)}k` : p.downloads}</span>}
                      {p.rating && <span className="dsc-stat dsc-stat--star"><i className="ti ti-star" />{p.rating}</span>}
                      {p.updated && <span className="dsc-stat"><i className="ti ti-clock" />{p.updated}</span>}
                      {p.version && <span className="dsc-stat dsc-stat--version">v{p.version}</span>}
                    </div>
                    <div className="dsc-card-foot">
                      {installed && <span className="dsc-badge-installed"><i className="ti ti-check" /> Installed</span>}
                      {!readOnly && (
                        <button type="button" className={`btn btn-sm ${installed ? "btn-outline" : "btn-primary"} dsc-install-btn`} onClick={() => openDownloadModal(p)}>
                          <i className="ti ti-download" /> {installed ? "Reinstall" : "Install"}
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm dsc-view-forum-btn" onClick={() => onOpenPluginUrl(p.url)} title="Forum page">
                        <i className="ti ti-external-link" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* ── pagination ── */}
          {totalPages > 1 && (
            <nav className="dsc-pagination" aria-label="Pagination">
              <button type="button" className="dsc-page-btn" onClick={() => setCurrentPage(1)} disabled={currentPage <= 1} title="First page">
                <i className="ti ti-chevrons-left" />
              </button>
              <button type="button" className="dsc-page-btn" onClick={() => setCurrentPage(p => Math.max(1, p-1))} disabled={currentPage <= 1} aria-label="Previous">
                <i className="ti ti-chevron-left" />
              </button>
              {pageNums.map((item, i) =>
                item === "…"
                  ? <span key={`e${i}`} className="dsc-page-ellipsis">…</span>
                  : <button key={item} type="button" className={`dsc-page-btn ${item === currentPage ? "active" : ""}`} onClick={() => setCurrentPage(item as number)} aria-current={item === currentPage ? "page" : undefined}>{item}</button>
              )}
              <button type="button" className="dsc-page-btn" onClick={() => setCurrentPage(p => Math.min(totalPages, p+1))} disabled={currentPage >= totalPages} aria-label="Next">
                <i className="ti ti-chevron-right" />
              </button>
              <button type="button" className="dsc-page-btn" onClick={() => setCurrentPage(totalPages)} disabled={currentPage >= totalPages} title="Last page">
                <i className="ti ti-chevrons-right" />
              </button>
              <span className="dsc-page-info">Page {currentPage} / {totalPages}</span>
            </nav>
          )}
        </main>
      </div>
    </section>
  );
}

/**
 * Options page: custom paths, auto-backup, read-only, theme, export/import.
 */

// ─────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────
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

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  const NAV_ITEMS: { id: Page; icon: string; label: string }[] = [
    { id: "home",     icon: "ti-home",        label: t.home     },
    { id: "discover", icon: "ti-compass",     label: t.discover },
    { id: "logs",     icon: "ti-list-check",  label: t.logs     },
    { id: "options",  icon: "ti-settings",    label: t.options  },
  ];

  return (
    <div className="app-shell">
      {/* ── Sidebar nav ── */}
      <aside className="app-sidebar">
        <div className="app-sidebar-logo">
          <img src={logo} alt="LamaWorlds" className="app-sidebar-logo-img" />
          <div className="app-sidebar-logo-text">
            <span className="app-sidebar-brand">LamaWorlds</span>
            <span className="app-sidebar-sub">OBS Plugin Manager</span>
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
            >
              <i className={`ti ${item.icon} app-nav-icon`} aria-hidden="true" />
              <span className="app-nav-label">{item.label}</span>
              {item.id === "home" && pluginUpdates.length > 0 && (
                <span className="app-nav-badge" title={`${pluginUpdates.length} update${pluginUpdates.length > 1 ? "s" : ""}`}>
                  {pluginUpdates.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="app-sidebar-bottom">
          <div className="app-obs-status" title={obsRunning ? "OBS Studio is running" : "OBS Studio is not running"}>
            <span className={`app-obs-dot ${obsRunning ? "app-obs-dot--on" : "app-obs-dot--off"}`} />
            <span className="app-obs-label">OBS {obsRunning ? "running" : "not running"}</span>
          </div>
          {readOnly && (
            <div className="app-readonly-badge">
              <i className="ti ti-lock" /> Read-only
            </div>
          )}
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className={`app-content ${page === "discover" ? "app-content--wide" : ""}`} ref={contentRef}>
        {/* global error */}
        {error && (
          <div className="alert alert-error app-global-alert">
            <i className="ti ti-alert-circle" />
            <span>{error}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
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
            toast={toast}
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
      </main>

      {showScrollTop && (
        <button type="button" className="scroll-top-btn" onClick={scrollToTop} aria-label="Scroll to top">
          <i className="ti ti-arrow-up" />
        </button>
      )}
    </div>
  );
}

export default App;
