import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { TFunction } from "i18next";
import { openMenu } from "../../contextMenu";
import {
  CORNERS,
  DEFAULT_SIZE,
  afterResize,
  cornerPosition,
  freeAt,
  gripBox,
  keepInside,
  resizedFrom,
  snapCorner,
  type Box,
  type Corner,
  type Handle,
  type Placement,
  type Size,
} from "./geometry";

interface Args {
  rootRef: RefObject<HTMLDivElement | null>;
  box: Box;
  owner: Box;
  bounds: Box;
  placement: Placement;
  onPlacement: (placement: Placement, size: Size) => void;
  maximized: boolean;
  z: number;
  t: TFunction;
}

const G = 8;
const C = 16;

export const gripCursor: Record<Handle, string> = {
  n: "cursor-ns-resize",
  s: "cursor-ns-resize",
  e: "cursor-ew-resize",
  w: "cursor-ew-resize",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
  ne: "cursor-nesw-resize",
  sw: "cursor-nesw-resize",
};

/** Moving, resizing and snapping the panel (header drag, edge grips, position menu). */
export function usePanelGeometry({ rootRef, box, owner, bounds, placement, onPlacement, maximized, z, t }: Args) {
  /** Snap preview while dragging the header. */
  const [snapPreview, setSnapPreview] = useState<Corner | null>(null);
  const [moving, setMoving] = useState(false);

  /** Header drag: follows the pointer by transform, commits on release. */
  const startMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || maximized || (e.target as HTMLElement).closest("button, input")) return;
    const el = rootRef.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let engaged: Corner | null = placement.kind === "snap" ? placement.corner : null;
    let latest = box;
    let frame = 0;
    setMoving(true);
    const move = (ev: PointerEvent) => {
      const free = keepInside({ ...box, x: box.x + ev.clientX - sx, y: box.y + ev.clientY - sy }, bounds);
      latest = free;
      const corner = snapCorner(free, owner, engaged);
      if (corner !== engaged) {
        engaged = corner;
        setSnapPreview(corner);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.transform = `translate(${free.x - box.x}px, ${free.y - box.y}px)`;
      });
    };
    const end = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      el.style.transform = "";
      setMoving(false);
      setSnapPreview(null);
      if (ev.type === "pointercancel") return;
      onPlacement(engaged ? { kind: "snap", corner: engaged } : freeAt(latest, bounds), { w: box.w, h: box.h });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const startResize = (handleSide: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = rootRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let latest = box;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      latest = resizedFrom(box, handleSide, ev.clientX - sx, ev.clientY - sy, bounds);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.left = `${latest.x}px`;
        el.style.top = `${latest.y}px`;
        el.style.width = `${latest.w}px`;
        el.style.height = `${latest.h}px`;
      });
    };
    const end = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      // A snapped panel keeps its corner unless the grip moved that corner.
      onPlacement(afterResize(placement, handleSide, latest, bounds), { w: latest.w, h: latest.h });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const positionMenu = (e: ReactMouseEvent) => {
    const label: Record<Corner, string> = {
      tl: t("files.pos.tl"),
      tr: t("files.pos.tr"),
      bl: t("files.pos.bl"),
      br: t("files.pos.br"),
    };
    openMenu(e, [
      ...CORNERS.map((corner) => ({
        label: label[corner],
        checked: placement.kind === "snap" && placement.corner === corner,
        action: () => onPlacement({ kind: "snap", corner }, { w: box.w, h: box.h }),
      })),
      "separator",
      { label: t("files.pos.resetSize"), action: () => onPlacement(placement, DEFAULT_SIZE) },
    ]);
  };

  const snapGhost = snapPreview ? { ...cornerPosition(snapPreview, box, owner), w: box.w, h: box.h } : null;
  // Grips on every edge and corner, outside the panel (so nothing inside it,
  // scrollbars included, can cover them) and straddling its border.
  const gripStyle = (h: Handle): React.CSSProperties => {
    return { position: "fixed", zIndex: z + 1, ...gripBox(h, box, G, C) };
  };

  return { moving, snapGhost, startMove, startResize, positionMenu, gripStyle };
}
