// Where the file panel sits: snapped to a corner of the pane it belongs to,
// or free anywhere in the window. Pure, so the drag feel is testable
// (`tests/filePanel.test.ts`). All rects are window pixels.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

/**
 * Snapped: follows a corner of the owner pane through splits, tiles, zoom and
 * window resizes. Free: a spot in the window, stored as a fraction of the
 * room the panel can travel so it stays put proportionally on resize.
 */
export type Placement = { kind: "snap"; corner: Corner } | { kind: "free"; fx: number; fy: number };

export const DEFAULT_SIZE: Size = { w: 460, h: 320 };
export const MIN_SIZE: Size = { w: 360, h: 280 };
/** Gap to the window edge the panel never crosses. */
export const EDGE = 8;
/** Gap between a snapped panel and its pane's corner. */
export const INSET = 8;
/** A dragged corner snaps within this distance... */
export const ENGAGE = 16;
/** ...and lets go only beyond this one, so it doesn't flicker at the edge. */
export const RELEASE = 24;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** The preferred size, fitted to the window (the preference itself is kept). */
export function fitSize(size: Size, bounds: Box): Size {
  const maxW = bounds.w - 2 * EDGE;
  const maxH = bounds.h - 2 * EDGE;
  return {
    w: Math.round(clamp(size.w, Math.min(MIN_SIZE.w, maxW), maxW)),
    h: Math.round(clamp(size.h, Math.min(MIN_SIZE.h, maxH), maxH)),
  };
}

/** Keeps a box inside the window, minus the edge gap. */
export function keepInside(box: Box, bounds: Box): Box {
  return {
    ...box,
    x: Math.round(clamp(box.x, bounds.x + EDGE, bounds.x + bounds.w - EDGE - box.w)),
    y: Math.round(clamp(box.y, bounds.y + EDGE, bounds.y + bounds.h - EDGE - box.h)),
  };
}

/** Top-left of a panel of `size` snapped to `corner` of `owner`. */
export function cornerPosition(corner: Corner, size: Size, owner: Box): { x: number; y: number } {
  const left = corner === "tl" || corner === "bl";
  const top = corner === "tl" || corner === "tr";
  return {
    x: left ? owner.x + INSET : owner.x + owner.w - INSET - size.w,
    y: top ? owner.y + INSET : owner.y + owner.h - INSET - size.h,
  };
}

/** The panel's box for a placement, inside the window. */
export function place(placement: Placement, size: Size, owner: Box, bounds: Box): Box {
  const fitted = fitSize(size, bounds);
  if (placement.kind === "snap") {
    return keepInside({ ...cornerPosition(placement.corner, fitted, owner), ...fitted }, bounds);
  }
  const roomX = bounds.w - 2 * EDGE - fitted.w;
  const roomY = bounds.h - 2 * EDGE - fitted.h;
  return keepInside(
    {
      x: bounds.x + EDGE + placement.fx * Math.max(0, roomX),
      y: bounds.y + EDGE + placement.fy * Math.max(0, roomY),
      ...fitted,
    },
    bounds,
  );
}

/** A free placement that puts the panel at `box`. */
export function freeAt(box: Box, bounds: Box): Placement {
  const roomX = bounds.w - 2 * EDGE - box.w;
  const roomY = bounds.h - 2 * EDGE - box.h;
  return {
    kind: "free",
    fx: roomX > 0 ? clamp((box.x - bounds.x - EDGE) / roomX, 0, 1) : 0,
    fy: roomY > 0 ? clamp((box.y - bounds.y - EDGE) / roomY, 0, 1) : 0,
  };
}

/**
 * While dragging: the corner the panel would snap to at `box`, or null.
 * `engaged` is the corner it is snapped to right now (it holds until RELEASE).
 */
export function snapCorner(box: Box, owner: Box, engaged: Corner | null): Corner | null {
  let best: Corner | null = null;
  let bestDist = Infinity;
  for (const corner of CORNERS) {
    const at = cornerPosition(corner, box, owner);
    const dist = Math.hypot(box.x - at.x, box.y - at.y);
    const limit = corner === engaged ? RELEASE : ENGAGE;
    if (dist <= limit && dist < bestDist) {
      best = corner;
      bestDist = dist;
    }
  }
  return best;
}

/** A resize grip: a corner or an edge (compass points). */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** The sides a snapped corner sits on, as compass letters. */
const CORNER_SIDES: Record<Corner, string> = { tl: "nw", tr: "ne", bl: "sw", br: "se" };

/**
 * Resizing by `handle`: the opposite edges stay put, the size stays within
 * the minimum and the window.
 */
export function resizedFrom(start: Box, handle: Handle, dx: number, dy: number, bounds: Box): Box {
  const left = handle.includes("w");
  const right = handle.includes("e");
  const top = handle.includes("n");
  const bottom = handle.includes("s");
  const maxW = left ? start.x + start.w - bounds.x - EDGE : bounds.x + bounds.w - EDGE - start.x;
  const maxH = top ? start.y + start.h - bounds.y - EDGE : bounds.y + bounds.h - EDGE - start.y;
  const w = left || right ? Math.round(clamp(start.w + (left ? -dx : dx), Math.min(MIN_SIZE.w, maxW), maxW)) : start.w;
  const h = top || bottom ? Math.round(clamp(start.h + (top ? -dy : dy), Math.min(MIN_SIZE.h, maxH), maxH)) : start.h;
  return { x: left ? start.x + start.w - w : start.x, y: top ? start.y + start.h - h : start.y, w, h };
}

/**
 * Where the panel is after a resize: still snapped when the grip moved only
 * edges away from its corner, otherwise free where it now is.
 */
export function afterResize(placement: Placement, handle: Handle, box: Box, bounds: Box): Placement {
  if (placement.kind === "snap" && ![...handle].some((side) => CORNER_SIDES[placement.corner].includes(side))) {
    return placement;
  }
  return freeAt(box, bounds);
}

/** Maximized: the whole window but the edge gap. */
export function maximizedBox(bounds: Box): Box {
  return { x: bounds.x + EDGE, y: bounds.y + EDGE, w: bounds.w - 2 * EDGE, h: bounds.h - 2 * EDGE };
}

/** The owner pane's box in the window, from its layout rect (0..1) in the pane area. */
export function paneBox(area: Box, rect: { x: number; y: number; w: number; h: number }): Box {
  return { x: area.x + rect.x * area.w, y: area.y + rect.y * area.h, w: rect.w * area.w, h: rect.h * area.h };
}
