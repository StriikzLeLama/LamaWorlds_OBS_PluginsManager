import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  ForumPlugin,
  ForumSort,
  ForumCategory,
  DiscoverView,
  DownloadOption,
} from "../types";
import { PLUGINS_PER_PAGE } from "../types";
import { invoke } from "../tauriApi";
import { t } from "../i18n";

const SIDEBAR_CAT_META: Record<ForumCategory, { icon: string; color: string }> = {
  plugins: { icon: "ti-puzzle",  color: "#7c6dfa" },
  themes:  { icon: "ti-palette", color: "#f07f3c" },
  tools:   { icon: "ti-tool",    color: "#3cb8f0" },
  scripts: { icon: "ti-code",    color: "#4caf50" },
};

function catLabel(cat: ForumCategory): string {
  switch (cat) {
    case "plugins": return t.catPlugins;
    case "themes":  return t.catThemes;
    case "tools":   return t.catTools;
    case "scripts": return t.catScripts;
  }
}

/**
 * Discover — store-style page with sidebar nav, search hero, grid/list toggle,
 * configurable scrape depth (1–15 pages), tag cloud, and skeleton loading.
 */
export function DiscoverPage({
  installedPluginNames,
  favorites,
  searchInputRef,
  onToggleFavorite,
  onOpenForum,
  onOpenPluginUrl,
  onInstallFromUrl,
  onTestForum,
  readOnly,
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
              <button type="button" className="dsc-modal-close" onClick={() => setDownloadModal(null)} aria-label={t.close}>
                <i className="ti ti-x" />
              </button>
            </div>
            <div className="dsc-modal-body">
              {downloadModal.loading && <div className="dsc-loading-center"><div className="spinner" /><span>{t.fetchingDownloads}</span></div>}
              {downloadModal.error && (
                <div className="alert alert-error">
                  {downloadModal.error}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>{t.openInBrowser}</button>
                </div>
              )}
              {!downloadModal.loading && !downloadModal.error && downloadModal.options.length === 0 && (
                <div className="dsc-modal-nofiles">
                  <i className="ti ti-file-off" />
                  <span>{t.noDirectDownloads}</span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>{t.openPluginPage}</button>
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
                        <i className="ti ti-download" /> {t.install}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="dsc-modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenPluginUrl(downloadModal.plugin.url)}>
                <i className="ti ti-external-link" /> {t.viewOnForum}
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
              placeholder={t.search}
              value={forumSearch}
              onChange={e => handleSearchChange(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") searchForum(); }}
              aria-label={t.search}
            />
            {forumSearch && (
              <button type="button" className="dsc-sb-search-clear" onClick={() => { setForumSearch(""); setLiveSearch(""); setSearchResults(null); }} aria-label={t.clear}>
                <i className="ti ti-x" />
              </button>
            )}
          </div>
          <button type="button" className="dsc-sb-search-btn" onClick={searchForum} disabled={!forumSearch.trim() || searchLoading || forumLoading}>
            {searchLoading ? <><span className="dsc-btn-spinner" /> {t.searching}</> : <><i className="ti ti-search" /> {t.searchOnForum}</>}
          </button>

          <div className="dsc-sb-divider" />

          {/* categories */}
          <p className="dsc-sb-label">{t.browseCat}</p>
          <nav className="dsc-sb-nav" aria-label={t.categories}>
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
                  <span className="dsc-sb-cat-label">{catLabel(cat)}</span>
                  {!isSearchMode && forumCategory === cat && forumPlugins.length > 0 && (
                    <span className="dsc-sb-cat-count">{forumPlugins.length.toLocaleString()}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="dsc-sb-divider" />

          {/* filters */}
          <p className="dsc-sb-label">{t.filters}</p>
          <div className="dsc-sb-filters">
            <label className={`dsc-sb-toggle ${showFavoritesOnly ? "active" : ""}`}>
              <input type="checkbox" checked={showFavoritesOnly} onChange={e => { setShowFavoritesOnly(e.target.checked); setCurrentPage(1); }} />
              <i className="ti ti-heart" />
              {t.favorites}
              {favorites.length > 0 && <span className="dsc-sb-cat-count">{favorites.length}</span>}
            </label>
            <label className={`dsc-sb-toggle ${showNotInstalled ? "active" : ""}`}>
              <input type="checkbox" checked={showNotInstalled} onChange={e => { setShowNotInstalled(e.target.checked); setCurrentPage(1); }} />
              <i className="ti ti-filter" />
              {t.notInstalled}
            </label>
          </div>

          {/* tag cloud */}
          {tagCloud.length > 0 && !isSearchMode && (
            <>
              <div className="dsc-sb-divider" />
              <p className="dsc-sb-label">{t.tags}</p>
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
          <p className="dsc-sb-label">{t.catalogDepth}</p>
          <div className="dsc-sb-depth">
            <div className="dsc-sb-depth-row">
              <span className="dsc-sb-depth-val">{t.pagesCount(maxPages)}</span>
              <span className="dsc-sb-depth-hint">{t.approxResources(maxPages * 20)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={15}
              value={maxPages}
              onChange={e => setMaxPages(Number(e.target.value))}
              className="dsc-sb-range"
              aria-label={t.catalogDepth}
            />
            <div className="dsc-sb-depth-labels"><span>{t.faster}</span><span>{t.moreResults}</span></div>
            <button
              type="button"
              className="btn btn-primary btn-sm dsc-sb-load-btn"
              onClick={() => loadForumPlugins(true, forumCategory, maxPages)}
              disabled={forumLoading}
            >
              {forumLoading ? <><span className="dsc-btn-spinner" /> {t.loading}</> : <><i className="ti ti-refresh" /> {t.loadCatalog}</>}
            </button>
          </div>

          <div className="dsc-sb-divider" />

          {/* quick links */}
          <div className="dsc-sb-links">
            <button type="button" className="dsc-sb-link" onClick={onOpenForum}>
              <i className="ti ti-external-link" /> {t.openForum}
            </button>
            <button type="button" className="dsc-sb-link" onClick={onTestForum}>
              <i className="ti ti-wifi" /> {t.testForum}
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
                <span className="dsc-stat-lbl">{t.resources}</span>
              </div>
              <div className="dsc-stat-sep" />
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">{installedCount}</span>
                <span className="dsc-stat-lbl">{t.installed}</span>
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
                <span className="dsc-stat-lbl">{t.totalDownloads}</span>
              </div>
              <div className="dsc-stat-sep" />
              <div className="dsc-stat-item">
                <span className="dsc-stat-num">{catLabel(forumCategory)}</span>
                <span className="dsc-stat-lbl">{t.category}</span>
              </div>
            </div>
          )}

          {/* ── error ── */}
          {forumError && (
            <div className="alert alert-error dsc-error-bar">
              <i className="ti ti-alert-circle" />
              <span>{forumError}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadForumPlugins(true)}>{t.retry}</button>
            </div>
          )}

          {/* ── search mode header ── */}
          {isSearchMode && (
            <div className="dsc-search-header">
              <div className="dsc-search-tag">
                <i className="ti ti-search" />
                <span>{t.resultsFor} <strong>"{forumSearch}"</strong></span>
                <span className="dsc-search-tag-count">{filtered.length} {t.found}</span>
                <button type="button" className="dsc-tag-clear" onClick={() => { setSearchResults(null); setForumSearch(""); setLiveSearch(""); }} aria-label={t.clear}>
                  <i className="ti ti-x" />
                </button>
              </div>
            </div>
          )}

          {/* ── toolbar ── */}
          <div className="dsc-toolbar">
            <span className="dsc-count">
              {forumLoading
                ? <><span className="dsc-loading-dot" /> {t.loading}</>
                : <>{t.resultsCount(filtered.length)}{liveSearch && !isSearchMode ? ` ${t.resultsFor.toLowerCase()} "${liveSearch}"` : ""}</>
              }
            </span>
            <div className="dsc-toolbar-right">
              {activeTag && (
                <button type="button" className="dsc-active-tag" onClick={() => setActiveTag(null)}>
                  <i className="ti ti-tag" /> {activeTag} <i className="ti ti-x" />
                </button>
              )}
              <select className="dsc-sort-select" value={forumSort} onChange={e => { setForumSort(e.target.value as ForumSort); setCurrentPage(1); }} aria-label={t.sortByName}>
                <option value="downloads">{t.mostDownloaded}</option>
                <option value="rating">{t.highestRated}</option>
                <option value="id">{t.mostRecent}</option>
                <option value="name">{t.sortAZ}</option>
              </select>
              <div className="dsc-view-toggle" role="group" aria-label={t.listView}>
                <button type="button" className={`dsc-view-btn ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")} title={t.gridView} aria-pressed={view === "grid"}>
                  <i className="ti ti-grid-dots" />
                </button>
                <button type="button" className={`dsc-view-btn ${view === "list" ? "active" : ""}`} onClick={() => setView("list")} title={t.listView} aria-pressed={view === "list"}>
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
              <p>{isSearchMode ? t.noResultsFor(forumSearch) : showFavoritesOnly ? t.noFavoritesYet : activeTag ? t.noResultsForTag(activeTag) : t.noForumPlugin}</p>
              {isSearchMode && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => {
                  const url = `https://obsproject.com/forum/search/?type=resource&keywords=${encodeURIComponent(forumSearch)}`;
                  invoke("open_url", { url });
                }}>
                  <i className="ti ti-external-link" /> {t.searchOnForumWebsite}
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
                          {installed && <span className="dsc-badge-installed"><i className="ti ti-check" /> {t.installed}</span>}
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
                        <button type="button" className={`dsc-fav-btn ${isFav ? "active" : ""}`} onClick={() => onToggleFavorite(p.id)} title={isFav ? t.removeFromFav : t.addToFav}>
                          <i className={`ti ti-heart${isFav ? "-filled" : ""}`} />
                        </button>
                        {!readOnly && (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => openDownloadModal(p)}>
                            <i className="ti ti-download" /> {installed ? t.reinstall : t.install}
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenPluginUrl(p.url)} title={t.viewOnForum}>
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
                      <button type="button" className={`dsc-fav-btn ${isFav ? "active" : ""}`} onClick={() => onToggleFavorite(p.id)} title={isFav ? t.removeFromFav : t.addToFav}>
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
                      {installed && <span className="dsc-badge-installed"><i className="ti ti-check" /> {t.installed}</span>}
                      {!readOnly && (
                        <button type="button" className={`btn btn-sm ${installed ? "btn-outline" : "btn-primary"} dsc-install-btn`} onClick={() => openDownloadModal(p)}>
                          <i className="ti ti-download" /> {installed ? t.reinstall : t.install}
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm dsc-view-forum-btn" onClick={() => onOpenPluginUrl(p.url)} title={t.viewOnForum}>
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
              <span className="dsc-page-info">{t.pageOf(currentPage, totalPages)}</span>
            </nav>
          )}
        </main>
      </div>
    </section>
  );
}
