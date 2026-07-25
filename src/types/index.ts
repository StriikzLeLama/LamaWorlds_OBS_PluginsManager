/**
 * Shared types for LamaWorlds OBS Plugin Manager
 */
export interface ObsPluginInfo {
  name: string;
  path: string;
  uninstall_path: string;
  enabled: boolean;
  version: string | null;
  modified_time?: number | null;
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

export const OBS_FORUM_PLUGINS_URL = "https://obsproject.com/forum/plugins/";
export const MAX_ACTION_LOG = 100;
export const PLUGINS_PER_PAGE = 30;
