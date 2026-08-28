/**
 * Logs — in-session action timeline plus the backend plugin-manager.log file.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ActionLog } from "../types";
import { invoke } from "../tauriApi";
import { t } from "../i18n";

const ACTION_ICONS: Record<string, string> = {
  Refresh: "ti-refresh",
  Installed: "ti-download",
  Updated: "ti-arrow-up",
  Uninstalled: "ti-trash",
  Disabled: "ti-eye-off",
  Enabled: "ti-eye",
  Backup: "ti-archive",
  Export: "ti-file-export",
  Import: "ti-file-import",
  Profile: "ti-device-floppy",
  Config: "ti-settings",
};

function iconForAction(action: string): string {
  const hit = Object.entries(ACTION_ICONS).find(([key]) =>
    action.toLowerCase().includes(key.toLowerCase()),
  );
  return hit?.[1] ?? "ti-point";
}

export interface LogsPageProps {
  actionLog: ActionLog[];
  onOpenLog: () => void;
}

export function LogsPage({ actionLog, onOpenLog }: LogsPageProps) {
  const [backendLog, setBackendLog] = useState<string | null>(null);
  const [backendLogError, setBackendLogError] = useState<string | null>(null);
  const [backendLogLoading, setBackendLogLoading] = useState(true);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"actions" | "backend">("actions");
  const [filterText, setFilterText] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

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
      .then((d) => setLogDir(d ?? null))
      .catch(() => setLogDir(null));
  }, [loadBackendLog]);

  useEffect(() => {
    if (activeTab === "backend") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [backendLog, activeTab]);

  const filteredActions = useMemo(() => {
    if (!filterText.trim()) return actionLog;
    const q = filterText.toLowerCase();
    return actionLog.filter(
      (a) =>
        a.action.toLowerCase().includes(q) ||
        (a.plugin?.toLowerCase().includes(q) ?? false) ||
        (a.details?.toLowerCase().includes(q) ?? false),
    );
  }, [actionLog, filterText]);

  return (
    <div className="logs-page-v2">
      <div className="logs-tabs">
        <button
          type="button"
          className={`logs-tab ${activeTab === "actions" ? "active" : ""}`}
          onClick={() => setActiveTab("actions")}
        >
          <i className="ti ti-list-check" /> {t.actionHistory}
          {actionLog.length > 0 && <span className="logs-tab-badge">{actionLog.length}</span>}
        </button>
        <button
          type="button"
          className={`logs-tab ${activeTab === "backend" ? "active" : ""}`}
          onClick={() => setActiveTab("backend")}
        >
          <i className="ti ti-terminal" /> {t.backendLog}
        </button>
        <div className="logs-tabs-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
          <i className="ti ti-folder-open" /> {t.openLog}
        </button>
      </div>

      {activeTab === "actions" && (
        <div className="logs-actions-pane">
          <div className="logs-filter-bar">
            <i className="ti ti-search" />
            <input
              type="search"
              className="logs-filter-input"
              placeholder={t.filterEvents}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            {filterText && (
              <button
                type="button"
                className="dsc-sb-search-clear"
                onClick={() => setFilterText("")}
                aria-label={t.clear}
              >
                <i className="ti ti-x" />
              </button>
            )}
            <span className="logs-filter-count">{t.eventsCount(filteredActions.length)}</span>
          </div>

          {filteredActions.length === 0 ? (
            <div className="logs-empty">
              <i className="ti ti-ghost" />
              <p>{filterText ? t.noEventsMatch : t.noRecentAction}</p>
            </div>
          ) : (
            <ul className="logs-timeline">
              {filteredActions.map((a, idx) => {
                const isFirst = idx === 0 || filteredActions[idx - 1].date !== a.date;
                return (
                  <li key={a.id} className="logs-entry">
                    {isFirst && <div className="logs-date-sep">{a.date}</div>}
                    <div className="logs-entry-inner">
                      <div className="logs-entry-icon">
                        <i className={`ti ${iconForAction(a.action)}`} />
                      </div>
                      <div className="logs-entry-body">
                        <div className="logs-entry-top">
                          <span className="logs-entry-action">{a.action}</span>
                          {a.plugin && (
                            <span className="logs-entry-plugin">
                              <i className="ti ti-puzzle" /> {a.plugin}
                            </span>
                          )}
                          <span className="logs-entry-time">{a.time}</span>
                        </div>
                        {a.details && (
                          <div className="logs-entry-details">
                            {a.details.length > 120 ? `${a.details.slice(0, 120)}…` : a.details}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {activeTab === "backend" && (
        <div className="logs-backend-pane">
          <div className="logs-backend-header">
            {logDir && <code className="opt-code">{logDir}</code>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadBackendLog}>
              <i className="ti ti-refresh" /> {t.refresh}
            </button>
          </div>
          {backendLogLoading ? (
            <div className="dsc-loading-center" style={{ padding: "3rem" }}>
              <div className="spinner" />
              <span>{t.loadingLog}</span>
            </div>
          ) : backendLogError ? (
            <div className="alert alert-error">{backendLogError}</div>
          ) : backendLog?.trim() ? (
            <pre className="logs-backend-pre">{backendLog}</pre>
          ) : (
            <div className="logs-empty">
              <i className="ti ti-ghost" />
              <p>{t.logEmpty}</p>
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
