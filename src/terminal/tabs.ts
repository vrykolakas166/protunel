// Tabs and the drag-and-drop operations between them. Pure functions: every
// move keeps pane ids, so the terminals (keyed by pane id) and their shells
// survive being dragged anywhere.

import {
  MAX_PANES,
  findPane,
  insertBeside,
  newPane,
  paneIds,
  removePane,
  type DropSide,
  type LayoutNode,
} from "./layout";

export interface Tab {
  key: string;
  root: LayoutNode;
  /** Pane that owns the keyboard. */
  focused: string;
  /** Pane temporarily filling the whole tab, if any. */
  zoomed: string | null;
  /** Typing in an included pane goes to every included pane of the tab. */
  broadcast: boolean;
  /** Panes left out of the broadcast. */
  excluded: string[];
}

export type DragSource =
  | { kind: "host"; tunnelId: string }
  | { kind: "tab"; tabKey: string }
  | { kind: "pane"; tabKey: string; paneId: string };

export type DropTarget =
  | { kind: "pane"; tabKey: string; paneId: string; side: DropSide }
  /** Onto a tab in the tab bar: reorder (tab source) or join that tab. */
  | { kind: "tab"; tabKey: string; after: boolean }
  /** Empty tab-bar space: becomes a tab of its own. */
  | { kind: "tabbar" };

export function makeTab(root: LayoutNode, focused?: string): Tab {
  return {
    key: crypto.randomUUID(),
    root,
    focused: focused ?? paneIds(root)[0],
    zoomed: null,
    broadcast: false,
    excluded: [],
  };
}

const count = (tab: Tab) => paneIds(tab.root).length;

/** Whether dropping `source` on `target` does something sensible. */
export function canDrop(tabs: Tab[], source: DragSource, target: DropTarget): boolean {
  const byKey = (key: string) => tabs.find((t) => t.key === key);
  const sourceTab = source.kind === "host" ? undefined : byKey(source.tabKey);
  const moving = source.kind === "host" ? 1 : source.kind === "pane" ? 1 : sourceTab ? count(sourceTab) : 0;

  if (target.kind === "tabbar") {
    if (source.kind === "pane") return !!sourceTab && count(sourceTab) > 1;
    return source.kind === "host";
  }
  const targetTab = byKey(target.tabKey);
  if (!targetTab) return false;

  if (target.kind === "tab") {
    if (source.kind === "tab") return source.tabKey !== target.tabKey;
    if (source.kind === "pane" && source.tabKey === target.tabKey) return false;
    return count(targetTab) + moving <= MAX_PANES;
  }

  // Onto a pane's edge.
  if (source.kind === "tab" && source.tabKey === target.tabKey) return false;
  if (source.kind === "pane" && source.paneId === target.paneId) return false;
  const sameTab = source.kind !== "host" && source.tabKey === target.tabKey;
  return sameTab || count(targetTab) + moving <= MAX_PANES;
}

export interface DropResult {
  tabs: Tab[];
  activeKey: string;
}

/** Applies a drop. Call only when `canDrop` said yes. */
export function applyDrop(tabs: Tab[], source: DragSource, target: DropTarget): DropResult | null {
  // Tab onto tab: plain reordering.
  if (source.kind === "tab" && target.kind === "tab") {
    const moving = tabs.find((t) => t.key === source.tabKey);
    if (!moving) return null;
    const rest = tabs.filter((t) => t.key !== source.tabKey);
    const at = rest.findIndex((t) => t.key === target.tabKey) + (target.after ? 1 : 0);
    rest.splice(at, 0, moving);
    return { tabs: rest, activeKey: moving.key };
  }

  // 1. Lift what is being moved out of where it lives now.
  let node: LayoutNode;
  let focus: string;
  let next = tabs;
  if (source.kind === "host") {
    node = newPane(source.tunnelId);
    focus = node.id;
  } else if (source.kind === "pane") {
    const from = tabs.find((t) => t.key === source.tabKey);
    const pane = from && findPane(from.root, source.paneId);
    if (!from || !pane) return null;
    node = pane;
    focus = pane.id;
    next = detach(tabs, from, source.paneId);
  } else {
    const from = tabs.find((t) => t.key === source.tabKey);
    if (!from) return null;
    node = from.root;
    focus = from.focused;
    next = tabs.filter((t) => t.key !== from.key);
  }

  // 2. Put it down.
  if (target.kind === "tabbar") {
    const tab = makeTab(node, focus);
    return { tabs: [...next, tab], activeKey: tab.key };
  }
  const into = next.find((t) => t.key === target.tabKey);
  if (!into) return null;
  const root =
    target.kind === "pane"
      ? insertBeside(into.root, target.paneId, target.side, node)
      : // Onto a tab label: join that tab on its right-hand side.
        ({ kind: "split", id: crypto.randomUUID(), dir: "row", ratio: 0.5, a: into.root, b: node } as const);
  return {
    tabs: next.map((t) => (t.key === into.key ? { ...t, root, focused: focus, zoomed: null } : t)),
    activeKey: into.key,
  };
}

/** A tab without one of its panes; the tab disappears when it was the last. */
export function detach(tabs: Tab[], tab: Tab, paneId: string): Tab[] {
  const root = removePane(tab.root, paneId);
  if (!root) return tabs.filter((t) => t.key !== tab.key);
  const ids = paneIds(root);
  return tabs.map((t) =>
    t.key === tab.key
      ? {
          ...t,
          root,
          focused: ids.includes(t.focused) ? t.focused : ids[0],
          zoomed: t.zoomed && ids.includes(t.zoomed) ? t.zoomed : null,
          excluded: t.excluded.filter((id) => ids.includes(id)),
        }
      : t,
  );
}
