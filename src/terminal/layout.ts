// Split-pane layout of one terminal tab: a binary tree whose leaves are panes.
// Pure functions only — the window renders the *computed rects* flat, so a
// pane's position in the tree can change without React remounting its
// terminal (which would drop the remote shell).

export type SplitDir = "row" | "col"; // row: side by side, col: stacked

export type LayoutNode =
  | { kind: "pane"; id: string; tunnelId: string }
  | { kind: "split"; id: string; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

/** Fractions of the tab area, 0..1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneRect {
  id: string;
  tunnelId: string;
  rect: Rect;
}

export interface DividerRect {
  splitId: string;
  dir: SplitDir;
  /** The split's own area, which the drag ratio is measured against. */
  parent: Rect;
  /** Position of the boundary line: x for "row", y for "col". */
  at: number;
}

export const MAX_PANES = 16;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function newPane(tunnelId: string): LayoutNode {
  return { kind: "pane", id: crypto.randomUUID(), tunnelId };
}

export function computeLayout(root: LayoutNode): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  const walk = (node: LayoutNode, rect: Rect) => {
    if (node.kind === "pane") {
      panes.push({ id: node.id, tunnelId: node.tunnelId, rect });
      return;
    }
    if (node.dir === "row") {
      const wa = rect.w * node.ratio;
      walk(node.a, { ...rect, w: wa });
      walk(node.b, { ...rect, x: rect.x + wa, w: rect.w - wa });
      dividers.push({ splitId: node.id, dir: "row", parent: rect, at: rect.x + wa });
    } else {
      const ha = rect.h * node.ratio;
      walk(node.a, { ...rect, h: ha });
      walk(node.b, { ...rect, y: rect.y + ha, h: rect.h - ha });
      dividers.push({ splitId: node.id, dir: "col", parent: rect, at: rect.y + ha });
    }
  };
  walk(root, FULL);
  return { panes, dividers };
}

export function paneIds(root: LayoutNode): string[] {
  return root.kind === "pane" ? [root.id] : [...paneIds(root.a), ...paneIds(root.b)];
}

export function findPane(root: LayoutNode, id: string): Extract<LayoutNode, { kind: "pane" }> | null {
  if (root.kind === "pane") return root.id === id ? root : null;
  return findPane(root.a, id) ?? findPane(root.b, id);
}

/** Splits pane `targetId`, putting `added` right of it ("row") or below it ("col"). */
export function splitPane(root: LayoutNode, targetId: string, dir: SplitDir, added: LayoutNode): LayoutNode {
  return insertBeside(root, targetId, dir === "row" ? "right" : "bottom", added);
}

/** Removes a pane; its sibling takes the parent split's place. Null when it was the last. */
export function removePane(root: LayoutNode, id: string): LayoutNode | null {
  if (root.kind === "pane") return root.id === id ? null : root;
  const a = removePane(root.a, id);
  const b = removePane(root.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === root.a && b === root.b ? root : { ...root, a, b };
}

export function setRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (root.kind === "pane") return root;
  if (root.id === splitId) return { ...root, ratio };
  return { ...root, a: setRatio(root.a, splitId, ratio), b: setRatio(root.b, splitId, ratio) };
}

export type Direction = "left" | "right" | "up" | "down";

/** The pane next to `fromId` in a direction, by geometry (what the eye expects). */
export function neighbor(panes: PaneRect[], fromId: string, dir: Direction): string | null {
  const from = panes.find((p) => p.id === fromId);
  if (!from) return null;
  const eps = 1e-6;
  const f = from.rect;
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0);

  let best: { id: string; gap: number; overlap: number } | null = null;
  for (const p of panes) {
    if (p.id === fromId) continue;
    const r = p.rect;
    let gap: number;
    let ov: number;
    if (dir === "right" || dir === "left") {
      gap = dir === "right" ? r.x - (f.x + f.w) : f.x - (r.x + r.w);
      ov = overlap(f.y, f.y + f.h, r.y, r.y + r.h);
    } else {
      gap = dir === "down" ? r.y - (f.y + f.h) : f.y - (r.y + r.h);
      ov = overlap(f.x, f.x + f.w, r.x, r.x + r.w);
    }
    if (gap < -eps || ov <= eps) continue;
    if (!best || gap < best.gap - eps || (Math.abs(gap - best.gap) <= eps && ov > best.overlap)) {
      best = { id: p.id, gap, overlap: ov };
    }
  }
  return best?.id ?? null;
}

export type DropSide = "left" | "right" | "top" | "bottom";

/** Puts `node` beside pane `targetId`, on `side`, splitting that pane in half. */
export function insertBeside(
  root: LayoutNode,
  targetId: string,
  side: DropSide,
  node: LayoutNode,
): LayoutNode {
  if (root.kind === "pane") {
    if (root.id !== targetId) return root;
    const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
    const first = side === "left" || side === "top";
    return {
      kind: "split",
      id: crypto.randomUUID(),
      dir,
      ratio: 0.5,
      a: first ? node : root,
      b: first ? root : node,
    };
  }
  return {
    ...root,
    a: insertBeside(root.a, targetId, side, node),
    b: insertBeside(root.b, targetId, side, node),
  };
}

/**
 * Which edge of a box a point is nearest, by the box's diagonals — the drop
 * zone under the cursor. `fx`/`fy` are the point's position inside the box, 0..1.
 */
export function sideAt(fx: number, fy: number): DropSide {
  const fromLeft = fx;
  const fromRight = 1 - fx;
  const fromTop = fy;
  const fromBottom = 1 - fy;
  const min = Math.min(fromLeft, fromRight, fromTop, fromBottom);
  if (min === fromLeft) return "left";
  if (min === fromRight) return "right";
  if (min === fromTop) return "top";
  return "bottom";
}
