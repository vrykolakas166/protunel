import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

// Grows the window when an open popup needs more room than it has, and puts
// it back when the last popup closes. One controller per window: nested popups
// (Config opened from Settings) share a single "before" size.

interface Saved {
  width: number;
  height: number;
  x: number;
  y: number;
}

let openPopups = 0;
/** Window geometry before the first grow, in logical px. */
let before: Saved | null = null;
/** Inner size we last set, to tell our resize apart from the user's. */
let applied: { width: number; height: number } | null = null;
/** Where we moved the window to keep it on screen, if we did. */
let movedTo: { x: number; y: number } | null = null;
// Window calls are async; chaining them keeps a close from racing a grow.
let queue: Promise<void> = Promise.resolve();

const run = (task: () => Promise<void>) => {
  queue = queue.then(task).catch(() => {});
};

/** Matches the popup's own entrance animation (Modal, `modal-in`). */
const ANIMATION_MS = 180;

interface Frame {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Animated in Rust (`window_anim.rs`): stepping from here costs two IPC calls
 * per frame and shows the in-between states of size and position separately.
 * Sizes are inner, positions outer top-left, all logical px.
 */
const animateWindow = (to: Frame) =>
  invoke<void>("animate_window", { ...to, durationMs: ANIMATION_MS });

export function popupOpened() {
  openPopups += 1;
}

/** Makes the window's inner size at least `width`×`height` logical px, within the screen. */
export function fitWindow(width: number, height: number) {
  run(async () => {
    if (openPopups === 0) return;
    const win = getCurrentWindow();
    if ((await win.isMaximized()) || (await win.isFullscreen())) return;
    const scale = await win.scaleFactor();
    const inner = (await win.innerSize()).toLogical(scale);
    const outer = (await win.outerSize()).toLogical(scale);
    const pos = (await win.outerPosition()).toLogical(scale);
    const monitor = await currentMonitor();
    if (!monitor) return;
    const area = {
      ...monitor.workArea.position.toLogical(monitor.scaleFactor),
      ...monitor.workArea.size.toLogical(monitor.scaleFactor),
    };
    // Title bar and borders: the part of the window that is not content.
    const chromeW = outer.width - inner.width;
    const chromeH = outer.height - inner.height;
    const targetW = Math.min(Math.max(inner.width, Math.ceil(width)), area.width - chromeW);
    const targetH = Math.min(Math.max(inner.height, Math.ceil(height)), area.height - chromeH);
    if (targetW <= inner.width + 1 && targetH <= inner.height + 1) return;

    before ??= { width: inner.width, height: inner.height, x: pos.x, y: pos.y };
    // Keep the grown window on screen.
    const x = Math.min(Math.max(pos.x, area.x), area.x + area.width - (targetW + chromeW));
    const y = Math.min(Math.max(pos.y, area.y), area.y + area.height - (targetH + chromeH));
    await animateWindow({ width: targetW, height: targetH, x, y });
    applied = { width: targetW, height: targetH };
    if (x !== pos.x || y !== pos.y) movedTo = { x, y };
  });
}

export function popupClosed() {
  openPopups = Math.max(0, openPopups - 1);
  run(async () => {
    if (openPopups > 0 || !before) return;
    const saved = before;
    const grownTo = applied;
    const moved = movedTo;
    before = null;
    applied = null;
    movedTo = null;
    const win = getCurrentWindow();
    if (!grownTo || (await win.isMaximized())) return;
    const scale = await win.scaleFactor();
    const inner = (await win.innerSize()).toLogical(scale);
    // Resized by hand while the popup was open: their size wins.
    if (Math.abs(inner.width - grownTo.width) > 1 || Math.abs(inner.height - grownTo.height) > 1) return;
    const pos = (await win.outerPosition()).toLogical(scale);
    // Only undo our own nudge; a window the user dragged elsewhere stays put.
    const restorePos =
      moved && Math.abs(pos.x - moved.x) <= 1 && Math.abs(pos.y - moved.y) <= 1;
    await animateWindow({
      width: saved.width,
      height: saved.height,
      x: restorePos ? saved.x : pos.x,
      y: restorePos ? saved.y : pos.y,
    });
  });
}
