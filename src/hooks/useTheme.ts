import { useEffect, useState } from "react";
import type { ThemeMode } from "../types";
import { readStorage, writeStorage } from "../utils/storage";

const THEME_KEY = "theme";

function readStoredTheme(): ThemeMode {
  const value = readStorage(THEME_KEY);
  return value === "light" || value === "system" ? value : "dark";
}

function resolveTheme(theme: ThemeMode): "dark" | "light" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Persists the UI theme and mirrors it onto <html data-theme>.
 * "system" follows prefers-color-scheme and updates live.
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      document.documentElement.setAttribute("data-theme", media.matches ? "dark" : "light");
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);

  return { theme, setTheme };
}
