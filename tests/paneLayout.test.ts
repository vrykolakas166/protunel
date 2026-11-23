import { describe, expect, test } from "bun:test";
import {
  computeLayout,
  equalizeLayout,
  gridColumns,
  gridOf,
  newPane,
  paneIds,
  readingOrder,
  splitPane,
  tileLayout,
  type LayoutNode,
} from "../src/terminal/layout";
import { NOTIFY_COOLDOWN_MS, OutputClock, QUIET_MS, SILENCE_MS, mayNotify } from "../src/terminal/paneWatch";
import { subtreeIds } from "../src/terminal/HostTree";
import type { Tunnel } from "../src/types";

const panes = (n: number) => Array.from({ length: n }, (_, i) => newPane(`h${i}`));

/** Rows of the grid as tunnel ids, top to bottom. */
function rowsOf(root: LayoutNode): string[][] {
  const rects = computeLayout(root).panes;
  const byY = new Map<number, typeof rects>();
  for (const p of rects) {
    const y = Math.round(p.rect.y * 1000);
    byY.set(y, [...(byY.get(y) ?? []), p]);
  }
  return [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.rect.x - b.rect.x).map((p) => p.tunnelId));
}

describe("grid", () => {
  test("columns follow the area's shape", () => {
    expect(gridColumns(1, 16 / 9)).toBe(1);
    expect(gridColumns(2, 16 / 9)).toBe(2); // side by side on a wide window
    expect(gridColumns(2, 0.6)).toBe(1); // stacked on a tall one
    expect(gridColumns(4, 16 / 9)).toBe(2);
    expect(gridColumns(6, 16 / 9)).toBe(3);
  });

  test("rows are as even as possible, fuller rows first", () => {
    expect(rowsOf(gridOf(panes(5), 16 / 9)).map((r) => r.length)).toEqual([3, 2]);
    expect(rowsOf(gridOf(panes(4), 16 / 9))).toEqual([["h0", "h1"], ["h2", "h3"]]);
  });

  test("every cell of a full row is the same size", () => {
    const rects = computeLayout(gridOf(panes(6), 16 / 9)).panes.map((p) => p.rect);
    for (const r of rects) {
      expect(r.w).toBeCloseTo(1 / 3);
      expect(r.h).toBeCloseTo(1 / 2);
    }
  });

  test("tiling keeps pane ids and reading order, and is idempotent", () => {
    // A lopsided layout: h0 | (h1 / (h2 | h3))
    let root: LayoutNode = newPane("h0");
    const [a, b, c] = [newPane("h1"), newPane("h2"), newPane("h3")];
    root = splitPane(root, paneIds(root)[0], "row", a);
    root = splitPane(root, a.id, "col", b);
    root = splitPane(root, b.id, "row", c);
    const before = new Set(paneIds(root));
    const tiled = tileLayout(root, 16 / 9);
    expect(new Set(paneIds(tiled))).toEqual(before);
    expect(readingOrder(tiled).map((p) => p.tunnelId)).toEqual(readingOrder(root).map((p) => p.tunnelId));
    const again = tileLayout(tiled, 16 / 9);
    expect(computeLayout(again).panes).toEqual(computeLayout(tiled).panes);
  });

  test("equalize gives each pane an even share of its split", () => {
    let root: LayoutNode = newPane("h0");
    const a = newPane("h1");
    root = splitPane(root, paneIds(root)[0], "row", a);
    root = splitPane(root, a.id, "row", newPane("h2"));
    const widths = computeLayout(equalizeLayout(root)).panes.map((p) => p.rect.w);
    for (const w of widths) expect(w).toBeCloseTo(1 / 3);
  });
});

describe("output clock", () => {
  test("a burst needs a quiet spell before it", () => {
    const clock = new OutputClock();
    expect(clock.output(0)).toBe(true);
    expect(clock.output(1000)).toBe(false); // steady stream: one burst
    expect(clock.output(1000 + QUIET_MS - 1)).toBe(false);
    expect(clock.output(1000 + QUIET_MS - 1 + QUIET_MS)).toBe(true);
  });

  test("silence fires once per quiet spell, counted from arming", () => {
    const clock = new OutputClock();
    expect(clock.silent(SILENCE_MS * 10)).toBe(false); // never armed, never output
    clock.arm(0);
    expect(clock.silent(SILENCE_MS - 1)).toBe(false);
    expect(clock.silent(SILENCE_MS)).toBe(true);
    expect(clock.silent(SILENCE_MS * 2)).toBe(false);
    clock.output(SILENCE_MS * 2);
    expect(clock.silent(SILENCE_MS * 3)).toBe(true);
  });

  test("notifications have a cooldown", () => {
    expect(mayNotify(undefined, 0)).toBe(true);
    expect(mayNotify(0, NOTIFY_COOLDOWN_MS - 1)).toBe(false);
    expect(mayNotify(0, NOTIFY_COOLDOWN_MS)).toBe(true);
  });
});

test("subtree: a host and everything jumping through it", () => {
  const tun = (id: string, jump: string | null) => ({ id, jumpTunnelId: jump }) as unknown as Tunnel;
  const list = [tun("a", null), tun("b", "a"), tun("c", "b"), tun("d", null), tun("e", "a")];
  expect(subtreeIds(list, "a")).toEqual(["a", "b", "c", "e"]);
  expect(subtreeIds(list, "d")).toEqual(["d"]);
  expect(subtreeIds(list, "zz")).toEqual([]);
});
