/** Formats a Unix timestamp (seconds) as a locale date string. */
export function formatDate(ts: number | null | undefined, locale?: string): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Compact download / count display: 1.2M, 12k, or a locale integer. */
export function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

/** Last path segment, works with both Windows and POSIX separators. */
export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Heuristic: a forum title matches an installed plugin name.
 * Exact match always wins; short names (e.g. "Move") only match as a word to
 * avoid false positives inside unrelated titles.
 */
export function pluginNamesMatch(forumTitle: string, installedName: string): boolean {
  const title = forumTitle.toLowerCase();
  const name = installedName.toLowerCase();
  if (title === name) return true;
  if (name.length < 4) {
    return title === name || title.startsWith(`${name} `) || title.includes(` ${name} `);
  }
  return title.includes(name) || name.includes(title);
}
