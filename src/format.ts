import i18n from "./i18n";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * A Unix timestamp (seconds) as date and/or time in the app's language, not
 * the OS locale: a Vietnamese UI on an English Windows still reads 20/11/2026.
 */
export function formatTimestamp(seconds: number, part: "date" | "time" | "dateTime" = "dateTime"): string {
  const date = new Date(seconds * 1000);
  const locale = i18n.language || undefined;
  if (part === "date") return date.toLocaleDateString(locale);
  if (part === "time") return date.toLocaleTimeString(locale);
  return date.toLocaleString(locale);
}
