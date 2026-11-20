import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { addTunnel, getSettings, listTunnels, terminalWrite, terminalWriteMany, updateSettings } from "../api";
import { AddTunnelForm } from "../components/AddTunnelForm";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { openMenu } from "../contextMenu";
import { HostKeyPrompt } from "../components/HostKeyPrompt";
import { formatBytes } from "../format";
import { useLanguage } from "../hooks/useLanguage";
import { useTheme } from "../themes";
import { useTunnelEvents } from "../hooks/useTunnelEvents";
import type { Settings, Tunnel, TunnelInput, Workspace } from "../types";
import { HostTree, hostRows } from "./HostTree";
import {
  MAX_PANES,
  computeLayout,
  findPane,
  layoutShape,
  neighbor,
  newPane,
  paneIds,
  reviveLayout,
  setRatio,
  splitPane,
  type SplitDir,
} from "./layout";
import {
  LAST_SESSION_ID,
  deleteWorkspace,
  flushMemory,
  loadMemory,
  pruneHosts,
  saveWorkspace,
  useTerminalMemory,
} from "./memory";
import { PHASE_DOT, PaneLayer, icons } from "./PaneLayer";
import { matchShortcut, strayKeyAction } from "./shortcuts";
import { applyDrop, canDrop, detach, makeTab, type DragSource, type DropTarget, type Tab } from "./tabs";
import type { SessionInfo } from "./TerminalView";
import { useDragDrop } from "./useDragDrop";

const SHORTCUTS = [
  ["Ctrl+Shift+K", "kbSearch"],
  ["Ctrl+Shift+S", "kbSidebar"],
  ["Ctrl+Tab", "kbNextTab"],
  ["Ctrl+1…9", "kbGotoTab"],
  ["Ctrl+Shift+D", "kbSplitRight"],
  ["Ctrl+Shift+E", "kbSplitDown"],
  ["Alt+←↑↓→", "kbFocusPane"],
  ["Ctrl+Shift+Z", "kbZoom"],
  ["Ctrl+Shift+B", "kbBroadcast"],
  ["Ctrl+Shift+W", "kbClosePane"],
  ["Ctrl+Shift+C", "kbCopy"],
  ["Ctrl+Shift+V", "kbPaste"],
] as const;

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border bg-surface px-1 py-px font-mono text-[10px] text-text">
      {children}
    </kbd>
  );
}

interface PendingPaste {
  targets: number;
  lines: number;
  resolve: (ok: boolean) => void;
}

const SIDEBAR_KEY = "protunel.terminal.sidebarHidden";

/** Per-window convenience only, so browser storage (and failing quietly) is fine. */
function loadSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** Text fields of the window's own UI (search, dialogs) — not xterm's hidden input. */
function isTextField(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    el.matches("input, textarea, select, [contenteditable='true']") &&
    !el.classList.contains("xterm-helper-textarea")
  );
}

/** Removes panes whose host no longer exists; drops tabs left empty. */
function pruneTabs(tabs: Tab[], byId: Record<string, Tunnel>): Tab[] {
  let next = tabs;
  for (const tab of tabs) {
    for (const { id, tunnelId } of computeLayout(tab.root).panes) {
      if (byId[tunnelId]) continue;
      const current = next.find((x) => x.key === tab.key);
      if (current) next = detach(next, current, id);
    }
  }
  return next;
}

export function TerminalApp() {
  const { t } = useTranslation("terminal");
  const [settings, setSettings] = useState<Settings | null>(null);
  const theme = useTheme(settings);
  useLanguage(settings?.language);

  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { statuses, hostKeyQueue, dismissHostKey } = useTunnelEvents();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Per pane id. */
  const [infos, setInfos] = useState<Record<string, SessionInfo>>({});
  const [focusSignal, setFocusSignal] = useState(0);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden);
  /** Panes whose long command finished out of sight; their tab shows a dot. */
  const [attention, setAttention] = useState<Set<string>>(new Set());
  /** The save-workspace dialog: a new name, or the workspace being updated. */
  const [naming, setNaming] = useState<{ name: string; id: string | null } | null>(null);
  const memory = useTerminalMemory();
  const searchRef = useRef<HTMLInputElement>(null);
  /** Pane id → backend terminal id, for the panes whose shell is open. */
  const terminalIds = useRef(new Map<string, string>());
  // Input and drag callbacks fire outside React's render; they read the latest
  // tabs from here.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    void loadMemory();
    getSettings().then(setSettings).catch(() => {});
    const load = () =>
      listTunnels()
        .then((list) => {
          setTunnels(list);
          setLoaded(true);
        })
        .catch(() => {});
    void load();
    // Hosts are tunnels; the main window can add, rename or delete them.
    const unlisten = listen("tunnels-changed", load);
    // Theme and language are chosen in the main window's settings.
    const unlistenSettings = listen<Settings>("settings-changed", (e) => setSettings(e.payload));
    // Closing the window only hides it (reopening is then instant); its shells
    // end as if it had closed. Dropping every tab unmounts the panes, which
    // closes whatever the backend has not closed already.
    const unlistenHidden = listen("terminal-hidden", () => {
      // What was open becomes "restore last session" next time.
      if (tabsRef.current.length > 0) {
        saveWorkspace({ id: LAST_SESSION_ID, name: "", tabs: tabsRef.current.map((tab) => tab.root) });
        flushMemory();
      }
      setTabs([]);
      setAttention(new Set());
      setActiveKey(null);
      setInfos({});
      setQuery("");
      terminalIds.current.clear();
    });
    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenHidden.then((f) => f());
    };
  }, []);

  const byId = useMemo(() => Object.fromEntries(tunnels.map((tun) => [tun.id, tun])), [tunnels]);

  // A deleted host takes its panes (and what was learned about it) with it.
  useEffect(() => {
    if (!loaded) return;
    setTabs((prev) => pruneTabs(prev, byId));
    void loadMemory().then(() => pruneHosts(new Set(Object.keys(byId))));
  }, [byId, loaded]);

  // Looking at a tab clears its "finished while you were away" dot.
  useEffect(() => {
    const tab = tabs.find((x) => x.key === activeKey);
    if (!tab) return;
    const ids = paneIds(tab.root);
    setAttention((prev) => (ids.some((id) => prev.has(id)) ? new Set([...prev].filter((id) => !ids.includes(id))) : prev));
  }, [activeKey, tabs]);

  const rows = useMemo(() => hostRows(tunnels, query, collapsed), [tunnels, query, collapsed]);

  // Keep the keyboard highlight on a visible row.
  useEffect(() => {
    if (!rows.some((row) => row.tunnel.id === highlightId)) setHighlightId(rows[0]?.tunnel.id ?? null);
  }, [rows, highlightId]);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const focusedPane = activeTab ? findPane(activeTab.root, activeTab.focused) : null;
  const activeTunnel = focusedPane ? byId[focusedPane.tunnelId] : null;
  const activeInfo = focusedPane ? infos[focusedPane.id] : undefined;
  const broadcastTargets = activeTab?.broadcast
    ? paneIds(activeTab.root).filter((id) => !activeTab.excluded.includes(id)).length
    : 0;

  const updateTab = (key: string, fn: (tab: Tab) => Tab) =>
    setTabs((prev) => prev.map((tab) => (tab.key === key ? fn(tab) : tab)));

  const refocus = () => setFocusSignal((n) => n + 1);

  const focusPane = (tabKey: string, paneId: string) => {
    updateTab(tabKey, (tab) => (tab.focused === paneId ? tab : { ...tab, focused: paneId }));
    refocus();
  };

  const forgetPanes = (ids: string[]) => {
    for (const id of ids) terminalIds.current.delete(id);
    setAttention((prev) => (ids.some((id) => prev.has(id)) ? new Set([...prev].filter((id) => !ids.includes(id))) : prev));
    setInfos((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  const openHost = (tunnelId: string) => {
    const tab = makeTab(newPane(tunnelId));
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    setQuery("");
    searchRef.current?.blur();
    refocus();
  };

  const namedWorkspaces = memory.workspaces.filter((w) => w.id !== LAST_SESSION_ID);
  const lastSession = memory.workspaces.find((w) => w.id === LAST_SESSION_ID) ?? null;

  /** Panes a workspace would open now (its deleted hosts left out). */
  const workspacePanes = (workspace: Workspace) =>
    workspace.tabs
      .map((root) => reviveLayout(root, (id) => !!byId[id]))
      .reduce((n, root) => n + (root ? paneIds(root).length : 0), 0);

  /** Opens a workspace's tabs after the open ones, each pane a new shell. */
  const openWorkspace = (workspace: Workspace) => {
    const added = workspace.tabs
      .map((root) => reviveLayout(root, (id) => !!byId[id]))
      .filter((root) => root !== null)
      .map((root) => ({ ...makeTab(root), workspaceId: workspace.id }));
    if (added.length === 0) return;
    setTabs((prev) => [...prev, ...added]);
    setActiveKey(added[0].key);
    refocus();
  };

  const commitWorkspace = () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name || tabs.length === 0) return;
    // Saving under an existing name updates that workspace.
    const existing = naming.id ?? namedWorkspaces.find((w) => w.name.toLowerCase() === name.toLowerCase())?.id;
    const id = existing ?? crypto.randomUUID();
    saveWorkspace({ id, name, tabs: tabs.map((tab) => tab.root) });
    // From now on these tabs are that workspace: their changes can be saved back.
    setTabs((prev) => prev.map((tab) => ({ ...tab, workspaceId: id })));
    setNaming(null);
    refocus();
  };

  /** The named workspace a tab belongs to, if it still exists. */
  const workspaceOf = (tab: Tab | null) =>
    (tab?.workspaceId && namedWorkspaces.find((w) => w.id === tab.workspaceId)) || null;

  /** Open tabs of a workspace, in tab order. */
  const linkedTabs = (workspace: Workspace) => tabs.filter((tab) => tab.workspaceId === workspace.id);

  /** Panes split, closed, moved or resized (or tabs added/closed) since it was saved. */
  const workspaceChanged = (workspace: Workspace) => {
    const open = linkedTabs(workspace);
    if (open.length === 0) return false;
    const now = open.map((tab) => layoutShape(tab.root)).join("|");
    return now !== workspace.tabs.map(layoutShape).join("|");
  };

  /** Saves a workspace as its open tabs now look; a closed tab leaves it. */
  const saveWorkspaceChanges = (workspace: Workspace) => {
    const open = linkedTabs(workspace);
    if (open.length > 0) saveWorkspace({ ...workspace, tabs: open.map((tab) => tab.root) });
    refocus();
  };

  const activeWorkspace = workspaceOf(activeTab);
  const activeWorkspaceChanged = activeWorkspace ? workspaceChanged(activeWorkspace) : false;

  const onSaveButton = (e: ReactMouseEvent) => {
    if (!activeWorkspace) {
      setNaming({ name: "", id: null });
      return;
    }
    openMenu(e, [
      {
        label: t("workspace.saveChanges", { name: activeWorkspace.name }),
        enabled: activeWorkspaceChanged,
        action: () => saveWorkspaceChanges(activeWorkspace),
      },
      { label: t("workspace.saveAsNew"), action: () => setNaming({ name: "", id: null }) },
    ]);
  };

  /** Right-click on a tab: put it in a workspace, or take it out. */
  const tabMenu = (e: ReactMouseEvent, tab: Tab) => {
    const own = workspaceOf(tab);
    openMenu(e, [
      ...namedWorkspaces
        .filter((w) => w.id !== own?.id)
        .map((w) => ({
          label: t("workspace.addTab", { name: w.name }),
          action: () => updateTab(tab.key, (x) => ({ ...x, workspaceId: w.id })),
        })),
      ...(own
        ? [{ label: t("workspace.removeTab", { name: own.name }), action: () => updateTab(tab.key, (x) => ({ ...x, workspaceId: null })) }]
        : []),
      ...(namedWorkspaces.length > 0 ? (["separator"] as const) : []),
      { label: t("closeTab"), action: () => closeTab(tab.key) },
    ]);
  };

  /** "user@host" when the last session was a single shell; nothing for more. */
  const lastSessionTarget = (() => {
    if (!lastSession) return null;
    const roots = lastSession.tabs.map((root) => reviveLayout(root, (id) => !!byId[id])).filter((r) => r !== null);
    const panes = roots.flatMap((root) => computeLayout(root).panes);
    if (panes.length !== 1) return null;
    const tun = byId[panes[0].tunnelId];
    return tun ? `${tun.username}@${tun.host}` : null;
  })();

  const workspaceMenu = (e: ReactMouseEvent, workspace: Workspace) =>
    openMenu(e, [
      { label: t("workspace.open"), action: () => openWorkspace(workspace) },
      {
        label: t("workspace.saveChanges", { name: workspace.name }),
        enabled: workspaceChanged(workspace),
        action: () => saveWorkspaceChanges(workspace),
      },
      {
        label: t("workspace.update"),
        enabled: tabs.length > 0,
        action: () => {
          saveWorkspace({ ...workspace, tabs: tabs.map((tab) => tab.root) });
          setTabs((prev) => prev.map((tab) => ({ ...tab, workspaceId: workspace.id })));
        },
      },
      { label: t("workspace.rename"), action: () => setNaming({ name: workspace.name, id: workspace.id }) },
      "separator",
      { label: t("workspace.delete"), action: () => deleteWorkspace(workspace.id) },
    ]);

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

  const toggleBroadcast = (tabKey: string) => {
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

  const toggleExclude = (tabKey: string, paneId: string) =>
    updateTab(tabKey, (tab) => ({
      ...tab,
      excluded: tab.excluded.includes(paneId)
        ? tab.excluded.filter((id) => id !== paneId)
        : [...tab.excluded, paneId],
    }));

  /** Open terminals a keystroke typed in `paneId` should reach. */
  const inputTargets = (tabKey: string, paneId: string, ownId: string): string[] => {
    const tab = tabsRef.current.find((x) => x.key === tabKey);
    if (!tab?.broadcast || tab.excluded.includes(paneId)) return [ownId];
    return paneIds(tab.root)
      .filter((id) => !tab.excluded.includes(id))
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
      // settings-changed brings the saved value back to this window.
      setSettings(await updateSettings({ ...settings, terminalAppMouse: !settings.terminalAppMouse }));
    } catch {
      // Nothing changed; the chip keeps showing the current state.
    }
    refocus();
  };

  const toggleSidebar = () => {
    setSidebarHidden((hidden) => !hidden);
    refocus();
  };

  // Registered once; reads the latest render's state through the ref.
  const shortcutRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e) => {
    const shortcut = matchShortcut(e);
    if (!shortcut) return;
    // A dialog owns the keyboard while it is open.
    if (pendingPaste || adding || naming || hostKeyQueue.length > 0) return;
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
      case "focusPane":
        if (activeTab && !activeTab.zoomed) {
          const target = neighbor(computeLayout(activeTab.root).panes, activeTab.focused, shortcut.dir);
          if (target) focusPane(activeTab.key, target);
        }
        break;
    }
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // A terminal window must behave like a native one: no key or click may
  // reach the webview's own features (reload, find, print, caret browsing,
  // zoom, select-all of the page…).
  useEffect(() => {
    // Clicks on the window's chrome (tab bar, pane headers, sidebar rows,
    // footer) must not pull focus out of the shell, or the next keystrokes
    // land on a button or the page body. Buttons still get their click.
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".xterm, input, textarea, select, label, [role='dialog']")) return;
      // A press on an element's own scrollbar must stay a scrollbar drag.
      // (Only scrollable HTML elements: an SVG icon reports clientWidth 0.)
      const scrollable =
        target instanceof HTMLElement &&
        (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth);
      if (scrollable && (e.offsetX > target.clientWidth || e.offsetY > target.clientHeight)) return;
      e.preventDefault();
    };

    // Bubble phase: xterm has already handled (and cancelled) every key it
    // turns into shell input; see `strayKeyAction` for the rest.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const place = isTextField(target)
        ? "textField"
        : // A dialog's own buttons keep Space/Enter, like the shell keeps its keys.
          target.closest?.(".xterm, [role='dialog']")
          ? "terminal"
          : "other";
      const action = strayKeyAction(e, place);
      if (action === "pass") return;
      e.preventDefault();
      if (action === "refocus") refocus();
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault(); // page zoom
    };
    // Coming back to the window (Alt+Tab, reopening it) resumes typing.
    const onWindowFocus = () => refocus();

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const index = rows.findIndex((row) => row.tunnel.id === highlightId);
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

  const panesPerHost = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of tabs) {
      for (const { tunnelId } of computeLayout(tab.root).panes) {
        counts[tunnelId] = (counts[tunnelId] ?? 0) + 1;
      }
    }
    return counts;
  }, [tabs]);

  const tabTitle = (tab: Tab) => {
    const pane = findPane(tab.root, tab.focused);
    const name = pane ? (byId[pane.tunnelId]?.name ?? "") : "";
    const count = paneIds(tab.root).length;
    return count > 1 ? `${name} +${count - 1}` : name;
  };

  const tabTarget = drag?.target?.kind === "tab" ? drag.target : null;

  return (
    <main className="flex h-screen bg-bg text-text">
      <aside
        aria-hidden={sidebarHidden}
        className={`flex shrink-0 flex-col overflow-hidden bg-surface transition-[width] duration-150 ease-out ${
          sidebarHidden ? "w-0" : "w-60 border-r border-border"
        }`}
      >
        {/* Fixed inner width so the content slides out instead of reflowing. */}
        <div className={`flex min-h-0 w-60 flex-1 flex-col ${sidebarHidden ? "invisible" : ""}`}>
          {namedWorkspaces.length > 0 && (
            <div className="border-b border-border px-2 pb-2 pt-3">
              <span className="px-1 font-display text-xs font-semibold uppercase tracking-wider text-muted">
                {t("workspace.title")}
              </span>
              <ul className="mt-1.5 space-y-0.5">
                {namedWorkspaces.map((workspace) => {
                  const panes = workspacePanes(workspace);
                  return (
                    <li key={workspace.id}>
                      <button
                        onClick={() => openWorkspace(workspace)}
                        onContextMenu={(e) => workspaceMenu(e, workspace)}
                        disabled={panes === 0}
                        title={t("workspace.openHint")}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-text hover:bg-surface-hover disabled:opacity-40"
                      >
                        <span className="text-accent">{icons.workspace}</span>
                        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                        <span className="shrink-0 font-mono text-[10px] text-muted">{panes}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <span className="font-display text-xs font-semibold uppercase tracking-wider text-muted">
              {t("hosts")}
              <span className="ml-1.5 font-sans font-normal normal-case tracking-normal">
                {tunnels.length}
              </span>
            </span>
            <button
              onClick={() => setAdding(true)}
              title={t("newHost")}
              aria-label={t("newHost")}
              className="rounded p-1 text-muted hover:bg-surface-hover hover:text-text"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="px-3 pb-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={t("searchHosts")}
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <HostTree
            rows={rows}
            emptyText={tunnels.length === 0 ? t("noHosts") : t("noMatches")}
            statuses={statuses}
            panesPerHost={panesPerHost}
            collapsed={collapsed}
            highlightId={highlightId}
            onHighlight={setHighlightId}
            onToggle={toggleCollapsed}
            onOpen={openHost}
            beginDrag={beginDrag}
          />
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
          <button
            onClick={toggleSidebar}
            title={`${sidebarHidden ? t("showSidebar") : t("hideSidebar")} (Ctrl+Shift+S)`}
            aria-label={sidebarHidden ? t("showSidebar") : t("hideSidebar")}
            aria-pressed={!sidebarHidden}
            className="flex shrink-0 items-center border-r border-border px-2.5 text-muted hover:bg-surface-hover hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M6 2.5V13.5" stroke="currentColor" strokeWidth="1.3" />
              {sidebarHidden ? (
                <path d="M9 6L11 8L9 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M11 6L9 8L11 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
          <div data-drop-tabbar className="relative flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1">
            {tabs.map((tab) => {
              const isActive = tab.key === activeKey;
              const phase = infos[tab.focused]?.phase ?? "connecting";
              const marker = tabTarget?.tabKey === tab.key && drag?.source.kind === "tab";
              const joinTarget = tabTarget?.tabKey === tab.key && drag?.source.kind !== "tab";
              const label = tabTitle(tab);
              return (
                <div
                  key={tab.key}
                  data-drop-tab={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  onPointerDown={beginDrag({ kind: "tab", tabKey: tab.key }, label)}
                  onClick={() => {
                    setActiveKey(tab.key);
                    refocus();
                  }}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
                  onContextMenu={(e) => tabMenu(e, tab)}
                  className={`group relative mt-1 flex max-w-52 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg pl-3 pr-1.5 text-xs ${
                    isActive
                      ? "border-x border-t border-border bg-bg text-text"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  } ${joinTarget ? "bg-accent/15 text-text" : ""}`}
                >
                  {marker && (
                    // Where a dragged tab will be inserted.
                    <span
                      className={`absolute inset-y-1 w-0.5 rounded bg-accent ${
                        tabTarget.after ? "-right-px" : "-left-px"
                      }`}
                    />
                  )}
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`} />
                  {workspaceOf(tab) && (
                    <span className="shrink-0 text-muted" title={t("workspace.inWorkspace", { name: workspaceOf(tab)!.name })}>
                      {icons.workspace}
                    </span>
                  )}
                  <span className="truncate">{label}</span>
                  {!isActive && paneIds(tab.root).some((id) => attention.has(id)) && (
                    <span
                      title={t("smart.finishedHere")}
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber"
                    />
                  )}
                  {tab.broadcast && (
                    <span className="shrink-0 text-amber" title={t("broadcastOn")}>
                      {icons.broadcast}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.key);
                    }}
                    aria-label={t("closeTab")}
                    title={t("closeTab")}
                    className={`rounded p-0.5 text-muted hover:bg-surface-hover hover:text-text ${
                      isActive ? "" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    {icons.close}
                  </button>
                </div>
              );
            })}
            {drag?.target?.kind === "tabbar" ? (
              // Dropping here makes a tab of its own.
              <div className="m-1 flex shrink-0 items-center rounded border-2 border-dashed border-accent bg-accent/10 px-3 text-xs text-accent">
                {t("dropNewTab")}
              </div>
            ) : (
              <button
                onClick={focusSearch}
                title={t("newTab")}
                aria-label={t("newTab")}
                className="shrink-0 px-3 text-muted hover:bg-surface-hover hover:text-text"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1.5">
            <button
              onClick={onSaveButton}
              disabled={tabs.length === 0}
              title={
                activeWorkspace
                  ? activeWorkspaceChanged
                    ? t("workspace.changedHint", { name: activeWorkspace.name })
                    : t("workspace.savedHint", { name: activeWorkspace.name })
                  : t("workspace.save")
              }
              aria-label={t("workspace.save")}
              className={`relative rounded p-1.5 hover:bg-surface-hover disabled:opacity-40 ${
                activeWorkspace ? "text-accent" : "text-muted hover:text-text"
              }`}
            >
              {icons.workspace}
              {activeWorkspaceChanged && (
                // Unsaved changes to the workspace this tab belongs to.
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber" />
              )}
            </button>
            <button
              onClick={() => activeTab && toggleBroadcast(activeTab.key)}
              disabled={!activeTab}
              title={activeTab?.broadcast ? t("broadcastOff") : t("broadcastOnHint")}
              aria-label={t("broadcast")}
              aria-pressed={!!activeTab?.broadcast}
              className={`rounded p-1.5 hover:bg-surface-hover disabled:opacity-40 ${
                activeTab?.broadcast ? "text-amber" : "text-muted hover:text-text"
              }`}
            >
              {icons.broadcast}
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
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
          />
          {tabs.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
              <div className="max-w-sm text-center">
                <svg
                  className="mx-auto mb-3 text-accent"
                  width="28"
                  height="28"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1" />
                  <path
                    d="M4 6L6 8L4 10M8 10.5H11.5"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <h2 className="font-display text-base font-semibold">{t("emptyTitle")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {tunnels.length === 0 ? t("emptyNoHosts") : t("emptyBody")}
                </p>
                {tunnels.length === 0 ? (
                  <button
                    onClick={() => setAdding(true)}
                    className="mt-4 rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
                  >
                    {t("newHost")}
                  </button>
                ) : (
                  <>
                  {(lastSession || namedWorkspaces.length > 0) && (
                    <div className="mx-auto mt-4 flex max-w-xs flex-wrap justify-center gap-1.5">
                      {lastSession && workspacePanes(lastSession) > 0 && (
                        <button
                          onClick={() => openWorkspace(lastSession)}
                          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:bg-accent-hover"
                        >
                          {icons.restore}
                          {lastSessionTarget
                            ? t("workspace.restoreOne", { target: lastSessionTarget })
                            : t("workspace.restore", { count: workspacePanes(lastSession) })}
                        </button>
                      )}
                      {namedWorkspaces.map((workspace) => (
                        <button
                          key={workspace.id}
                          onClick={() => openWorkspace(workspace)}
                          disabled={workspacePanes(workspace) === 0}
                          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-40"
                        >
                          {icons.workspace}
                          {workspace.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <ul className="mx-auto mt-4 grid w-fit grid-cols-[auto_auto] items-center gap-x-3 gap-y-1 text-[11px] text-muted [@media(max-height:520px)]:hidden">
                    {SHORTCUTS.map(([keys, label]) => (
                      <li key={keys} className="contents">
                        <span className="text-right">
                          <Kbd>{keys}</Kbd>
                        </span>
                        <span className="text-left">{t(label)}</span>
                      </li>
                    ))}
                  </ul>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* One line at any width: lower-priority readouts drop out as the
            footer narrows (container queries), the host truncates last. */}
        <footer className="@container h-7 shrink-0 border-t border-border bg-surface px-3 font-mono text-[11px] text-muted">
          <div className="flex h-full items-center gap-4 whitespace-nowrap">
            {broadcastTargets > 0 && (
              <span className="flex shrink-0 items-center gap-1 font-sans font-medium text-amber">
                {icons.broadcast}
                {t("broadcastCount", { count: broadcastTargets })}
              </span>
            )}
            {activeTunnel && activeInfo ? (
              <>
                <span className="min-w-0 truncate text-text">
                  {activeInfo.target ?? `${activeTunnel.username}@${activeTunnel.host}:${activeTunnel.port}`}
                </span>
                <span className="hidden shrink-0 @md:inline">{t(`phase.${activeInfo.phase}`)}</span>
                {(activeInfo.mouseMode || activeInfo.mouseWanted) && settings && (
                  // Only shown while a program wants the mouse: says who has
                  // it, and one click hands it over or takes it back.
                  <button
                    onClick={() => void toggleAppMouse()}
                    title={activeInfo.mouseMode ? t("mouseAppTooltip") : t("mouseSelectTooltip")}
                    className={`shrink-0 rounded px-1.5 font-sans hover:bg-surface-hover ${
                      activeInfo.mouseMode ? "text-amber" : "text-muted hover:text-text"
                    }`}
                  >
                    {activeInfo.mouseMode ? t("mouseApp") : t("mouseSelect")}
                  </button>
                )}
                <span className="ml-auto hidden shrink-0 @lg:inline">
                  {activeInfo.cols}×{activeInfo.rows}
                </span>
                <span title={t("echoHint")} className="ml-auto shrink-0 @lg:ml-0">
                  {t("echo")} {activeInfo.echoMs === null ? "—" : `${Math.round(activeInfo.echoMs)} ms`}
                </span>
                <span className="hidden shrink-0 @xl:inline">{formatBytes(activeInfo.bytesPerSec)}/s</span>
                <span className="hidden shrink-0 uppercase @2xl:inline">{activeInfo.renderer}</span>
              </>
            ) : (
              <span>{t("noSession")}</span>
            )}
          </div>
        </footer>
      </section>

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
      {naming && (
        <Modal title={naming.id ? t("workspace.renameTitle") : t("workspace.saveTitle")} onClose={() => setNaming(null)} size="sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (naming.id) {
                const workspace = namedWorkspaces.find((w) => w.id === naming.id);
                if (workspace && naming.name.trim()) saveWorkspace({ ...workspace, name: naming.name.trim() });
                setNaming(null);
                refocus();
              } else commitWorkspace();
            }}
            className="space-y-3"
          >
            {!naming.id && (
              <p className="text-sm text-muted">
                {t("workspace.saveHint", { tabs: tabs.length, panes: tabs.reduce((n, tab) => n + paneIds(tab.root).length, 0) })}
              </p>
            )}
            <input
              autoFocus
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
              placeholder={t("workspace.namePlaceholder")}
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNaming(null)}
                className="rounded px-3 py-1.5 text-sm text-muted hover:bg-surface-hover hover:text-text"
              >
                {t("workspace.cancel")}
              </button>
              <button
                type="submit"
                disabled={!naming.name.trim()}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {t("workspace.saveButton")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingPaste && (
        <ConfirmDialog
          title={t("pasteConfirmTitle")}
          message={t("pasteConfirmMessage", {
            lines: pendingPaste.lines,
            targets: pendingPaste.targets,
          })}
          confirmLabel={t("pasteConfirm")}
          tone="danger"
          onConfirm={() => {
            pendingPaste.resolve(true);
            setPendingPaste(null);
            refocus();
          }}
          onCancel={() => {
            pendingPaste.resolve(false);
            setPendingPaste(null);
            refocus();
          }}
        />
      )}
      {hostKeyQueue[0] && <HostKeyPrompt request={hostKeyQueue[0]} onResolved={dismissHostKey} />}
    </main>
  );
}
