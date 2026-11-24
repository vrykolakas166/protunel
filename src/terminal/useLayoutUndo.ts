import { useEffect, useState, type RefObject } from "react";
import { equalizeLayout, layoutShape, paneIds, tileLayout, type LayoutNode } from "./layout";
import type { Tab } from "./tabs";

/** How long "Undo" stays offered after tiling or equalizing a tab. */
export const UNDO_MS = 5000;

export interface LayoutUndo {
  tabKey: string;
  kind: "tile" | "equalize";
  before: LayoutNode;
  zoomed: string | null;
  /** The root the change produced; undo applies only while it is still there. */
  after: LayoutNode;
  at: number;
}

/** Tile / equalize a tab's panes and offer the old layout back for `UNDO_MS`. */
export function useLayoutUndo({
  tabs,
  tabsRef,
  updateTab,
  refocus,
  areaAspect,
}: {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  updateTab: (key: string, fn: (tab: Tab) => Tab) => void;
  refocus: () => void;
  areaAspect: () => number;
}) {
  /** The layout before the last tile/equalize, offered back for `UNDO_MS`. */
  const [layoutUndo, setLayoutUndo] = useState<LayoutUndo | null>(null);

  /**
   * Re-arranges a tab's panes (shells untouched) and offers the old layout
   * back for a few seconds, in case it was a misclick or looks worse. Nothing
   * is offered when the layout didn't change (tiling a tiled tab).
   */
  const relayout = (tabKey: string, kind: LayoutUndo["kind"], arrange: (root: LayoutNode) => LayoutNode) => {
    const tab = tabsRef.current.find((x) => x.key === tabKey);
    if (!tab || paneIds(tab.root).length < 2) return;
    const after = arrange(tab.root);
    const changed = layoutShape(after) !== layoutShape(tab.root) || tab.zoomed;
    if (changed) {
      updateTab(tabKey, (x) => ({ ...x, root: after, zoomed: null }));
      setLayoutUndo({ tabKey, kind, before: tab.root, zoomed: tab.zoomed, after, at: Date.now() });
    }
    refocus();
  };

  /** The tab's panes as an even grid. Pressed again while undo is offered, undoes. */
  const tileTab = (tabKey: string) => {
    if (layoutUndo?.tabKey === tabKey && layoutUndo.kind === "tile") undoLayout();
    else relayout(tabKey, "tile", (root) => tileLayout(root, areaAspect()));
  };

  const equalizeTab = (tabKey: string) => relayout(tabKey, "equalize", equalizeLayout);

  /** Puts back the layout from before the last tile/equalize, if nothing moved since. */
  const undoLayout = () => {
    const undo = layoutUndo;
    setLayoutUndo(null);
    if (!undo) return;
    updateTab(undo.tabKey, (tab) =>
      tab.root === undo.after
        ? // A restored zoom must also be the focused pane, or the one pane on
          // screen never gets the keyboard.
          { ...tab, root: undo.before, zoomed: undo.zoomed, focused: undo.zoomed ?? tab.focused }
        : tab,
    );
    refocus();
  };

  // The offer lapses after a few seconds, and as soon as the tab's layout
  // changes any other way (a pane closed, a divider dragged): undoing then
  // would throw that change away.
  useEffect(() => {
    if (!layoutUndo) return;
    const tab = tabs.find((x) => x.key === layoutUndo.tabKey);
    if (!tab || tab.root !== layoutUndo.after) {
      setLayoutUndo(null);
      return;
    }
    const timer = window.setTimeout(() => setLayoutUndo(null), layoutUndo.at + UNDO_MS - Date.now());
    return () => window.clearTimeout(timer);
  }, [layoutUndo, tabs]);

  return { layoutUndo, setLayoutUndo, tileTab, equalizeTab, undoLayout };
}
