/**
 * Options — theme, language, OBS paths, backups, profiles, and debug.
 */
import { t, type Lang } from "../i18n";
import type { ThemeMode } from "../types";

export interface OptionsPageProps {
  customPluginsPath: string;
  customObsPath: string;
  autoBackup: boolean;
  onAutoBackupChange: (v: boolean) => void;
  readOnly: boolean;
  onReadOnlyChange: (v: boolean) => void;
  configPath: string | null;
  obsModulesPath: string | null;
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
  theme: ThemeMode;
  onThemeChange: (v: ThemeMode) => void;
  lang: Lang;
  onLangChange: (v: Lang) => void;
}

export function OptionsPage({
  customPluginsPath,
  customObsPath,
  autoBackup,
  onAutoBackupChange,
  readOnly,
  onReadOnlyChange,
  configPath,
  obsModulesPath,
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
}: OptionsPageProps) {
  return (
    <div className="opt-page">
      {/* ─── Appearance ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-palette" />
          <h2>{t.appearance}</h2>
        </div>
        <div className="opt-row">
          <div className="opt-label-block">
            <span>{t.theme}</span>
            <span className="opt-hint">{t.themeHint}</span>
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
            <span>{t.language}</span>
            <span className="opt-hint">{t.languageHint}</span>
          </div>
          <select className="dsc-sort-select" value={lang} onChange={e => onLangChange(e.target.value as Lang)} aria-label={t.language}>
            <option value="en">🇬🇧 English</option>
            <option value="fr">🇫🇷 Français</option>
          </select>
        </div>
      </div>

      {/* ─── Paths ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-folders" />
          <h2>{t.paths}</h2>
          <span className="opt-section-sub">{t.pathsHint}</span>
        </div>
        <div className="opt-path-row">
          <label className="opt-path-label">
            <i className="ti ti-puzzle" /> {t.pluginsFolder}
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
            <i className="ti ti-brand-obs" /> {t.obsInstallFolder}
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
            {saving ? <><span className="hq-spinner" /> {t.saving}</> : <><i className="ti ti-device-floppy" /> {t.savePaths}</>}
          </button>
        </div>
      </div>

      {/* ─── Behavior ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-settings" />
          <h2>{t.behavior}</h2>
        </div>
        <div className="opt-toggle-row">
          <div className="opt-label-block">
            <span>{t.autoBackup}</span>
            <span className="opt-hint">{t.autoBackupDesc}</span>
          </div>
          <label className="opt-switch">
            <input type="checkbox" checked={autoBackup} onChange={e => onAutoBackupChange(e.target.checked)} />
            <span className="opt-switch-track" />
          </label>
        </div>
        <div className="opt-toggle-row">
          <div className="opt-label-block">
            <span>{t.readOnly}</span>
            <span className="opt-hint">{t.readOnlyDesc}</span>
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
          <h2>{t.profiles}</h2>
          <span className="opt-section-sub">{t.profilesDesc}</span>
        </div>
        <div className="opt-action-grid">
          <button type="button" className="opt-action-btn" onClick={onSaveProfile} disabled={readOnly}>
            <i className="ti ti-device-floppy" />
            <span>{t.saveProfile}</span>
            <span className="opt-action-hint">{t.saveProfileHint}</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onApplyProfile} disabled={readOnly}>
            <i className="ti ti-player-play" />
            <span>{t.applyProfile}</span>
            <span className="opt-action-hint">{t.applyProfileHint}</span>
          </button>
        </div>
      </div>

      {/* ─── Backup & Config ─── */}
      <div className="opt-section">
        <div className="opt-section-head">
          <i className="ti ti-database" />
          <h2>{t.backupConfig}</h2>
        </div>
        <div className="opt-action-grid">
          <button type="button" className="opt-action-btn" onClick={onBackupAll}>
            <i className="ti ti-archive" />
            <span>{t.backupAll}</span>
            <span className="opt-action-hint">{t.backupAllDesc}</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onExport}>
            <i className="ti ti-file-export" />
            <span>{t.exportConfig}</span>
            <span className="opt-action-hint">{t.exportConfigHint}</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onImport}>
            <i className="ti ti-file-import" />
            <span>{t.importConfig}</span>
            <span className="opt-action-hint">{t.importConfigHint}</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onExportFavorites}>
            <i className="ti ti-heart" />
            <span>{t.exportFavorites}</span>
            <span className="opt-action-hint">{t.exportFavoritesHint}</span>
          </button>
          <button type="button" className="opt-action-btn" onClick={onImportFavorites}>
            <i className="ti ti-heart-plus" />
            <span>{t.importFavorites}</span>
            <span className="opt-action-hint">{t.importFavoritesHint}</span>
          </button>
        </div>
      </div>

      {/* ─── Debug ─── */}
      <div className="opt-section opt-section--debug">
        <div className="opt-section-head">
          <i className="ti ti-bug" />
          <h2>{t.debug}</h2>
        </div>
        <div className="opt-debug-row">
          <span className="opt-hint">{t.configPath}</span>
          <code className="opt-code">{configPath || "—"}</code>
        </div>
        <div className="opt-debug-row">
          <span className="opt-hint">{t.obsModulesFile}</span>
          <code className="opt-code">{obsModulesPath || t.obsModulesUnavailable}</code>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenLog}>
          <i className="ti ti-folder-open" /> {t.openLog}
        </button>
      </div>
    </div>
  );
}
