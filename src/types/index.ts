/**
 * Shared types and UI constants for LamaWorlds OBS Plugin Manager.
 */

/** Plugin discovered on disk (folder under plugins/ or a .dll under obs-plugins/64bit). */
export interface ObsPluginInfo {
  name: string;
  path: string;
  /** Folder or file to delete / rename when uninstalling or toggling. */
  uninstall_path: string;
  enabled: boolean;
  version: string | null;
  /** Unix timestamp in seconds, from filesystem mtime. */
  modified_time?: number | null;
  /** DLL stems this plugin ships; these are the names OBS uses for modules. */
  module_names?: string[];
  /** Enabled state reported by OBS 32's own plugin manager, when it tracks it. */
  obs_enabled?: boolean | null;
  /**
   * True when OBS lists this as a manageable module. A DLL in obs-plugins/64bit
   * without an entry is almost certainly one of OBS's built-ins.
   */
  obs_managed?: boolean;
  /** Friendly name OBS reports for the module. */
  obs_display_name?: string | null;
  /**
   * A bare DLL OBS does not list as a module: either part of OBS itself, or a
   * helper library owned by another plugin. Neither is removable on its own,
   * so the UI locks the destructive actions.
   */
  support_dll?: boolean;
}

/** One entry of OBS 32's plugin manager state (modules.json). */
export interface ObsModuleInfo {
  module_name: string;
  enabled: boolean;
  display_name?: string | null;
  version?: string | null;
  sources?: string[];
}

export interface ObsPaths {
  plugins_path: string | null;
  obs_install_path: string | null;
  appdata_plugins: string | null;
  custom_plugins_path: string | null;
  custom_obs_install_path: string | null;
}

export interface AppConfig {
  custom_plugins_path?: string | null;
  custom_obs_install_path?: string | null;
  forum_favorites?: string[];
  auto_backup?: boolean;
  read_only?: boolean;
}

/** One resource scraped from obsproject.com/forum. */
export interface ForumPlugin {
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
  /** Forum prefix such as Free / Non-Free. */
  prefix?: string | null;
}

export interface PluginUpdateInfo {
  plugin_name: string;
  installed_version: string | null;
  available_version: string | null;
  forum_url: string;
}

export interface DownloadOption {
  label: string;
  url: string;
  size?: string | null;
  source?: string | null;
}

/** One row in the in-session action timeline (not the backend log file). */
export interface ActionLog {
  id: string;
  action: string;
  plugin?: string;
  details?: string;
  time: string;
  date: string;
}

export type Page = "home" | "options" | "discover" | "logs";
export type SortBy = "name" | "path" | "date";
export type StatusFilter = "all" | "active" | "disabled";
export type ViewMode = "list" | "grid";
export type ThemeMode = "dark" | "light" | "system";
export type ForumSort = "name" | "id" | "downloads" | "rating";
export type ForumCategory = "plugins" | "themes" | "tools" | "scripts";
export type DiscoverView = "grid" | "list";

export const FORUM_CATEGORIES: ForumCategory[] = ["plugins", "themes", "tools", "scripts"];

export const OBS_FORUM_PLUGINS_URL = "https://obsproject.com/forum/plugins/";
export const MAX_ACTION_LOG = 100;
export const PLUGINS_PER_PAGE = 30;
export const TOAST_DURATION_MS = 3000;
export const PATH_VALIDATE_DEBOUNCE_MS = 400;
export const IMPORT_HISTORY_KEY = "obs-plugin-manager-import-history";
export const MAX_IMPORT_HISTORY = 5;
export const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";
