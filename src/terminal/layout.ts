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

/**
 * A saved layout made live again (a workspace): every pane and split gets a
 * fresh id, so opening a workspace twice never makes two panes share one, and
 * panes whose host has been deleted are dropped. Null when none is left, or
 * when `saved` isn't a layout at all (a hand-edited file).
 */
export function reviveLayout(saved: unknown, hostExists: (tunnelId: string) => boolean): LayoutNode | null {
  if (!saved || typeof saved !== "object") return null;
  const node = saved as Partial<Record<string, unknown>>;
  if (node.kind === "pane") {
    return typeof node.tunnelId === "string" && hostExists(node.tunnelId) ? newPane(node.tunnelId) : null;
  }
  if (node.kind !== "split" || (node.dir !== "row" && node.dir !== "col")) return null;
  const a = reviveLayout(node.a, hostExists);
  const b = reviveLayout(node.b, hostExists);
  if (!a || !b) return a ?? b;
  const ratio = typeof node.ratio === "number" && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5;
  return { kind: "split", id: crypto.randomUUID(), dir: node.dir, ratio, a, b };
}

/**
 * A layout's shape without its ids: which hosts, split which way, how far.
 * Equal shapes look the same on screen, so a workspace whose open tabs have
 * the shape it was saved with has nothing to save.
 */
export function layoutShape(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Partial<Record<string, unknown>>;
  if (n.kind === "pane") return String(n.tunnelId);
  const ratio = typeof n.ratio === "number" ? Math.round(n.ratio * 50) / 50 : 0.5;
  return `(${String(n.dir)}:${ratio} ${layoutShape(n.a)} ${layoutShape(n.b)})`;
}

const leafCount = (node: LayoutNode): number =>
  node.kind === "pane" ? 1 : leafCount(node.a) + leafCount(node.b);

/** Panes as the eye reads them: top to bottom, then left to right. */
export function readingOrder(root: LayoutNode): Extract<LayoutNode, { kind: "pane" }>[] {
  const round = (n: number) => Math.round(n * 1000);
  const rects = computeLayout(root).panes;
  const order = [...rects].sort((p, q) => round(p.rect.y) - round(q.rect.y) || round(p.rect.x) - round(q.rect.x));
  return order.map((p) => findPane(root, p.id)!);
}

/** Terminal cells read best a little wider than tall; the grid aims for this. */
const IDEAL_CELL_ASPECT = 1.6;

/**
 * How many columns a grid of `n` panes gets in an area `aspect` (width /
 * height) wide: the count whose cells come closest to `IDEAL_CELL_ASPECT`,
 * fewer empty slots breaking ties.
 */
export function gridColumns(n: number, aspect: number): number {
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cell = (aspect / cols) * rows;
    const score = Math.abs(Math.log(cell / IDEAL_CELL_ASPECT)) + (rows * cols - n) * 0.01;
    if (score < bestScore - 1e-9) {
      best = cols;
      bestScore = score;
    }
  }
  return best;
}

/** `nodes` side by side (`dir` "row") or stacked ("col"), each the same size. */
function evenChain(nodes: LayoutNode[], dir: SplitDir): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  return {
    kind: "split",
    id: crypto.randomUUID(),
    dir,
    ratio: 1 / nodes.length,
    a: nodes[0],
    b: evenChain(nodes.slice(1), dir),
  };
}

/**
 * `panes` as an even grid, in the order given. Rows hold as close to the
 * same number of panes as they can (5 → 3 + 2), the fuller rows first, each
 * row's panes sharing its width. `aspect` is the area's width / height.
 */
export function gridOf(panes: LayoutNode[], aspect: number): LayoutNode {
  const cols = gridColumns(panes.length, aspect > 0 && Number.isFinite(aspect) ? aspect : 1);
  const rowCount = Math.ceil(panes.length / cols);
  const rows: LayoutNode[] = [];
  let at = 0;
  for (let r = 0; r < rowCount; r++) {
    const size = Math.ceil((panes.length - at) / (rowCount - r));
    rows.push(evenChain(panes.slice(at, at + size), "row"));
    at += size;
  }
  return evenChain(rows, "col");
}

/**
 * The tab's panes as an even grid (`gridOf`) in reading order. Pane nodes
 * are reused as they are, so every shell survives; tiling a tiled tab gives
 * the same layout back.
 */
export function tileLayout(root: LayoutNode, aspect: number): LayoutNode {
  return gridOf(readingOrder(root), aspect);
}

/** Same splits, each pane given an equal share of its split by pane count. */
export function equalizeLayout(root: LayoutNode): LayoutNode {
  if (root.kind === "pane") return root;
  return {
    ...root,
    ratio: leafCount(root.a) / leafCount(root),
    a: equalizeLayout(root.a),
    b: equalizeLayout(root.b),
  };
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
