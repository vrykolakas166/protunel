import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { addTunnel, getSettings, listTunnels, terminalWrite, terminalWriteMany } from "../api";
import { AddTunnelForm } from "../components/AddTunnelForm";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HostKeyPrompt } from "../components/HostKeyPrompt";
import { formatBytes } from "../format";
import { useLanguage } from "../hooks/useLanguage";
import { useTheme } from "../themes";
import { useTunnelEvents } from "../hooks/useTunnelEvents";
import type { Settings, Tunnel, TunnelInput } from "../types";
import { HostTree, hostRows } from "./HostTree";
import { MAX_PANES, computeLayout, findPane, neighbor, newPane, paneIds, setRatio, splitPane, type SplitDir } from "./layout";
import { PHASE_DOT, PaneLayer, icons } from "./PaneLayer";
import { matchShortcut } from "./shortcuts";
import { applyDrop, canDrop, detach, makeTab, type DragSource, type DropTarget, type Tab } from "./tabs";
import type { SessionInfo } from "./TerminalView";
import { useDragDrop } from "./useDragDrop";

const SHORTCUTS = [
  ["Ctrl+Shift+K", "kbSearch"],
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
  const searchRef = useRef<HTMLInputElement>(null);
  /** Pane id → backend terminal id, for the panes whose shell is open. */
  const terminalIds = useRef(new Map<string, string>());
  // Input and drag callbacks fire outside React's render; they read the latest
  // tabs from here.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
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
    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
    };
  }, []);

  const byId = useMemo(() => Object.fromEntries(tunnels.map((tun) => [tun.id, tun])), [tunnels]);

  // A deleted host takes its panes with it.
  useEffect(() => {
    if (loaded) setTabs((prev) => pruneTabs(prev, byId));
  }, [byId, loaded]);

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

  const focusSearch = () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  };

  // Registered once; reads the latest render's state through the ref.
  const shortcutRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e) => {
    const shortcut = matchShortcut(e);
    if (!shortcut) return;
    // A dialog owns the keyboard while it is open.
    if (pendingPaste || adding || hostKeyQueue.length > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const index = tabs.findIndex((tab) => tab.key === activeKey);
    switch (shortcut.kind) {
      case "searchHosts":
        focusSearch();
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
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
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
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
          <div data-drop-tabbar className="relative flex min-w-0 flex-1 items-stretch overflow-x-auto">
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
                  className={`group relative flex max-w-52 shrink-0 cursor-pointer items-center gap-2 border-r border-border pl-3 pr-1.5 text-xs ${
                    isActive
                      ? "bg-bg text-text shadow-[inset_0_2px_0_var(--color-accent)]"
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
                  <span className="truncate">{label}</span>
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
          <div className="flex shrink-0 items-center border-l border-border px-1.5">
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
                  <ul className="mx-auto mt-4 grid w-fit grid-cols-[auto_auto] items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                    {SHORTCUTS.map(([keys, label]) => (
                      <li key={keys} className="contents">
                        <span className="text-right">
                          <Kbd>{keys}</Kbd>
                        </span>
                        <span className="text-left">{t(label)}</span>
                      </li>
                    ))}
                  </ul>
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
                  {activeTunnel.username}@{activeTunnel.host}:{activeTunnel.port}
                </span>
                <span className="hidden shrink-0 @md:inline">{t(`phase.${activeInfo.phase}`)}</span>
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
