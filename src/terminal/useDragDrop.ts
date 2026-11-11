import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { sideAt } from "./layout";
import type { DragSource, DropTarget } from "./tabs";

export interface DragState {
  source: DragSource;
  label: string;
  x: number;
  y: number;
  target: DropTarget | null;
}

/** Movement before a press becomes a drag, so clicks and double-clicks still work. */
const THRESHOLD_PX = 5;
/** Hovering a tab this long while dragging switches to it, to drop inside it. */
const TAB_HOVER_MS = 450;

/**
 * Pointer-driven drag and drop. Drop targets are found from the DOM under the
 * cursor through data attributes, so any element can be one:
 * `data-drop-pane` (+ `data-tab-key`), `data-drop-tab`, `data-drop-tabbar`.
 */
export function useDragDrop(options: {
  accepts: (source: DragSource, target: DropTarget) => boolean;
  onDrop: (source: DragSource, target: DropTarget) => void;
  onHoverTab: (tabKey: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const cleanupRef = useRef<() => void>(() => {});

  useEffect(() => () => cleanupRef.current(), []);

  const findTarget = (x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const pane = el.closest<HTMLElement>("[data-drop-pane]");
    if (pane?.dataset.dropPane && pane.dataset.tabKey) {
      const r = pane.getBoundingClientRect();
      return {
        kind: "pane",
        tabKey: pane.dataset.tabKey,
        paneId: pane.dataset.dropPane,
        side: sideAt((x - r.left) / r.width, (y - r.top) / r.height),
      };
    }
    const tab = el.closest<HTMLElement>("[data-drop-tab]");
    if (tab?.dataset.dropTab) {
      const r = tab.getBoundingClientRect();
      return { kind: "tab", tabKey: tab.dataset.dropTab, after: x > r.left + r.width / 2 };
    }
    if (el.closest("[data-drop-tabbar]")) return { kind: "tabbar" };
    return null;
  };

  const beginDrag = (source: DragSource, label: string) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // Buttons inside a draggable (close, zoom…) keep working as buttons.
    const control = (e.target as HTMLElement).closest("button, [role='button']");
    if (control && control !== e.currentTarget) return;
    cleanupRef.current();
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let target: DropTarget | null = null;
    let hoverTab: string | null = null;
    let hoverTimer = 0;

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      window.clearTimeout(hoverTimer);
      document.body.classList.remove("dragging");
      setDrag(null);
      cleanupRef.current = () => {};
    };

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return;
        active = true;
        document.body.classList.add("dragging");
      }
      const found = findTarget(ev.clientX, ev.clientY);
      target = found && optionsRef.current.accepts(source, found) ? found : null;

      // Panes and hosts can be dragged into another tab by hovering its label.
      const overTab = found?.kind === "tab" && source.kind !== "tab" ? found.tabKey : null;
      if (overTab !== hoverTab) {
        window.clearTimeout(hoverTimer);
        hoverTab = overTab;
        if (overTab) hoverTimer = window.setTimeout(() => optionsRef.current.onHoverTab(overTab), TAB_HOVER_MS);
      }
      setDrag({ source, label, x: ev.clientX, y: ev.clientY, target });
    };

    const up = () => {
      const dropped = active ? target : null;
      finish();
      if (dropped) optionsRef.current.onDrop(source, dropped);
    };

    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    cleanupRef.current = finish;
  };

  return { drag, beginDrag };
}
