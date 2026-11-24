import { describe, expect, test } from "bun:test";
import type { LayoutNode } from "../src/terminal/layout";
import { broadcastPanes, makeTab, pruneTabs } from "../src/terminal/tabs";
import {
  panesPerHost,
  tabHostsLabel,
  toggleId,
  withId,
  without,
  workspaceShapeChanged,
  workspaceTabTitle,
} from "../src/terminal/tabTitle";

const pane = (id: string, tunnelId: string): LayoutNode => ({ kind: "pane", id, tunnelId });
const split = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({ kind: "split", id: `s-${Math.random()}`, dir: "row", ratio, a, b } as LayoutNode);

describe("set helpers", () => {
  test("without removes ids and returns the same set when none present", () => {
    const s = new Set(["a", "b"]);
    expect(without(s, ["x"])).toBe(s);
    expect([...without(s, ["a", "x"])]).toEqual(["b"]);
    expect(without(s, [])).toBe(s);
  });
  test("withId adds once and keeps identity when present", () => {
    const s = new Set(["a"]);
    expect(withId(s, "a")).toBe(s);
    const n = withId(s, "b");
    expect([...n]).toEqual(["a", "b"]);
    expect(s.has("b")).toBe(false);
  });
  test("toggleId adds or removes", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleId([], "a")).toEqual(["a"]);
  });
});

describe("tab labels", () => {
  const names: Record<string, string> = { t1: "web", t2: "db" };
  const nameOf = (id: string) => names[id];
  test("one pane: just the host", () => {
    expect(tabHostsLabel(pane("p1", "t1"), "p1", nameOf)).toBe("web");
  });
  test("several panes: focused host plus count of the others", () => {
    const root = split(pane("p1", "t1"), split(pane("p2", "t2"), pane("p3", "t2")));
    expect(tabHostsLabel(root, "p2", nameOf)).toBe("db +2");
  });
  test("unknown focus or host gives an empty name", () => {
    expect(tabHostsLabel(pane("p1", "gone"), "p1", nameOf)).toBe("");
    expect(tabHostsLabel(split(pane("p1", "t1"), pane("p2", "t2")), "zz", nameOf)).toBe(" +1");
  });
  test("workspace title numbers tabs only when several", () => {
    expect(workspaceTabTitle("ops", 1, 0)).toBe("ops");
    expect(workspaceTabTitle("ops", 3, 1)).toBe("ops 2/3");
    expect(workspaceTabTitle("ops", 3, 2)).toBe("ops 3/3");
  });
});

describe("workspaceShapeChanged", () => {
  const a = pane("p1", "t1");
  test("no open tabs is never a change", () => {
    expect(workspaceShapeChanged([], [a])).toBe(false);
  });
  test("same shape under fresh pane ids is unchanged", () => {
    expect(workspaceShapeChanged([pane("x", "t1")], [a])).toBe(false);
  });
  test("a split, a different host or a closed tab is a change", () => {
    expect(workspaceShapeChanged([split(a, pane("p2", "t2"))], [a])).toBe(true);
    expect(workspaceShapeChanged([pane("x", "t2")], [a])).toBe(true);
    expect(workspaceShapeChanged([a], [a, pane("p9", "t3")])).toBe(true);
  });
});

describe("panesPerHost", () => {
  test("counts across roots", () => {
    const roots = [split(pane("1", "a"), pane("2", "b")), pane("3", "a")];
    expect(panesPerHost(roots)).toEqual({ a: 2, b: 1 });
    expect(panesPerHost([])).toEqual({});
  });
});

describe("pruneTabs", () => {
  test("same array when every host exists", () => {
    const tabs = [makeTab(pane("p1", "a"))];
    expect(pruneTabs(tabs, { a: {} })).toBe(tabs);
  });
  test("drops panes of deleted hosts and tabs left empty", () => {
    const t1 = makeTab(split(pane("p1", "a"), pane("p2", "gone")));
    const t2 = makeTab(pane("p3", "gone"));
    const out = pruneTabs([t1, t2], { a: {} });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(t1.key);
    expect(out[0].root).toEqual(pane("p1", "a"));
  });
});

describe("broadcastPanes", () => {
  const root = split(pane("p1", "a"), pane("p2", "a"));
  test("null without broadcast, when zoomed or excluded, or without a tab", () => {
    const tab = makeTab(root);
    expect(broadcastPanes(tab, "p1")).toBeNull();
    expect(broadcastPanes(undefined, "p1")).toBeNull();
    expect(broadcastPanes({ ...tab, broadcast: true, zoomed: "p1" }, "p1")).toBeNull();
    expect(broadcastPanes({ ...tab, broadcast: true, excluded: ["p1"] }, "p1")).toBeNull();
  });
  test("lists included panes", () => {
    const tab = { ...makeTab(root), broadcast: true, excluded: ["p2"] };
    expect(broadcastPanes(tab, "p1")).toEqual(["p1"]);
    expect(broadcastPanes({ ...tab, excluded: [] }, "p1")).toEqual(["p1", "p2"]);
  });
});
