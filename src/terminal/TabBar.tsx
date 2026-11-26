import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { openMenu, type MenuEntry } from "../contextMenu";
import type { Workspace } from "../types";
import { paneIds } from "./layout";
import { PHASE_DOT, icons } from "./PaneLayer";
import type { DragState, useDragDrop } from "./useDragDrop";
import type { Tab } from "./tabs";
import type { SessionInfo } from "./TerminalView";

interface Props {
  sidebarHidden: boolean;
  toggleSidebar: () => void;
  tabs: Tab[];
  activeKey: string | null;
  setActiveKey: (key: string) => void;
  activeTab: Tab | null;
  activeMulti: boolean;
  infos: Record<string, SessionInfo>;
  drag: DragState | null;
  beginDrag: ReturnType<typeof useDragDrop>["beginDrag"];
  refocus: () => void;
  tabTitle: (tab: Tab) => string;
  tabHosts: (tab: Tab) => string;
  workspaceOf: (tab: Tab | null) => Workspace | null;
  closeTab: (key: string) => void;
  tabMenu: (e: ReactMouseEvent, tab: Tab) => void;
  attention: Set<string>;
  alerted: Set<string>;
  unread: Set<string>;
  onSaveButton: (e: ReactMouseEvent) => void;
  activeWorkspace: Workspace | null;
  activeWorkspaceChanged: boolean;
  openFiles: (paneId: string) => void;
  filesPanes: Set<string>;
  toggleBroadcast: (tabKey: string) => void;
  layoutEntries: (tab: Tab) => MenuEntry[];
  watchEntries: (paneId: string, focusedPane: boolean) => MenuEntry[];
}

/** The tab strip (sidebar toggle, tabs, new-tab) and the toolbar on its right. */
export function TabBar({
  sidebarHidden,
  toggleSidebar,
  tabs,
  activeKey,
  setActiveKey,
  activeTab,
  activeMulti,
  infos,
  drag,
  beginDrag,
  refocus,
  tabTitle,
  tabHosts,
  workspaceOf,
  closeTab,
  tabMenu,
  attention,
  alerted,
  unread,
  onSaveButton,
  activeWorkspace,
  activeWorkspaceChanged,
  openFiles,
  filesPanes,
  toggleBroadcast,
  layoutEntries,
  watchEntries,
}: Props) {
  const { t } = useTranslation("terminal");
  const tabTarget = drag?.target?.kind === "tab" ? drag.target : null;
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
      <button
        data-tour="term-sidebar"
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
      <div data-tour="term-tabs" data-drop-tabbar className="relative flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          const phase = infos[tab.focused]?.phase ?? "connecting";
          const marker = tabTarget?.tabKey === tab.key && drag?.source.kind === "tab";
          const joinTarget = tabTarget?.tabKey === tab.key && drag?.source.kind !== "tab";
          const label = tabTitle(tab);
          // Panes out of sight: the whole tab when it is not active, the
          // panes a zoom hides when it is.
          const offScreen = isActive
            ? tab.zoomed
              ? paneIds(tab.root).filter((id) => id !== tab.zoomed)
              : []
            : paneIds(tab.root);
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
              {/* No workspace badge: the title is the workspace's name. */}
              <span
                className="truncate"
                title={
                  workspaceOf(tab)
                    ? `${t("workspace.inWorkspace", { name: workspaceOf(tab)!.name })} · ${tabHosts(tab)}`
                    : undefined
                }
              >
                {label}
              </span>
              {offScreen.some((id) => attention.has(id) || alerted.has(id)) ? (
                // A static bell, not an amber pulse: a pulsing amber dot
                // before the name means "connecting".
                <span
                  role="status"
                  title={offScreen.some((id) => alerted.has(id)) ? t("watch.firedTab") : t("smart.finishedHere")}
                  aria-label={offScreen.some((id) => alerted.has(id)) ? t("watch.firedTab") : t("smart.finishedHere")}
                  className="shrink-0 text-amber"
                >
                  {icons.bell}
                </span>
              ) : (
                offScreen.some((id) => unread.has(id)) && (
                  <span
                    title={t("watch.newOutputTab", { count: offScreen.filter((id) => unread.has(id)).length })}
                    // A ring, not a dot: the solid accent dot before the
                    // name already means "connected".
                    className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-accent"
                  />
                )
              )}
              {tab.broadcast && (
                // Dimmed while a zoom pauses it: hidden panes take no keys.
                <span
                  className={`shrink-0 text-amber ${tab.zoomed ? "opacity-40" : ""}`}
                  title={tab.zoomed ? t("broadcastPaused") : t("broadcastOn")}
                >
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
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1.5">
        <button
          data-tour="term-workspaces"
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
          data-tour="term-files"
          onClick={() => activeTab && openFiles(activeTab.focused)}
          disabled={!activeTab}
          title={`${t("files.open")} (Ctrl+Shift+O)`}
          aria-label={t("files.open")}
          aria-pressed={!!activeTab && filesPanes.has(activeTab.focused)}
          className={`rounded p-1.5 hover:bg-surface-hover disabled:opacity-40 ${
            activeTab && filesPanes.has(activeTab.focused) ? "text-accent" : "text-muted hover:text-text"
          }`}
        >
          {icons.files}
        </button>
        <button
          data-tour="term-broadcast"
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
        <button
          onClick={(e) =>
            activeTab &&
            openMenu(e, [...layoutEntries(activeTab), "separator", ...watchEntries(activeTab.focused, true)])
          }
          disabled={!activeTab}
          title={t("layout.menu")}
          data-tour="term-layout"
          aria-label={t("layout.menu")}
          aria-haspopup="menu"
          className={`flex items-center gap-0.5 rounded p-1.5 hover:bg-surface-hover disabled:opacity-40 ${
            activeTab?.syncScroll && activeMulti ? "text-accent" : "text-muted hover:text-text"
          }`}
        >
          {icons.layout}
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
