# LamaWorlds OBS Plugin Manager

Tauri + React application for managing OBS Studio plugins.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [OBS Studio](https://obsproject.com/) (optional, for plugin detection)

## Installation

```bash
npm install
```

## Running the application

### Development mode (recommended)

```bash
npm run tauri dev
```

This command:
1. Starts Vite (React frontend) on port 1420
2. Builds the Rust backend
3. Opens the application window with hot-reload

### Production build

To build the executable:

```bash
npm run tauri build
```

The installer will be generated in `src-tauri/target/release/bundle/`.

### Alternative: Frontend only (without Tauri)

To test the React frontend only (without Rust commands):

```bash
npm run dev
```

Then open http://localhost:1420 — Tauri commands will not work in the browser.

## Features

- **Home**: List installed plugins, filters (All/Active/Disabled), search, sort, action history
- **Discover**: OBS forum plugins with 2-column layout, featured plugins, pagination, favorites, install from URL
- **Options**: Custom paths with validation
- OBS folder detection (ProgramData, AppData, installation path)
- Disable / enable plugins without uninstalling
- Auto backup (.zip) before uninstall
- Alert when OBS is running
- Path validation on startup
- Shortcuts: F5 (refresh), Ctrl+O (open folder)

## Project structure

- `src/` — React + TypeScript frontend
- `src-tauri/` — Rust backend (Tauri)
- `src-tauri/src/lib.rs` — Tauri commands (get_obs_paths, list_obs_plugins, etc.)
- `src-tauri/icons/` — App icons (window, taskbar)

## Icons

To regenerate icons from your logo: `npx tauri icon public/logo_64x64.png`
