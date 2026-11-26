import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { addTunnel, listTunnels, terminalWindowHide, terminalWrite, terminalWriteMany, updateSettings, updateTunnel } from "../api";
import { AddTunnelForm } from "../components/AddTunnelForm";
import { openMenu, type MenuEntry } from "../contextMenu";
import { HostKeyPrompt } from "../components/HostKeyPrompt";
import { useLanguage } from "../hooks/useLanguage";
import { useTheme } from "../themes";
import { useTunnelEvents } from "../hooks/useTunnelEvents";
import type { Settings, Tunnel, TunnelInput } from "../types";
import { hostTree } from "./HostTree";
import { useCollapsedGroups } from "../hooks/useCollapsedGroups";
import { MAX_PANES, computeLayout, findPane, neighbor, newPane, paneIds, setRatio, splitPane, type SplitDir } from "./layout";
import { loadMemory, pruneHosts } from "./memory";
import { PaneLayer } from "./PaneLayer";
import { matchShortcut } from "./shortcuts";
import { applyDrop, canDrop, detach, type DragSource, type DropTarget, type Tab } from "./tabs";
import type { PaneHandle, SessionInfo } from "./TerminalView";
import {
  markTerminalTourSeen,
  onTerminalTourRequest,
  shouldOfferPanesTour,
  shouldShowTerminalTour,
  TerminalTour,
} from "./TerminalTour";
import { TourOfferToast } from "./TourOfferToast";
import { useDragDrop } from "./useDragDrop";
import { broadcastPanes, pruneTabs } from "./tabs";
import { panesPerHost as countPanesPerHost, tabHostsLabel, toggleId, workspaceTabTitle } from "./tabTitle";
import { EmptyState } from "./EmptyState";
import { FilePanelsLayer } from "./FilePanelsLayer";
import { LayoutUndoToast } from "./LayoutUndoToast";
import { TabBar } from "./TabBar";
import { TerminalDialogs, type Naming, type PendingPaste } from "./TerminalDialogs";
import { TerminalFooter } from "./TerminalFooter";
import { TerminalSidebar } from "./TerminalSidebar";
import { MAX_FILE_PANELS, useFilePanels } from "./useFilePanels";
import { useHostPicking } from "./useHostPicking";
import { useLayoutUndo } from "./useLayoutUndo";
import { usePaneWatch } from "./usePaneWatch";
import { useTerminalWindowEvents } from "./useTerminalWindowEvents";
import { useUnsavedGuard } from "./useUnsavedGuard";
import { useNativeWindowGuards, useShortcutHandler } from "./useWindowKeys";
import { useWorkspaces } from "./useWorkspaces";

const SIDEBAR_KEY = "protunel.terminal.sidebarHidden";

const COLLAPSED_GROUPS_KEY = "protunel.terminal.collapsedGroups";

/** Per-window convenience only, so browser storage (and failing quietly) is fine. */
function loadSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function TerminalApp() {
  const { t } = useTranslation("terminal");
  const [settings, setSettings] = useState<Settings | null>(null);
  const theme = useTheme(settings);
  useLanguage(settings?.language);

  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showTour, setShowTour] = useState(shouldShowTerminalTour);
  /** "panes": only the part about panes and files, offered after the first shell. */
  const [tourPart, setTourPart] = useState<"all" | "panes">("all");
  const [offerPanesTour, setOfferPanesTour] = useState(false);
  const { statuses, hostKeyQueue, dismissHostKey } = useTunnelEvents();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Per pane id. */
  const [infos, setInfos] = useState<Record<string, SessionInfo>>({});
  const [focusSignal, setFocusSignal] = useState(0);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Collapsed group sections in the host tree, remembered in this window. */
  const [collapsedGroups, toggleGroup] = useCollapsedGroups(COLLAPSED_GROUPS_KEY);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The host whose edit form is open (right-click › Edit host…). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden);
  /** The save-workspace dialog: a new name, or the workspace being updated. */
  const [naming, setNaming] = useState<Naming | null>(null);
  /** Pane id → its terminal's handle for synchronized scrolling and tour focus restoration. */
  const paneHandles = useRef(new Map<string, PaneHandle>());
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Pane id → backend terminal id, for the panes whose shell is open. */
  const terminalIds = useRef(new Map<string, string>());
  // Input and drag callbacks fire outside React's render; they read the latest
  // tabs from here.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const byId = useMemo(() => Object.fromEntries(tunnels.map((tun) => [tun.id, tun])), [tunnels]);

  const updateTab = (key: string, fn: (tab: Tab) => Tab) =>
    setTabs((prev) => prev.map((tab) => (tab.key === key ? fn(tab) : tab)));

  const refocus = () => setFocusSignal((n) => n + 1);

  const focusPane = (tabKey: string, paneId: string) => {
    updateTab(tabKey, (tab) => (tab.focused === paneId ? tab : { ...tab, focused: paneId }));
    refocus();
  };

  /** The pane area's width / height, which the grid is shaped for. */
  const areaAspect = () => {
    const el = paneAreaRef.current;
    return el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 16 / 9;
  };

  const { attention, setAttention, unread, watches, alerted, watchEntries, onBurst, onSilence, forgetWatch, resetWatch } =
    usePaneWatch({ tabs, activeKey, focusSignal, tabsRef, activeKeyRef, byId, refocus });

  const { layoutUndo, setLayoutUndo, tileTab, equalizeTab, undoLayout } = useLayoutUndo({
    tabs,
    tabsRef,
    updateTab,
    refocus,
    areaAspect,
  });

  /** Actions that run after the confirmation, from the latest render. */
  const later = useRef<{
    closeTab: (key: string) => void;
    closePane: (tabKey: string, paneId: string) => void;
    openFilesEvicting: (paneId: string, victim: string) => void;
    windowClose: () => void;
  }>(null as never);

  useTerminalWindowEvents({
    tabsRef,
    terminalIds,
    later,
    setSettings,
    setTunnels,
    setLoaded,
    setTabs,
    setLayoutUndo,
    resetWatch,
    setActiveKey,
    setInfos,
    setQuery,
  });

  // A deleted host takes its panes (and what was learned about it) with it.
  useEffect(() => {
    if (!loaded) return;
    const before = tabsRef.current;
    const after = pruneTabs(before, byId);
    if (after !== before) {
      const kept = new Set(after.flatMap((tab) => paneIds(tab.root)));
      forgetPanes(before.flatMap((tab) => paneIds(tab.root)).filter((id) => !kept.has(id)));
      setTabs(after);
      setActiveKey((key) => (after.some((tab) => tab.key === key) ? key : (after[after.length - 1]?.key ?? null)));
    }
    setSelected((prev) => (prev.every((id) => byId[id]) ? prev : prev.filter((id) => byId[id])));
    void loadMemory().then(() => pruneHosts(new Set(Object.keys(byId))));
  }, [byId, loaded]);

  const {
    transfers,
    clearFinished,
    filesOpen,
    filesStack,
    filesRefs,
    setDirtyPanes,
    filesMemory,
    windowBox,
    dropHover,
    footerQueue,
    setFooterQueue,
    panels,
    filesPanes,
    raiseFiles,
    openFilesNow,
    closeFiles,
    focusFilesOwner,
    setGeometry,
    shellFor,
    shellAlive,
    unsavedAmong,
  } = useFilePanels({ tabs, byId, activeKey, paneAreaRef, terminalIds, focusPane, setActiveKey });

  const { pendingUnsaved, setPendingUnsaved, whereOf, guardUnsaved, saveAllUnsaved } = useUnsavedGuard({
    filesRefs,
    tabsRef,
    byId,
    unsavedAmong,
    setActiveKey,
    raiseFiles,
    refocus,
  });

  const { rows, sections } = useMemo(
    () => hostTree(tunnels, query, collapsed, collapsedGroups),
    [tunnels, query, collapsed, collapsedGroups],
  );
  const {
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
  } = useHostPicking({
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
    editHost: setEditingId,
  });

  // Keep the keyboard highlight on a visible row.
  useEffect(() => {
    if (!rows.some((row) => row.tunnel.id === highlightId)) setHighlightId(rows[0]?.tunnel.id ?? null);
  }, [rows, highlightId]);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const focusedPane = activeTab ? findPane(activeTab.root, activeTab.focused) : null;
  const activeTunnel = focusedPane ? byId[focusedPane.tunnelId] : null;
  const activeInfo = focusedPane ? infos[focusedPane.id] : undefined;
  const activeMulti = activeTab ? paneIds(activeTab.root).length > 1 : false;
  // Shells that would really get a keystroke now: included and open.
  const broadcastTargets =
    activeTab?.broadcast && !activeTab.zoomed
      ? paneIds(activeTab.root).filter((id) => !activeTab.excluded.includes(id) && infos[id]?.phase === "open").length
      : 0;

  const tourOpen =
    loaded && showTour && !pendingPaste && !pendingUnsaved && !adding && !editingId && !naming && hostKeyQueue.length === 0;
  const wasTourOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasTourOpen.current && !showTour && activeTab) {
      paneHandles.current.get(activeTab.focused)?.focus();
    }
    wasTourOpen.current = tourOpen;
  }, [activeTab, showTour, tourOpen]);

  // Settings › About in the main window asks for the tour through storage.
  useEffect(
    () =>
      onTerminalTourRequest(() => {
        setTourPart("all");
        setOfferPanesTour(false);
        setShowTour(true);
      }),
    [],
  );

  // Taken with no shell open, the tour stopped before panes and files: the
  // first shell offers the rest, once (a toast, never a modal over the shell).
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (hasTabs && !showTour && shouldOfferPanesTour()) setOfferPanesTour(true);
  }, [hasTabs, showTour]);

  const closeTour = (basicOnly: boolean) => {
    markTerminalTourSeen(basicOnly);
    setShowTour(false);
    refocus();
  };

  const forgetPanes = (ids: string[]) => {
    for (const id of ids) terminalIds.current.delete(id);
    forgetWatch(ids);
    setInfos((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  /** Each shell gets its own panel; asking again focuses the one it has. */
  const openFiles = (paneId: string) => {
    // At the limit the panel used longest ago gives way: its edits would go.
    const gives = filesOpen.length >= MAX_FILE_PANELS && !filesOpen.includes(paneId) ? filesStack[0] : undefined;
    if (gives && unsavedAmong([gives]).length > 0) {
      // The one asked about is the one that goes, even if a failed save
      // raised it to the top meanwhile; gone already, ask again from scratch.
      guardUnsaved([gives], () => later.current.openFilesEvicting(paneId, gives));
      return;
    }
    openFilesNow(paneId, gives);
  };
  const openFilesEvicting = (paneId: string, victim: string) => {
    if (filesOpen.includes(victim)) openFilesNow(paneId, victim);
    else openFiles(paneId);
  };

  /** Keyboard split: another shell on the focused pane's host. */
  const splitFocused = (dir: SplitDir) => {
    if (!activeTab || paneIds(activeTab.root).length >= MAX_PANES) return;
    const host = findPane(activeTab.root, activeTab.focused)?.tunnelId;
    if (!host) return;
    const pane = newPane(host);
    updateTab(activeTab.key, (tab) => ({
      ...tab,
      root: splitPane(tab.root, tab.focused, dir, pane),
      focused: pane.id,
      zoomed: null,
    }));
    refocus();
  };

  const closeTab = (key: string) => {
    const tab = tabs.find((x) => x.key === key);
    if (!tab) return;
    guardUnsaved(paneIds(tab.root), () => later.current.closeTab(key));
  };

  const closeTabNow = (key: string) => {
    const tab = tabs.find((x) => x.key === key);
    if (tab) forgetPanes(paneIds(tab.root));
    const index = tabs.findIndex((x) => x.key === key);
    const remaining = tabs.filter((x) => x.key !== key);
    setTabs(remaining);
    if (key === activeKey) {
      setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? null);
    }
  };

  const closePane = (tabKey: string, paneId: string) => {
    const tab = tabs.find((x) => x.key === tabKey);
    if (!tab) return;
    if (paneIds(tab.root).length === 1) {
      closeTab(tabKey);
      return;
    }
    guardUnsaved([paneId], () => later.current.closePane(tabKey, paneId));
  };

  const closePaneNow = (tabKey: string, paneId: string) => {
    const tab = tabs.find((x) => x.key === tabKey);
    if (!tab) return;
    if (paneIds(tab.root).length === 1) {
      closeTabNow(tabKey);
      return;
    }
    forgetPanes([paneId]);
    const { panes } = computeLayout(tab.root);
    // Focus moves to the pane that visually takes the closed one's place.
    const successor = (["left", "up", "right", "down"] as const)
      .map((dir) => neighbor(panes, paneId, dir))
      .find((id): id is string => id !== null);
    setTabs((prev) =>
      detach(prev, tab, paneId).map((x) =>
        x.key === tabKey && tab.focused === paneId && successor ? { ...x, focused: successor } : x,
      ),
    );
    refocus();
  };

  /** The window's close button, pressed while an editor has unsaved changes. */
  const windowClose = () =>
    guardUnsaved(tabsRef.current.flatMap((tab) => paneIds(tab.root)), () => void terminalWindowHide());

  later.current = { closeTab: closeTabNow, closePane: closePaneNow, openFilesEvicting, windowClose };

  const toggleBroadcast = (tabKey: string) => {
    setBroadcastHint(false);
    updateTab(tabKey, (tab) => ({ ...tab, broadcast: !tab.broadcast }));
    refocus();
  };

  const toggleZoom = (tabKey: string, paneId: string) => {
    updateTab(tabKey, (tab) => ({
      ...tab,
      focused: paneId,
      zoomed: tab.zoomed === paneId ? null : paneId,
    }));
    refocus();
  };

  const toggleSyncScroll = (tabKey: string) => {
    updateTab(tabKey, (tab) => ({ ...tab, syncScroll: !tab.syncScroll }));
    refocus();
  };

  const layoutEntries = (tab: Tab): MenuEntry[] => {
    const multi = paneIds(tab.root).length > 1;
    return [
      { label: t("layout.tile"), enabled: multi, action: () => tileTab(tab.key) },
      { label: t("layout.equalize"), enabled: multi, action: () => equalizeTab(tab.key) },
      { label: t("layout.syncScroll"), enabled: multi, checked: tab.syncScroll, action: () => toggleSyncScroll(tab.key) },
    ];
  };

  const paneMenu = (e: ReactMouseEvent, tabKey: string, paneId: string) => {
    const tab = tabs.find((x) => x.key === tabKey);
    if (!tab) return;
    const multi = paneIds(tab.root).length > 1;
    const node = findPane(tab.root, paneId);
    openMenu(e, [
      ...watchEntries(paneId, false),
      "separator",
      ...(multi
        ? [{ label: tab.zoomed === paneId ? t("unzoom") : t("zoom"), action: () => toggleZoom(tabKey, paneId) }]
        : []),
      ...(node ? [{ label: t("editHost"), action: () => setEditingId(node.tunnelId) }] : []),
      { label: t("closePane"), action: () => closePane(tabKey, paneId) },
    ]);
  };

  /** Synchronized scrolling: the other panes of the tab follow, unless one is zoomed. */
  const onUserScroll = (tabKey: string, paneId: string, fromBottom: number) => {
    const tab = tabsRef.current.find((x) => x.key === tabKey);
    if (!tab?.syncScroll || tab.zoomed || tab.key !== activeKeyRef.current) return;
    for (const id of paneIds(tab.root)) {
      if (id !== paneId) paneHandles.current.get(id)?.scrollFromBottom(fromBottom);
    }
  };

  const toggleExclude = (tabKey: string, paneId: string) =>
    updateTab(tabKey, (tab) => ({
      ...tab,
      excluded: toggleId(tab.excluded, paneId),
    }));

  /** Open terminals a keystroke typed in `paneId` should reach. */
  const inputTargets = (tabKey: string, paneId: string, ownId: string): string[] => {
    const tab = tabsRef.current.find((x) => x.key === tabKey);
    const panes = broadcastPanes(tab, paneId);
    if (!panes) return [ownId];
    return panes
      .map((id) => terminalIds.current.get(id))
      .filter((id): id is string => !!id);
  };

  const send = (tabKey: string, paneId: string, data: string, ownId: string) => {
    const targets = inputTargets(tabKey, paneId, ownId);
    const write = targets.length > 1 ? terminalWriteMany(targets, data) : terminalWrite(ownId, data);
    write.catch(() => {});
  };

  /** Multi-line text about to land in several shells at once gets a second look. */
  const confirmPaste = (tabKey: string, paneId: string, text: string): Promise<boolean> => {
    const lines = text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
    const ownId = terminalIds.current.get(paneId);
    const targets = ownId ? inputTargets(tabKey, paneId, ownId).length : 1;
    if (targets < 2 || lines < 2) return Promise.resolve(true);
    return new Promise((resolve) => setPendingPaste({ targets, lines, resolve }));
  };

  const { drag, beginDrag } = useDragDrop({
    accepts: (source: DragSource, target: DropTarget) => canDrop(tabsRef.current, source, target),
    onDrop: (source, target) => {
      const result = applyDrop(tabsRef.current, source, target);
      if (!result) return;
      setTabs(result.tabs);
      setActiveKey(result.activeKey);
      refocus();
    },
    onHoverTab: (tabKey) => setActiveKey(tabKey),
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarHidden ? "1" : "0");
    } catch {
      // Private mode or blocked storage: the choice just won't persist.
    }
  }, [sidebarHidden]);

  // The search box lives in the sidebar; asking for it brings the sidebar back.
  const focusSearch = () => {
    if (sidebarHidden) {
      setSidebarHidden(false);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
      return;
    }
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  const toggleAppMouse = async () => {
    if (!settings) return;
    try {
      setSettings(await updateSettings({ terminalAppMouse: !settings.terminalAppMouse }));
    } catch {
      // Nothing changed; the chip keeps showing the current state.
    }
    refocus();
  };

  const toggleSidebar = () => {
    setSidebarHidden((hidden) => !hidden);
    refocus();
  };

  useShortcutHandler((e) => {
    const shortcut = matchShortcut(e);
    if (!shortcut) return;
    // A dialog owns the keyboard while it is open.
    if (tourOpen || pendingPaste || pendingUnsaved || adding || editingId || naming || hostKeyQueue.length > 0) return;
    // The file panel keeps its keys; only its own toggle reaches the window.
    const inPanel = (e.target as HTMLElement | null)?.closest?.("[data-file-panel]");
    if (inPanel && shortcut.kind !== "files") return;
    e.preventDefault();
    e.stopPropagation();
    const index = tabs.findIndex((tab) => tab.key === activeKey);
    switch (shortcut.kind) {
      case "searchHosts":
        focusSearch();
        break;
      case "toggleSidebar":
        toggleSidebar();
        break;
      case "closePane":
        if (activeTab) closePane(activeTab.key, activeTab.focused);
        break;
      case "cycleTab":
        if (tabs.length > 0) {
          setActiveKey(tabs[(index + shortcut.delta + tabs.length) % tabs.length].key);
          refocus();
        }
        break;
      case "gotoTab":
        if (tabs[shortcut.index]) {
          setActiveKey(tabs[shortcut.index].key);
          refocus();
        }
        break;
      case "split":
        splitFocused(shortcut.dir);
        break;
      case "zoom":
        if (activeTab && paneIds(activeTab.root).length > 1) toggleZoom(activeTab.key, activeTab.focused);
        break;
      case "broadcast":
        if (activeTab) toggleBroadcast(activeTab.key);
        break;
      case "tile":
        // A held key would tile, undo, tile… and land wherever it was let go.
        if (activeTab && !e.repeat) tileTab(activeTab.key);
        break;
      case "files":
        // Opens the focused shell's files; pressed again, it moves the
        // keyboard between the panel and its shell.
        if (e.repeat) break;
        if (inPanel) focusFilesOwner((inPanel as HTMLElement).dataset.filePanel ?? "");
        else if (activeTab) openFiles(activeTab.focused);
        break;
      case "focusPane":
        if (activeTab && !activeTab.zoomed) {
          const target = neighbor(computeLayout(activeTab.root).panes, activeTab.focused, shortcut.dir);
          if (target) focusPane(activeTab.key, target);
        }
        break;
    }
  });
  useNativeWindowGuards(refocus);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const index = rows.findIndex((row) => row.tunnel.id === highlightId);
    // Picking hosts: Enter ticks the highlighted one, Escape stops picking.
    if (selecting && e.key === "Enter") {
      e.preventDefault();
      if (highlightId) pick(highlightId, false);
      return;
    }
    if (selecting && e.key === "Escape") {
      // First Escape clears the search (picks stay), the next stops picking.
      e.preventDefault();
      if (query) setQuery("");
      else stopSelecting();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) setHighlightId(next.tunnel.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightId) openHost(highlightId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      searchRef.current?.blur();
      refocus();
    }
  };

  const handleAdd = async (input: TunnelInput, secret?: string) => {
    const created = await addTunnel(input, secret);
    setAdding(false);
    setTunnels(await listTunnels());
    openHost(created.id);
  };

  // Same rules as the main window: a connection change restarts a running
  // tunnel (and every shell on it); `tunnels-changed` updates both windows.
  const editing = editingId ? byId[editingId] : undefined;
  const handleEdit = async (input: TunnelInput, secret?: string) => {
    if (!editingId) return;
    await updateTunnel(editingId, input, secret);
    setEditingId(null);
    setTunnels(await listTunnels());
    refocus();
  };

  const {
    namedWorkspaces,
    lastSession,
    lastSessionTarget,
    workspacePanes,
    openWorkspace,
    commitWorkspace,
    workspaceOf,
    linkedTabs,
    activeWorkspace,
    activeWorkspaceChanged,
    onSaveButton,
    tabMenu,
    workspaceMenu,
  } = useWorkspaces({
    tabs,
    byId,
    activeKey,
    activeTab,
    setActiveKey,
    setTabs,
    naming,
    setNaming,
    refocus,
    updateTab,
    closeTab,
    layoutEntries,
  });

  const panesPerHost = useMemo(() => countPanesPerHost(tabs.map((tab) => tab.root)), [tabs]);

  /** What the tab's panes are: the focused host, "+N" for the others. */
  const tabHosts = (tab: Tab) => tabHostsLabel(tab.root, tab.focused, (id) => byId[id]?.name);
  /** A workspace's tabs carry its name ("name 2/3" when it has several);
   * other tabs are named after their hosts. */
  const tabTitle = (tab: Tab) => {
    const workspace = workspaceOf(tab);
    if (!workspace) return tabHosts(tab);
    const linked = linkedTabs(workspace);
    return workspaceTabTitle(workspace.name, linked.length, linked.indexOf(tab));
  };
  return (
    <main data-pin-scroll className="flex h-screen overflow-hidden bg-bg text-text">
      <TerminalSidebar
        sidebarHidden={sidebarHidden}
        namedWorkspaces={namedWorkspaces}
        workspacePanes={workspacePanes}
        openWorkspace={openWorkspace}
        workspaceMenu={workspaceMenu}
        tunnels={tunnels}
        selecting={selecting}
        setSelecting={setSelecting}
        stopSelecting={stopSelecting}
        setAdding={setAdding}
        searchRef={searchRef}
        query={query}
        setQuery={setQuery}
        onSearchKey={onSearchKey}
        rows={rows}
        sections={sections}
        statuses={statuses}
        panesPerHost={panesPerHost}
        collapsed={collapsed}
        highlightId={highlightId}
        setHighlightId={setHighlightId}
        toggleCollapsed={toggleCollapsed}
        openHost={openHost}
        beginDrag={beginDrag}
        selectedSet={selectedSet}
        selected={selected}
        hiddenSelected={hiddenSelected}
        pick={pick}
        hostMenu={hostMenu}
        toggleSection={toggleSection}
        sectionMenu={sectionMenu}
        openSelected={openSelected}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <TabBar
          sidebarHidden={sidebarHidden}
          toggleSidebar={toggleSidebar}
          tabs={tabs}
          activeKey={activeKey}
          setActiveKey={setActiveKey}
          activeTab={activeTab}
          activeMulti={activeMulti}
          infos={infos}
          drag={drag}
          beginDrag={beginDrag}
          refocus={refocus}
          tabTitle={tabTitle}
          tabHosts={tabHosts}
          workspaceOf={workspaceOf}
          closeTab={closeTab}
          tabMenu={tabMenu}
          attention={attention}
          alerted={alerted}
          unread={unread}
          onSaveButton={onSaveButton}
          activeWorkspace={activeWorkspace}
          activeWorkspaceChanged={activeWorkspaceChanged}
          openFiles={openFiles}
          filesPanes={filesPanes}
          toggleBroadcast={toggleBroadcast}
          layoutEntries={layoutEntries}
          watchEntries={watchEntries}
        />

      <div ref={paneAreaRef} data-pin-scroll className="relative min-h-0 flex-1 overflow-hidden">
        <PaneLayer
          tabs={tabs}
          activeKey={activeKey}
          byId={byId}
          terminalTheme={theme.terminal}
          appMouse={settings?.terminalAppMouse ?? false}
          webgl={settings?.terminalWebgl ?? true}
          focusSignal={focusSignal}
          infos={infos}
          drag={drag}
          beginDrag={beginDrag}
          onInfo={(paneId, info) => setInfos((prev) => ({ ...prev, [paneId]: info }))}
          onTerminalId={(paneId, id) => {
            if (id) terminalIds.current.set(paneId, id);
            else terminalIds.current.delete(paneId);
          }}
          onFocusPane={focusPane}
          onRatio={(tabKey, splitId, ratio) =>
            updateTab(tabKey, (x) => ({ ...x, root: setRatio(x.root, splitId, ratio) }))
          }
          onClosePane={closePane}
          onToggleZoom={toggleZoom}
          onToggleExclude={toggleExclude}
          send={send}
          confirmPaste={confirmPaste}
          suggestions={settings?.terminalSuggestions ?? true}
          longCommandSecs={settings?.terminalLongCommandSecs ?? 15}
          onAttention={(paneId) => setAttention((prev) => new Set(prev).add(paneId))}
          dimInactive={settings?.terminalDimInactive ?? false}
          unread={unread}
          alerted={alerted}
          watches={watches}
          onPaneMenu={paneMenu}
          onBurst={onBurst}
          onSilence={onSilence}
          onUserScroll={onUserScroll}
          onHandle={(paneId, handle) => {
            if (handle) paneHandles.current.set(paneId, handle);
            else paneHandles.current.delete(paneId);
          }}
          filesPanes={filesPanes}
          onOpenFiles={(_tabKey, paneId) => openFiles(paneId)}
        />
          {offerPanesTour && hasTabs && !showTour && !(layoutUndo && layoutUndo.tabKey === activeKey) && (
            <TourOfferToast
              onAccept={() => {
                setOfferPanesTour(false);
                setTourPart("panes");
                setShowTour(true);
              }}
              onDismiss={() => {
                setOfferPanesTour(false);
                markTerminalTourSeen();
                refocus();
              }}
            />
          )}
          {layoutUndo && layoutUndo.tabKey === activeKey && (
            <LayoutUndoToast layoutUndo={layoutUndo} onUndo={undoLayout} onDismiss={() => setLayoutUndo(null)} />
          )}
          {tabs.length === 0 && (
            // With no tab yet the whole area takes a host dropped from the
            // sidebar (opens it in a new tab), not only the tab strip.
            <div data-drop-tabbar className="absolute inset-0">
              {drag?.target?.kind === "tabbar" && (
                // Opaque, so the empty-state text behind never shows through.
                <div className="pointer-events-none absolute inset-0 z-10 bg-bg p-3">
                  <div className="flex h-full items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-sm text-accent">
                    {t("dropOpenHere")}
                  </div>
                </div>
              )}
              <EmptyState
                hostCount={tunnels.length}
                lastSession={lastSession}
                lastSessionTarget={lastSessionTarget}
                namedWorkspaces={namedWorkspaces}
                workspacePanes={workspacePanes}
                openWorkspace={openWorkspace}
                onAddHost={() => setAdding(true)}
                onShowTour={() => {
                  setTourPart("all");
                  setOfferPanesTour(false);
                  setShowTour(true);
                }}
              />
            </div>
          )}
        </div>

        <TerminalFooter
          filesShown={panels.some((x) => x.shown)}
          transfers={transfers}
          footerQueue={footerQueue}
          setFooterQueue={setFooterQueue}
          clearFinished={clearFinished}
          byId={byId}
          activeTab={activeTab}
          activeMulti={activeMulti}
          activeTunnel={activeTunnel}
          activeInfo={activeInfo}
          broadcastTargets={broadcastTargets}
          broadcastHint={broadcastHint}
          watches={watches}
          alerted={alerted}
          paneMenu={paneMenu}
          toggleSyncScroll={toggleSyncScroll}
          settings={settings}
          toggleAppMouse={toggleAppMouse}
        />
      </section>

      <FilePanelsLayer
        panels={panels}
        filesRefs={filesRefs}
        filesMemory={filesMemory}
        paneHandles={paneHandles}
        infos={infos}
        windowBox={windowBox}
        transfers={transfers}
        byId={byId}
        clearFinished={clearFinished}
        dropHover={dropHover}
        raiseFiles={raiseFiles}
        setGeometry={setGeometry}
        shellFor={shellFor}
        shellAlive={shellAlive}
        closeFiles={closeFiles}
        focusFilesOwner={focusFilesOwner}
        setDirtyPanes={setDirtyPanes}
      />

      {drag && (
        // Follows the cursor while dragging; never a drop target itself.
        <div
          className="pointer-events-none fixed z-[70] flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-xl"
          style={{ left: drag.x + 12, top: drag.y + 10 }}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${drag.target ? "bg-accent" : "bg-slate"}`} />
          {drag.label}
        </div>
      )}

      {adding && (
        <AddTunnelForm
          mode="add"
          tunnels={tunnels}
          defaultSocksEnabled={false}
          onSubmit={handleAdd}
          onCancel={() => setAdding(false)}
        />
      )}
      {editing && (
        <AddTunnelForm
          key={editing.id}
          mode="edit"
          initial={editing}
          tunnels={tunnels}
          onSubmit={handleEdit}
          running={["connected", "connecting", "reconnecting"].includes(statuses[editing.id]?.status ?? "")}
          onCancel={() => {
            setEditingId(null);
            refocus();
          }}
        />
      )}
      <TerminalDialogs
        naming={naming}
        setNaming={setNaming}
        namedWorkspaces={namedWorkspaces}
        tabs={tabs}
        commitWorkspace={commitWorkspace}
        pendingPaste={pendingPaste}
        setPendingPaste={setPendingPaste}
        pendingUnsaved={pendingUnsaved}
        setPendingUnsaved={setPendingUnsaved}
        saveAllUnsaved={saveAllUnsaved}
        whereOf={whereOf}
        refocus={refocus}
      />
      {tourOpen && <TerminalTour hasTab={tabs.length > 0} part={tourPart} onFinish={closeTour} />}
      {hostKeyQueue[0] && <HostKeyPrompt request={hostKeyQueue[0]} onResolved={dismissHostKey} />}
    </main>
  );
}
