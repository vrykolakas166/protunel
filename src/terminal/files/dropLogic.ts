// Pure rules for dragging file rows between folders and servers
// (`tests/rowDrop.test.ts`). No DOM, no IPC.

import type { FileEntry } from "../../types";
import { isDirLike, joinPath, parentPath } from "./paths";

export interface DropSource {
  tunnelId: string;
  /** The folder the rows were dragged out of. */
  dir: string;
  /** Absolute paths of the dragged rows. */
  paths: string[];
}

export interface DropDest {
  tunnelId: string;
  dir: string;
}

/**
 * What a drop does. `move`/`copy` stay on one server (`files_paste`);
 * `across` is a server-to-server copy (`files_copy_across`), never a move.
 */
export type DropPlan =
  | { kind: "move" | "copy" | "across" }
  | { kind: "none"; reason: "empty" | "into-self" | "same-folder" };

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `dir` is `path` itself or somewhere below it. */
export function isSameOrInside(path: string, dir: string): boolean {
  const a = trim(path);
  const b = trim(dir);
  if (a === b || a === "/") return true;
  return b.startsWith(`${a}/`);
}

export function planDrop(source: DropSource, dest: DropDest, ctrl: boolean): DropPlan {
  if (source.paths.length === 0) return { kind: "none", reason: "empty" };
  if (source.tunnelId !== dest.tunnelId) return { kind: "across" };
  // A folder cannot go into itself or its own descendant, move or copy.
  if (source.paths.some((p) => isSameOrInside(p, dest.dir))) return { kind: "none", reason: "into-self" };
  if (ctrl) return { kind: "copy" };
  // Moving into the folder everything already sits in changes nothing.
  if (source.paths.every((p) => trim(parentPath(p)) === trim(dest.dir))) {
    return { kind: "none", reason: "same-folder" };
  }
  return { kind: "move" };
}

/** The folder a drop at a list point goes to: a folder row, else the open folder. */
export function dropDirFor(openDir: string, row: FileEntry | undefined): string {
  return row && isDirLike(row) ? joinPath(openDir, row.name) : openDir;
}

export const dropLabelKey = (plan: DropPlan): string | null =>
  plan.kind === "move"
    ? "files.dropMove"
    : plan.kind === "copy" || plan.kind === "across"
      ? "files.dropCopy"
      : null;

export interface SpeedSample {
  done: number;
  at: number;
  /** Bytes per second, smoothed; null until two readings exist. */
  speed: number | null;
}

/** Smoothing of the displayed speed: 1 would be the raw last interval. */
const SPEED_ALPHA = 0.3;
const MIN_INTERVAL_MS = 500;

/** Folds a new `done` reading into a smoothed speed, from deltas only. */
export function nextSpeed(prev: SpeedSample | undefined, done: number, now: number): SpeedSample {
  if (!prev || done < prev.done) return { done, at: now, speed: null };
  const dt = now - prev.at;
  if (dt < MIN_INTERVAL_MS) return prev;
  const raw = ((done - prev.done) * 1000) / dt;
  const speed = prev.speed === null ? raw : prev.speed + SPEED_ALPHA * (raw - prev.speed);
  return { done, at: now, speed };
}
