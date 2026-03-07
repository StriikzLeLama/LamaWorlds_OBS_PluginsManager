/**
 * Safe Tauri API wrapper.
 * Fixes "Cannot read properties of undefined (reading 'invoke')" when
 * running in browser instead of Tauri.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  }
}

async function invokeRaw<T>(cmd: string, args?: unknown): Promise<T> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error(
      "Tauri API not available. Run the app with: npm run tauri dev"
    );
  }
  return internals.invoke(cmd, args) as Promise<T>;
}

export async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  try {
    return await invokeRaw<T>(cmd, args);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("undefined") || msg.includes("invoke")) {
      throw new Error(
        "Tauri API not available. Run the app with: npm run tauri dev"
      );
    }
    throw e;
  }
}

export function isInTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

/**
 * Opens a folder selection dialog.
 * Returns the selected path or null if cancelled.
 */
export async function openFolderDialog(title?: string): Promise<string | null> {
  if (!isInTauri()) {
    throw new Error(
      "Tauri API not available. Run the app with: npm run tauri dev"
    );
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: title ?? "Select a folder",
  });
  return selected as string | null;
}
