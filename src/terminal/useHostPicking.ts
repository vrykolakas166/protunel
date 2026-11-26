import { useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type RefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { openMenu } from "../contextMenu";
import type { Tunnel } from "../types";
import { hostTree, subtreeIds, type HostRow, type HostSection } from "./HostTree";
import { MAX_PANES, gridOf, newPane } from "./layout";
import { makeTab, type Tab } from "./tabs";
import { toggleId } from "./tabTitle";

const BROADCAST_HINT_KEY = "protunel.terminal.broadcastHintShown";

/**
 * Opening hosts from the sidebar: one host, a picked set or a whole group in
 * one tiled tab, and the pick mode (checkboxes, Shift ranges) behind them.
 */
export function useHostPicking({
  tunnels,
  byId,
  rows,
  sections,
  toggleGroup,
  setTabs,
  setActiveKey,
  setQuery,
  setHighlightId,
  searchRef,
  refocus,
  areaAspect,
  editHost,
}: {
  tunnels: Tunnel[];
  byId: Record<string, Tunnel>;
  rows: HostRow[];
  sections: HostSection[] | null;
  toggleGroup: (name: string | null, all?: (string | null)[]) => void;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveKey: Dispatch<SetStateAction<string | null>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setHighlightId: Dispatch<SetStateAction<string | null>>;
  searchRef: RefObject<HTMLInputElement | null>;
  refocus: () => void;
  areaAspect: () => number;
  /** Opens the host's edit form here, without the main window. */
  editHost: (tunnelId: string) => void;
}) {
  const { t } = useTranslation("terminal");
  /** Picking several hosts in the sidebar to open in one tab. */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  /** Where a Shift+click range starts. */
  const anchorRef = useRef<string | null>(null);
  /** The "Ctrl+Shift+B types into all" hint after opening several hosts. */
  const [broadcastHint, setBroadcastHint] = useState(false);
  /** Every host in tree order (groups included), whatever is collapsed or filtered. */
  const treeOrder = useMemo(
    () => hostTree(tunnels, "", new Set(), new Set()).rows.map((row) => row.tunnel.id),
    [tunnels],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const hiddenSelected = selected.filter((id) => !rows.some((row) => row.tunnel.id === id)).length;

  const openHost = (tunnelId: string) => {
    const tab = makeTab(newPane(tunnelId));
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    setQuery("");
    searchRef.current?.blur();
    refocus();
  };

  /** Once ever: after several hosts open together, say how to type into all. */
  const showBroadcastHintOnce = () => {
    try {
      if (localStorage.getItem(BROADCAST_HINT_KEY)) return;
      localStorage.setItem(BROADCAST_HINT_KEY, "1");
    } catch {
      return; // no storage: better never than on every open
    }
    setBroadcastHint(true);
    window.setTimeout(() => setBroadcastHint(false), 12_000);
  };

  /**
   * Opens hosts as one new tab, tiled, in tree order. Broadcast stays off:
   * typing into several servers at once is always a deliberate step.
   */
  const openHosts = (ids: string[]) => {
    const ordered = treeOrder.filter((id) => ids.includes(id) && byId[id]).slice(0, MAX_PANES);
    if (ordered.length === 0) return;
    if (ordered.length === 1) {
      openHost(ordered[0]);
      return;
    }
    const tab = makeTab(gridOf(ordered.map(newPane), areaAspect()));
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    refocus();
    showBroadcastHintOnce();
  };

  /** A click that picks a host: toggles it, or (Shift) adds the visible range from the last pick. */
  const pick = (id: string, range: boolean) => {
    const visible = rows.map((row) => row.tunnel.id);
    const anchor = anchorRef.current;
    setSelecting(true);
    setHighlightId(id);
    setSelected((prev) => {
      if (range && anchor) {
        const a = visible.indexOf(anchor);
        const b = visible.indexOf(id);
        if (a >= 0 && b >= 0) return [...new Set([...prev, ...visible.slice(Math.min(a, b), Math.max(a, b) + 1)])];
      }
      return toggleId(prev, id);
    });
    anchorRef.current = id;
  };

  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
    anchorRef.current = null;
  };

  const openSelected = () => {
    if (selected.length === 0 || selected.length > MAX_PANES) return;
    openHosts(selected);
    stopSelecting();
  };

  const hostMenu = (e: ReactMouseEvent, row: HostRow) => {
    const id = row.tunnel.id;
    const family = subtreeIds(tunnels, id);
    const children = family.length - 1;
    openMenu(e, [
      { label: t("openSession"), action: () => openHost(id) },
      ...(children > 0
        ? [
            {
              label:
                family.length > MAX_PANES
                  ? t("select.openFamilyTooMany", { count: children, max: MAX_PANES })
                  : t("select.openFamily", { count: children }),
              enabled: family.length <= MAX_PANES,
              action: () => openHosts(family),
            },
          ]
        : []),
      "separator",
      { label: t("editHost"), action: () => editHost(id) },
      { label: selectedSet.has(id) ? t("select.unpick") : t("select.pick"), action: () => pick(id, false) },
    ]);
  };

  /** `all` (Ctrl+click on a header): every group section follows the clicked one. */
  const toggleSection = (name: string | null, all: boolean) =>
    toggleGroup(name, all ? sections?.map((sec) => sec.name) : undefined);

  /** A group header's menu: open the whole group in one tab, or pick from it. */
  const sectionMenu = (e: ReactMouseEvent, section: HostSection) => {
    const count = section.ids.length;
    openMenu(e, [
      {
        label:
          count > MAX_PANES
            ? t("group.openAllTooMany", { count, max: MAX_PANES })
            : t("group.openAll", { count }),
        enabled: count > 0 && count <= MAX_PANES,
        action: () => openHosts(section.ids),
      },
      {
        // Above the pane limit this is the way in: pick which ones.
        label: t("group.selectHosts"),
        action: () => {
          setSelecting(true);
          setSelected((prev) => [...new Set([...prev, ...section.ids.slice(0, MAX_PANES)])]);
          anchorRef.current = null;
        },
      },
    ]);
  };

  return {
    selecting,
    setSelecting,
    selected,
    setSelected,
    selectedSet,
    hiddenSelected,
    broadcastHint,
    setBroadcastHint,
    openHost,
    pick,
    stopSelecting,
    openSelected,
    hostMenu,
    toggleSection,
    sectionMenu,
  };
}
