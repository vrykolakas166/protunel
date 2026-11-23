// Pointer drag of file rows between panels. Several panels live in one
// window, so the drag state is module-level: the source panel starts it and
// draws the ghost, any panel can be a drop target (registered as a receiver),
// and the receiver does the work. Never HTML5 drag-and-drop. See CLAUDE.md
// "File panel".

import type { PointerEvent as ReactPointerEvent } from "react";
import { planDrop, type DropPlan, type DropSource } from "./dropLogic";

export interface RowDragPayload extends DropSource {
  /** The panel (pane id) the rows come from. */
  paneId: string;
}

export interface RowDragView {
  payload: RowDragPayload;
  x: number;
  y: number;
  ctrl: boolean;
  /** Where a drop would land now; null over nothing, or a refused drop. */
  hover: { paneId: string; dir: string; plan: DropPlan } | null;
}

/** A panel that accepts row drops. Registered once; reads the latest state. */
export interface RowDropReceiver {
  tunnelId: string;
  /** The folder a drop at window point (x, y) would go to; null when none. */
  resolve: (x: number, y: number) => string | null;
  drop: (payload: RowDragPayload, dir: string, plan: DropPlan) => void;
  refresh: () => void;
}

const receivers = new Map<string, RowDropReceiver>();
export function registerRowReceiver(paneId: string, r: RowDropReceiver): () => void {
  receivers.set(paneId, r);
  return () => {
    if (receivers.get(paneId) === r) receivers.delete(paneId);
  };
}
export const rowReceiver = (paneId: string) => receivers.get(paneId);

// ---- store (useSyncExternalStore) -------------------------------------------

let view: RowDragView | null = null;
const listeners = new Set<() => void>();
const setView = (next: RowDragView | null) => {
  view = next;
  listeners.forEach((l) => l());
};
export const subscribeRowDrag = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const getRowDrag = () => view;

// ---- the hook point for an OS drag-out ----------------------------------------

export interface LeaveInfo {
  payload: RowDragPayload;
  x: number;
  y: number;
}
type LeaveHandler = (info: LeaveInfo) => boolean | void;
const leaveHandlers = new Set<LeaveHandler>();
/**
 * Called once when the pointer leaves the window during a row drag, with the
 * dragged rows. `FilePanel` registers the OS drag-out here on Windows (return
 * true when it takes over); the in-app drag ends either way, so nothing is
 * left behind. Elsewhere nothing registers it.
 */
export function onRowDragLeaveWindow(handler: LeaveHandler): () => void {
  leaveHandlers.add(handler);
  return () => void leaveHandlers.delete(handler);
}

// ---- the gesture ---------------------------------------------------------------

/** Movement before a press becomes a drag, so clicks and double-clicks still work. */
export const DRAG_THRESHOLD_PX = 4;

let cleanup: (() => void) | null = null;
let activeSource: string | null = null;
export const cancelRowDrag = () => cleanup?.();
/** Ends the gesture only if it started in this panel (its unmount cleanup). */
export const cancelRowDragFrom = (paneId: string) => {
  if (activeSource === paneId) cleanup?.();
};

function hit(payload: RowDragPayload, x: number, y: number, ctrl: boolean): RowDragView["hover"] {
  // Only the list surface takes drops; headers, toolbars, footers and the
  // dialogs/overlays drawn over the panel are not in it.
  const surface = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-drop]");
  if (!surface) return null;
  const paneId = surface.closest<HTMLElement>("[data-file-panel]")?.dataset.filePanel;
  const receiver = paneId ? receivers.get(paneId) : undefined;
  if (!paneId || !receiver) return null;
  const dir = receiver.resolve(x, y);
  if (dir === null) return null;
  const plan = planDrop(payload, { tunnelId: receiver.tunnelId, dir }, ctrl);
  return plan.kind === "none" ? null : { paneId, dir, plan };
}

/**
 * Starts tracking a press on a row. A move past the threshold turns it into a
 * drag; releasing without one calls `onPlainClick` (so a multi-selection is
 * only collapsed by a click, never by the start of a drag).
 */
export function beginRowDrag(e: ReactPointerEvent, payload: RowDragPayload, onPlainClick: () => void): void {
  if (e.button !== 0) return;
  cleanup?.();
  const sx = e.clientX;
  const sy = e.clientY;
  const pointerId = e.pointerId;
  const captureEl = (e.currentTarget.closest("[role='listbox']") ?? e.currentTarget) as HTMLElement;
  let active = false;
  let ctrl = e.ctrlKey || e.metaKey;

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    captureEl.removeEventListener("lostpointercapture", lost);
    activeSource = null;
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("keyup", key, true);
    window.removeEventListener("blur", finish);
    document.documentElement.removeEventListener("mouseleave", leave);
    try {
      captureEl.releasePointerCapture(pointerId);
    } catch {
      // Not captured, or already released.
    }
    document.body.classList.remove("dragging");
    cleanup = null;
    if (view) setView(null);
  };

  const leave = () => {
    if (!active) return;
    const at = view ?? { x: sx, y: sy };
    const info = { payload, x: at.x, y: at.y };
    finish();
    leaveHandlers.forEach((h) => h(info));
  };

  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish();
  };
  // The capture was taken away (element removed, OS cancel): the drag is over.
  const lost = (ev: PointerEvent) => {
    if (active && ev.pointerId === pointerId) finish();
  };

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
      active = true;
      document.body.classList.add("dragging");
      try {
        captureEl.setPointerCapture(pointerId);
      } catch {
        // The window listeners still follow the pointer.
      }
    }
    ctrl = ev.ctrlKey || ev.metaKey;
    // A captured pointer keeps reporting outside the window.
    if (ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight) {
      return leave();
    }
    setView({ payload, x: ev.clientX, y: ev.clientY, ctrl, hover: hit(payload, ev.clientX, ev.clientY, ctrl) });
  };

  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const wasActive = active;
    const hover = wasActive ? hit(payload, ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey) : null;
    finish();
    if (!wasActive) return onPlainClick();
    if (hover) rowReceiver(hover.paneId)?.drop(payload, hover.dir, hover.plan);
  };

  const key = (ev: KeyboardEvent) => {
    if (ev.type === "keydown" && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      return finish();
    }
    if (ev.key === "Control" || ev.key === "Meta") {
      ctrl = ev.type === "keydown";
      if (active && view) {
        setView({ ...view, ctrl, hover: hit(payload, view.x, view.y, ctrl) });
      }
    }
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  captureEl.addEventListener("lostpointercapture", lost);
  activeSource = payload.paneId;
  window.addEventListener("keydown", key, true);
  window.addEventListener("keyup", key, true);
  window.addEventListener("blur", finish);
  document.documentElement.addEventListener("mouseleave", leave);
  cleanup = finish;
}
