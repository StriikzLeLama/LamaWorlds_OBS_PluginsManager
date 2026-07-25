/** Formats a Unix timestamp (seconds) as locale date string. */
export function formatDate(ts: number | null | undefined, locale?: string): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return n.toLocaleString();
}
