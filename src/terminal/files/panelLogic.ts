// Pure decisions of the file panel (FilePanel), kept apart so they can be tested.

import type { Conflict, FileCount } from "../../types";
import { joinPath, type SortKey } from "./paths";

/** Error codes the backend sends that have a translation (`files.err.*`). */
export const KNOWN_ERRORS = new Set(["not-connected", "no-such-file", "permission-denied", "exists", "conflict", "timeout", "too-large", "same-tunnel", "invalid-path", "not-copied-link", "too-many-files", "target-changed", "connection-lost", "not-retryable", "no-such-transfer", "duplicate-names", "copy-failed", "unsupported", "unsafe-save", "partial", "cancelled", "too-many", "too-many-bookmarks"]);

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

/** The user's answer for one name clash: a mode, and whether it is for all the rest. */
/** What to do with each taken name; names left out are skipped. */
export type ClashChoices = Map<string, Conflict>;

/**
 * Groups `names` by what happens to each on arrival: free names go as they
 * are ("skip" never applies to them), taken ones follow the user's choices,
 * asked once for all of them. Null when the user cancelled.
 */
export async function chooseConflicts(
  names: string[],
  taken: Set<string>,
  ask: (taken: string[]) => Promise<ClashChoices | null>,
): Promise<Map<Conflict, string[]> | null> {
  const groups = new Map<Conflict, string[]>();
  const put = (mode: Conflict, name: string) => groups.set(mode, [...(groups.get(mode) ?? []), name]);
  const clashing = names.filter((n) => taken.has(n));
  const choices = clashing.length > 0 ? await ask(clashing) : new Map<string, Conflict>();
  if (!choices) return null;
  for (const name of names) put(taken.has(name) ? (choices.get(name) ?? "skip") : "skip", name);
  return groups;
}

/** Names that occur more than once (items from different folders, one target folder). */
export const duplicateNames = (names: string[]) => [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
