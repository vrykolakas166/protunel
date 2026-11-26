// Folder history of the file panel: Back/Forward per panel, and the folders
// recently opened per host (kept across terminal windows). Pure, except the
// localStorage pair at the end.

/** A panel's Back/Forward trail. */
export interface History {
  stack: string[];
  index: number;
}

export const EMPTY_HISTORY: History = { stack: [], index: -1 };
const MAX_HISTORY = 50;

/** A folder reached by navigating (not by Back/Forward): drops the forward part. */
export function visit(h: History, path: string): History {
  if (h.stack[h.index] === path) return h;
  const stack = [...h.stack.slice(0, h.index + 1), path].slice(-MAX_HISTORY);
  return { stack, index: stack.length - 1 };
}

/** Where Back (-1) or Forward (+1) goes, or null at the end. */
export function step(h: History, delta: -1 | 1): { path: string; index: number } | null {
  const index = h.index + delta;
  return index >= 0 && index < h.stack.length ? { path: h.stack[index], index } : null;
}

/** After Back/Forward landed: only the position moves. */
export function moveTo(h: History, index: number, path: string): History {
  // The folder may resolve differently now (a symlink); keep what was shown.
  if (h.stack[index] === path) return { ...h, index };
  const stack = [...h.stack];
  stack[index] = path;
  return { stack, index };
}

export const MAX_RECENT = 10;

/** `path` first, no duplicates, at most `MAX_RECENT`. */
export function addRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT);
}

/** Bookmarks toggle: add `path` at the end, or remove it. */
export function toggleBookmark(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

// Recent folders per host. A convenience only (localStorage, failing quietly);
// never in config export.
const RECENT_KEY = "protunel.files.recent";

function readAll(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function recentFolders(tunnelId: string): string[] {
  const list = readAll()[tunnelId];
  return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
}

export function rememberFolder(tunnelId: string, path: string) {
  try {
    const all = readAll();
    all[tunnelId] = addRecent(recentFolders(tunnelId), path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Only a convenience.
  }
}
