import { useEffect } from "react";
import type { Page } from "../types";

interface ShortcutHandlers {
  onRefresh: () => void;
  onClearAlerts: () => void;
  onFocusSearch: () => void;
  onOpenPluginsFolder: () => void;
  onImport: () => void;
  onSetPage: (page: Page) => void;
}

/**
 * Global shortcuts. Ignored modifiers other than Ctrl (and Ctrl+Shift+O for Options).
 * Page numbers: Ctrl+1 Home, Ctrl+2 Discover, Ctrl+3 Options, Ctrl+4 Logs.
 */
export function useKeyboardShortcuts({
  onRefresh,
  onClearAlerts,
  onFocusSearch,
  onOpenPluginsFolder,
  onImport,
  onSetPage,
}: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClearAlerts();
        return;
      }
      if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
        e.preventDefault();
        onRefresh();
        return;
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        onFocusSearch();
        return;
      }
      if (e.ctrlKey && e.key === "o" && !e.shiftKey) {
        e.preventDefault();
        onOpenPluginsFolder();
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "O") {
        e.preventDefault();
        onSetPage("options");
        return;
      }
      if (e.ctrlKey && e.key === "i") {
        e.preventDefault();
        onSetPage("home");
        onImport();
        return;
      }
      if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        onSetPage("discover");
        return;
      }
      if (e.ctrlKey && e.key === "1") {
        e.preventDefault();
        onSetPage("home");
      } else if (e.ctrlKey && e.key === "2") {
        e.preventDefault();
        onSetPage("discover");
      } else if (e.ctrlKey && e.key === "3") {
        e.preventDefault();
        onSetPage("options");
      } else if (e.ctrlKey && e.key === "4") {
        e.preventDefault();
        onSetPage("logs");
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onRefresh, onClearAlerts, onFocusSearch, onOpenPluginsFolder, onImport, onSetPage]);
}
