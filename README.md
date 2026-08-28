# LamaWorlds OBS Plugin Manager

Tauri 2 + React 19 desktop app for managing OBS Studio plugins.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [OBS Studio](https://obsproject.com/) (optional, for plugin detection)

## Installation

```bash
npm install
```

## Running

### Development

```bash
npm run tauri dev
```

Starts Vite on port 1420, builds the Rust backend, and opens the app with hot-reload.

### Production build

```bash
npm run tauri build
```

Installer output: `src-tauri/target/release/bundle/`.

### Frontend only (no Tauri)

```bash
npm run dev
```

Open http://localhost:1420 — Rust commands will not work in the browser.

## Features

- **Home** — Installed plugins with search, filters, list/grid views, install from URL/file/drag-drop, export JSON/CSV, update detection
- **Discover** — OBS forum catalog (plugins/themes/tools/scripts), favorites, tags, install via download modal
- **Logs** — Session action timeline + backend `plugin-manager.log`
- **Options** — Custom OBS paths, theme (dark/light/system), language (EN/FR), auto-backup, read-only mode, profiles, config import/export
- **OBS module integration** — reads OBS 32's own plugin manager state
  (`<obs-config>/plugin_manager/modules.json`) to show the enabled state OBS
  actually sees, flag DLLs that are not plugins (OBS built-ins and helper
  libraries) so they cannot be removed by mistake, and toggle a module the same
  way OBS does instead of renaming its folder
- OBS running detection and path validation
- Collapsible sidebar, keyboard shortcuts

### Shortcuts

| Shortcut | Action |
|----------|--------|
| F5 / Ctrl+R | Refresh |
| Ctrl+F | Focus search |
| Ctrl+O | Open plugins folder |
| Ctrl+I | Import plugin file |
| Ctrl+1–4 | Home / Discover / Options / Logs |
| Ctrl+D | Discover |
| Ctrl+Shift+O | Options |
| Esc | Clear toast / error |

## Project structure

```
src/
  App.tsx              # Shell, state, commands
  pages/               # Home, Discover, Options, Logs
  components/          # Shared UI (Toast)
  types/               # Shared TypeScript types
  i18n.ts              # EN / FR strings
  App.css              # Theme + layout
src-tauri/
  src/lib.rs           # Tauri commands (filesystem, forum, install, OBS modules)
```

## Icons

Regenerate from logo: `npx tauri icon public/logo_64x64.png`

## Tests

```bash
cd src-tauri && cargo test
```

Covers OBS module parsing, the built-in/support-DLL classification, and the
modules.json rewrite (which must preserve fields this app does not model).
