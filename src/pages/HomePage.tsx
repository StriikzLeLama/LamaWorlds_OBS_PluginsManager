import { useState, useCallback, useMemo } from "react";
import type { ObsPluginInfo, ObsPaths, SortBy, StatusFilter, ViewMode, PluginUpdateInfo } from "../types";
import { formatDate } from "../utils/format";
import { t } from "../i18n";
/**
 * Home page: lists installed OBS plugins with search, sort, filter.
 * Shows paths, plugin actions (disable/enable/uninstall), and action history.
 */
// ─────────────────────────────────────────────────────────────────────────
// Home Page
// ─────────────────────────────────────────────────────────────────────────
export function HomePage({
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
            <span className="hstat-lbl">{t.totalPlugins}</span>
          </div>
        </div>
        <div className="hstat-card">
          <div className="hstat-icon hstat-icon--active"><i className="ti ti-check" /></div>
          <div className="hstat-body">
            <span className="hstat-num hstat-num--green">{activeCount}</span>
            <span className="hstat-lbl">{t.active}</span>
          </div>
        </div>
        <div className="hstat-card">
          <div className="hstat-icon hstat-icon--off"><i className="ti ti-eye-off" /></div>
          <div className="hstat-body">
            <span className="hstat-num hstat-num--muted">{disabledCount}</span>
            <span className="hstat-lbl">{t.disabled}</span>
          </div>
        </div>
        {updateCount > 0 && (
          <div className="hstat-card hstat-card--updates">
            <div className="hstat-icon hstat-icon--update"><i className="ti ti-arrow-up" /></div>
            <div className="hstat-body">
              <span className="hstat-num hstat-num--orange">{updateCount}</span>
              <span className="hstat-lbl">{t.updates}</span>
            </div>
          </div>
        )}
        <div className="hstat-card hstat-card--obs">
          <div className="hstat-icon" style={{ background: obsRunning ? "var(--danger-bg)" : "var(--surface-2)", color: obsRunning ? "var(--danger)" : "var(--success)" }}>
            <i className={`ti ${obsRunning ? "ti-player-stop" : "ti-circle-check"}`} />
          </div>
          <div className="hstat-body">
            <span className="hstat-num" style={{ color: obsRunning ? "var(--danger)" : "var(--success)", fontSize: "0.85rem", fontWeight: 600 }}>
              {obsRunning ? t.running : t.notRunning}
            </span>
            <span className="hstat-lbl">{t.obsStudio}</span>
          </div>
        </div>
      </div>

      {/* ─── Quick actions bar ─── */}
      <div className="home-quickbar">
        <button type="button" className="hqb-btn hqb-btn--primary" onClick={() => setInstallPanelOpen(v => !v)} disabled={readOnly}>
          <i className="ti ti-download" /> {t.installPlugin}
          <i className={`ti ti-chevron-${installPanelOpen ? "up" : "down"} hqb-chevron`} />
        </button>
        <button type="button" className="hqb-btn" onClick={onRefresh} disabled={loading}>
          <i className={`ti ti-refresh ${loading ? "spin-icon" : ""}`} /> {t.refresh}
        </button>
        <button type="button" className="hqb-btn" onClick={onOpenPluginsFolder}>
          <i className="ti ti-folder-open" /> {t.openFolder}
        </button>
        <button type="button" className="hqb-btn" onClick={onExportPluginsJson}>
          <i className="ti ti-file-export" /> {t.exportJson}
        </button>
        <button type="button" className="hqb-btn" onClick={onExportPluginsCsv}>
          <i className="ti ti-table-export" /> {t.exportCsv}
        </button>
        <button type="button" className="hqb-btn" onClick={onOpenDownloads}>
          <i className="ti ti-folder-down" /> {t.openDownloads}
        </button>
      </div>

      {/* ─── Install panel (collapsible) ─── */}
      {installPanelOpen && (
        <div className="home-install-panel">
          <div className="hip-row">
            <div className="hip-field">
              <label className="hip-label"><i className="ti ti-link" /> {t.installFromUrl}</label>
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
                  {installLoading ? <><span className="hq-spinner" /> {t.installing}</> : t.install}
                </button>
              </div>
            </div>
            <div className="hip-field">
              <label className="hip-label"><i className="ti ti-clipboard" /> {t.pastePathHint}</label>
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
                  {t.install}
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
            <span>{importLoading ? t.installing : t.dropZoneHint}</span>
          </div>
          {importHistory.length > 0 && (
            <div className="hip-history">
              <span className="hip-history-lbl">{t.recentImports}:</span>
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
                <span>{t.custom}</span><code>{paths.custom_plugins_path}</code>
              </div>
            )}
            {paths?.plugins_path && (
              <div className="hpath-chip"><span>{t.plugins}</span><code>{paths.plugins_path}</code></div>
            )}
            {paths?.appdata_plugins && (
              <div className="hpath-chip"><span>{t.appData}</span><code>{paths.appdata_plugins}</code></div>
            )}
          </div>
        </div>
      )}

      {/* ─── Updates banner ─── */}
      {updateCount > 0 && (
        <div className="home-updates-banner">
          <div className="hub-left">
            <i className="ti ti-arrow-up-circle" />
            <strong>{t.updatesAvailableCount(updateCount)}</strong>
          </div>
          <div className="hub-items">
            {pluginUpdates?.slice(0, 3).map(u => (
              <div key={u.plugin_name} className="hub-item">
                <span className="hub-name">{u.plugin_name}</span>
                {u.installed_version && (
                  <span className="hub-ver">v{u.installed_version} → v{u.available_version ?? "?"}</span>
                )}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onUpdatePlugin?.(u)} disabled={readOnly || updatingPlugins?.has(u.plugin_name)}>
                  {updatingPlugins?.has(u.plugin_name) ? t.updating : t.updatePlugin}
                </button>
                {onOpenPluginUrl && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(u.forum_url)}>
                    <i className="ti ti-external-link" />
                  </button>
                )}
              </div>
            ))}
            {updateCount > 3 && <span className="hub-more">+{updateCount - 3}</span>}
          </div>
        </div>
      )}

      {/* ─── Plugin list section ─── */}
      <div className="home-plugins-section">
        {/* toolbar */}
        <div className="hp-toolbar">
          <div className="hp-toolbar-left">
            <h2 className="hp-title">
              {t.installedPlugins}
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
                placeholder={t.search}
                value={searchQuery}
                onChange={e => onSearchChange(e.target.value)}
                aria-label={t.search}
              />
              {searchQuery && (
                <button type="button" className="hp-search-clear" onClick={() => onSearchChange("")} aria-label={t.clear}>
                  <i className="ti ti-x" />
                </button>
              )}
            </div>
            <div className="hp-filter-group">
              <button type="button" className={`hp-filter-btn ${statusFilter === "all" ? "active" : ""}`} onClick={() => onStatusFilterChange("all")}>{t.all}</button>
              <button type="button" className={`hp-filter-btn ${statusFilter === "active" ? "active" : ""}`} onClick={() => onStatusFilterChange("active")}>
                <i className="ti ti-check" /> {t.active}
              </button>
              <button type="button" className={`hp-filter-btn ${statusFilter === "disabled" ? "active" : ""}`} onClick={() => onStatusFilterChange("disabled")}>
                <i className="ti ti-eye-off" /> {t.disabled}
              </button>
            </div>
            <select className="dsc-sort-select" value={sortBy} onChange={e => onSortChange(e.target.value as SortBy)}>
              <option value="name">{t.sortAZ}</option>
              <option value="date">{t.sortRecent}</option>
              <option value="path">{t.sortByPath}</option>
            </select>
            <div className="dsc-view-toggle">
              <button type="button" className={`dsc-view-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => onViewModeChange("list")} title={t.listView}>
                <i className="ti ti-list" />
              </button>
              <button type="button" className={`dsc-view-btn ${viewMode === "grid" ? "active" : ""}`} onClick={() => onViewModeChange("grid")} title={t.gridView}>
                <i className="ti ti-grid-dots" />
              </button>
            </div>
            <label className="hp-compact-toggle" title={t.compact}>
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
                {t.openPluginsFolder}
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
                      {updateInfo && <span className="hp-badge-update" title={t.updateAvailable}><i className="ti ti-arrow-up" /></span>}
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
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginFolder(plugin.path)} title={t.openFolder}><i className="ti ti-folder" /></button>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li key={key} className={`hp-item ${!plugin.enabled ? "hp-item--off" : ""} ${updateInfo ? "hp-item--update" : ""} ${compactMode ? "" : "hp-item--expandable"}`}>
                  <div className="hp-item-main" onClick={() => !compactMode && setExpandedPlugin(isExpanded ? null : key)} style={{ cursor: compactMode ? "default" : "pointer" }}>
                    <div className={`hp-status-dot ${plugin.enabled ? "hp-status-dot--on" : "hp-status-dot--off"}`} title={plugin.enabled ? t.active : t.disabled} />
                    <div className="hp-item-info">
                      <div className="hp-item-name">
                        {plugin.name}
                        {plugin.version && <span className="hp-ver"> v{plugin.version}</span>}
                        {!plugin.enabled && <span className="hp-badge-off">{t.disabled}</span>}
                        {updateInfo && <span className="hp-badge-update"><i className="ti ti-arrow-up" /> {t.updatePlugin}</span>}
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
                          <i className="ti ti-clock" /><span>{t.lastModified}: {formatDate(plugin.modified_time)}</span>
                        </div>
                      )}
                      {updateInfo && (
                        <div className="hp-detail-row hp-detail-update">
                          <i className="ti ti-arrow-up-circle" />
                          <span>{t.updateAvailable}: v{updateInfo.installed_version} → v{updateInfo.available_version ?? "?"}</span>
                          {onOpenPluginUrl && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(updateInfo.forum_url)}>
                              <i className="ti ti-external-link" /> {t.forum}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="hp-item-btns">
                    {updateInfo && onUpdatePlugin && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => onUpdatePlugin(updateInfo)} disabled={readOnly || updatingPlugins?.has(plugin.name)}>
                        <i className="ti ti-arrow-up" /> {updatingPlugins?.has(plugin.name) ? t.updating : t.updatePlugin}
                      </button>
                    )}
                    {plugin.enabled
                      ? <button type="button" className="btn btn-outline btn-sm" onClick={() => onDisable(plugin)} disabled={readOnly} title={t.disable}><i className="ti ti-eye-off" />{!compactMode && ` ${t.disable}`}</button>
                      : <button type="button" className="btn btn-success btn-sm" onClick={() => onEnable(plugin)} disabled={readOnly} title={t.enable}><i className="ti ti-eye" />{!compactMode && ` ${t.enable}`}</button>
                    }
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => onUninstall(plugin)} disabled={readOnly} title={t.uninstall}>
                      <i className="ti ti-trash" />{!compactMode && ` ${t.uninstall}`}
                    </button>
                    {onOpenPluginFolder && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginFolder(plugin.path)} title={t.openInFolder}>
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
