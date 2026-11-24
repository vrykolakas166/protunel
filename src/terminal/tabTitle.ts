// Pure labels and set helpers of the terminal window (TerminalApp).

import { computeLayout, findPane, layoutShape, paneIds, type LayoutNode } from "./layout";

/** `set` without `ids`; the same object when none of them was in it. */
export function without(set: Set<string>, ids: string[]): Set<string> {
  return ids.some((id) => set.has(id)) ? new Set([...set].filter((id) => !ids.includes(id))) : set;
}

/** `set` plus `value`; the same object when it was already in. */
export function withId<T>(set: Set<T>, value: T): Set<T> {
  return set.has(value) ? set : new Set(set).add(value);
}

/** `list` with `id` removed when present, else appended. */
export function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** What a tab's panes are: the focused host's name, "+N" for the other panes. */
export function tabHostsLabel(root: LayoutNode, focused: string, nameOf: (tunnelId: string) => string | undefined): string {
  const pane = findPane(root, focused);
  const name = pane ? (nameOf(pane.tunnelId) ?? "") : "";
  const count = paneIds(root).length;
  return count > 1 ? `${name} +${count - 1}` : name;
}

/** A workspace tab's title: the name, "name 2/3" when it has several tabs (`index` is 0-based). */
export function workspaceTabTitle(name: string, linkedCount: number, index: number): string {
  return linkedCount > 1 ? `${name} ${index + 1}/${linkedCount}` : name;
}

/** Panes split, closed, moved or resized (or tabs added/closed) since the workspace was saved. */
export function workspaceShapeChanged(openRoots: LayoutNode[], savedRoots: readonly unknown[]): boolean {
  if (openRoots.length === 0) return false;
  return openRoots.map(layoutShape).join("|") !== savedRoots.map(layoutShape).join("|");
}

/** How many panes each host has across all tabs. */
export function panesPerHost(roots: LayoutNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of roots) {
    for (const { tunnelId } of computeLayout(root).panes) {
      counts[tunnelId] = (counts[tunnelId] ?? 0) + 1;
    }
  }
  return counts;
}
