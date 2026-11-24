// Pure decisions of the file panel (FilePanel), kept apart so they can be tested.

import type { FileCount } from "../../types";
import { joinPath, type SortKey } from "./paths";

/** Error codes the backend sends that have a translation (`files.err.*`). */
export const KNOWN_ERRORS = new Set(["not-connected", "no-such-file", "permission-denied", "exists", "conflict", "timeout", "too-large", "same-tunnel", "invalid-path"]);

/** The code of an error when it is a known one, else null (show its text as is). */
export function knownErrorCode(e: unknown): string | null {
  const code = String(e);
  return KNOWN_ERRORS.has(code) ? code : null;
}

/** Whether response `seq` is still the newest request issued (stale ones are ignored). */
export function isCurrentRequest(seq: number, latest: number): boolean {
  return seq === latest;
}

/** Cut stays on one server; a copy can be pasted on any other. */
export function canPasteClip(clip: { tunnelId: string; cut: boolean } | null, tunnelId: string): boolean {
  return clip !== null && (clip.tunnelId === tunnelId || !clip.cut);
}

/** Full paths of `names` in `dir`; none while there is no folder yet. */
export function pathsIn(dir: string | null, names: Iterable<string>): string[] {
  return dir ? [...names].map((n) => joinPath(dir, n)) : [];
}

/** Clicking a column header: another column sorts ascending, the same one flips direction. */
export function nextSort(sort: { key: SortKey; desc: boolean }, key: SortKey): { key: SortKey; desc: boolean } {
  return { key, desc: sort.key === key ? !sort.desc : false };
}

/** Cursor after moving by `delta` rows, kept inside the list. */
export function stepCursor(cursor: number, delta: number, length: number): number {
  return Math.min(length - 1, Math.max(0, cursor + delta));
}

/** Rows a PageUp/PageDown moves: a screenful less one, at least one. */
export function pageRows(listHeight: number, rowHeight: number): number {
  return Math.max(1, Math.floor(listHeight / rowHeight) - 1);
}

/** Type to jump: index of the next name (after `cursor`, wrapping) starting with `key`, or -1. */
export function jumpIndex(names: readonly string[], cursor: number, key: string): number {
  const k = key.toLowerCase();
  const from = cursor + 1;
  const order = [...names.slice(from), ...names.slice(0, from)];
  const hit = order.find((x) => x.toLowerCase().startsWith(k));
  return hit === undefined ? -1 : names.indexOf(hit);
}

/** Whether a delete must have its folder name typed (big or unbounded counts). */
export function deleteNeedsTyping(count: FileCount | null, threshold: number): boolean {
  if (count === null) return false;
  return count.files + count.dirs >= threshold || count.more;
}

/** Whether the delete may go ahead. */
export function deleteConfirmed(count: FileCount | null, typed: string, word: string, threshold: number): boolean {
  return count !== null && (!deleteNeedsTyping(count, threshold) || typed.trim() === word);
}
