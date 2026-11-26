// Shared constants, small types and module-level stores of the file panel.

import type { FileCount } from "../../types";
import type { ClashChoices } from "./panelLogic";

export const ROW = 28;
/** Deletes this big ask for the folder's name to be typed. */
export const TYPE_TO_CONFIRM = 100;
export const DETAILS_MIN = 880;
export const COLUMNS_MIN = 600;

export type NameBar = { kind: "file" | "dir" } | { kind: "rename"; from: string };
export type NameBarState = NameBar & { value: string };
export type Confirm =
  | { kind: "delete"; paths: string[]; count: FileCount | null; typed: string }
  | { kind: "dirty"; resolve: (choice: "save" | "discard" | "cancel") => void }
  /** `names` are taken in `dir`; `total` items are arriving. */
  | { kind: "clash"; names: string[]; dir: string; total: number; resolve: (choices: ClashChoices | null) => void }

/** After a relayed server-to-server copy: the way to make it direct next time. */
export interface RelayHint {
  fromTunnelId: string;
  /** The shell the rows came from, resolved when the hint was made. */
  termId: string | null;
  command: string;
}

/** Copied/cut paths; outlives the panel so reopening can still paste. */
/** `endpoint`: the server (`user@host:port`) the rows were copied on. */
export type Clip = { tunnelId: string; endpoint: string; paneId: string; paths: string[]; cut: boolean };
let clipboardValue: Clip | null = null;
const clipListeners = new Set<() => void>();
export const subscribeClipboard = (l: () => void) => {
  clipListeners.add(l);
  return () => void clipListeners.delete(l);
};
export const getClipboard = () => clipboardValue;
export const setClipboard = (next: Clip | null) => {
  clipboardValue = next;
  clipListeners.forEach((l) => l());
};

export const HIDDEN_KEY = "protunel.files.showHidden";
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Only a preference.
  }
}

/**
 * "These folders changed on this server": every other panel on the same
 * tunnel showing one of them re-lists it (quietly), so a delete, rename or
 * paste in one panel never leaves another acting on entries that are gone.
 */
export type Invalidation = { tunnelId: string; dirs: string[]; fromPaneId: string };
const invalidationListeners = new Set<(change: Invalidation) => void>();
export const onInvalidate = (l: (change: Invalidation) => void) => {
  invalidationListeners.add(l);
  return () => void invalidationListeners.delete(l);
};
export const invalidateDirs = (change: Invalidation) => invalidationListeners.forEach((l) => l(change));
