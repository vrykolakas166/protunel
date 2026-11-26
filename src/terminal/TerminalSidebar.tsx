import { useEffect, useState } from "react";
import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { Tunnel, Workspace } from "../types";
import { HostTree, type HostRow, type HostSection } from "./HostTree";
import { MAX_PANES } from "./layout";
import { icons } from "./PaneLayer";

type HostTreeProps = ComponentProps<typeof HostTree>;

const WIDTH_KEY = "protunel.terminal.sidebarWidth";
export const SIDEBAR_DEFAULT = 240;
export const SIDEBAR_MIN = 180;
/** Never more than this, nor more than 45% of the window: the panes come first. */
export const SIDEBAR_MAX = 520;

export function clampSidebar(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(windowWidth * 0.45)));
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), max));
}

/** Per-window convenience only, so browser storage (and failing quietly) is fine. */
function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n > 0 ? n : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

interface Props {
  sidebarHidden: boolean;
  namedWorkspaces: Workspace[];
  workspacePanes: (workspace: Workspace) => number;
  openWorkspace: (workspace: Workspace) => void;
  workspaceMenu: (e: ReactMouseEvent, workspace: Workspace) => void;
  tunnels: Tunnel[];
  selecting: boolean;
  setSelecting: (selecting: boolean) => void;
  stopSelecting: () => void;
  setAdding: (adding: boolean) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (query: string) => void;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  rows: HostRow[];
  sections: HostSection[] | null;
  statuses: HostTreeProps["statuses"];
  panesPerHost: HostTreeProps["panesPerHost"];
  collapsed: HostTreeProps["collapsed"];
  highlightId: string | null;
  setHighlightId: (id: string | null) => void;
  toggleCollapsed: (id: string) => void;
  openHost: (tunnelId: string) => void;
  beginDrag: HostTreeProps["beginDrag"];
  selectedSet: Set<string>;
  selected: string[];
  hiddenSelected: number;
  pick: (id: string, range: boolean) => void;
  hostMenu: (e: ReactMouseEvent, row: HostRow) => void;
  toggleSection: (name: string | null, all: boolean) => void;
  sectionMenu: (e: ReactMouseEvent, section: HostSection) => void;
  openSelected: () => void;
}

/** The host sidebar: workspaces, host search, the host tree and the multi-pick bar. */
export function TerminalSidebar({
  sidebarHidden,
  namedWorkspaces,
  workspacePanes,
  openWorkspace,
  workspaceMenu,
  tunnels,
  selecting,
  setSelecting,
  stopSelecting,
  setAdding,
  searchRef,
  query,
  setQuery,
  onSearchKey,
  rows,
  sections,
  statuses,
  panesPerHost,
  collapsed,
  highlightId,
  setHighlightId,
  toggleCollapsed,
  openHost,
  beginDrag,
  selectedSet,
  selected,
  hiddenSelected,
  pick,
  hostMenu,
  toggleSection,
  sectionMenu,
  openSelected,
}: Props) {
  const { t } = useTranslation("terminal");
  // Resizable by its right edge; the preference is kept, the shown width is
  // clamped to the window.
  const [preferred, setPreferred] = useState(loadWidth);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const width = clampSidebar(preferred, windowWidth);
  const commitWidth = (w: number) => {
    setPreferred(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      // Private mode or blocked storage: the width just won't persist.
    }
  };
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    setResizing(true);
    const move = (ev: PointerEvent) => {
      latest = clampSidebar(startWidth + ev.clientX - startX, window.innerWidth);
      setPreferred(latest);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      setResizing(false);
      commitWidth(latest);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };
  return (
    <aside
      data-tour={sidebarHidden ? undefined : "term-hosts"}
      aria-hidden={sidebarHidden}
      style={{ width: sidebarHidden ? 0 : width }}
      className={`relative flex shrink-0 flex-col overflow-hidden bg-surface ${
        resizing ? "" : "transition-[width] duration-150 ease-out"
      } ${sidebarHidden ? "" : "border-r border-border"}`}
    >
      {!sidebarHidden && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebarResize")}
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          title={t("sidebarResize")}
          onPointerDown={startResize}
          onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT)}
          className={`absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/40 ${resizing ? "bg-accent/60" : ""}`}
        />
      )}
      {/* Fixed inner width so the content slides out instead of reflowing. */}
      <div style={{ width }} className={`flex min-h-0 flex-1 flex-col ${sidebarHidden ? "invisible" : ""}`}>
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
          <span className="flex items-center gap-0.5">
          <button
            data-tour={sidebarHidden ? undefined : "term-select"}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            title={selecting ? t("select.stop") : t("select.start")}
            aria-label={t("select.start")}
            aria-pressed={selecting}
            className={`rounded p-1 hover:bg-surface-hover ${selecting ? "text-accent" : "text-muted hover:text-text"}`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="4" height="4" rx="1" />
              <path d="M2.5 4.5l1 1 1.5-2" />
              <rect x="1.5" y="9.5" width="4" height="4" rx="1" />
              <path d="M8 4.5h6.5M8 11.5h6.5" />
            </svg>
          </button>
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
          </span>
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
          selecting={selecting}
          selected={selectedSet}
          onPick={pick}
          onRowMenu={hostMenu}
          sections={sections}
          connectedCount={(ids) => ids.filter((id) => statuses[id]?.status === "connected").length}
          onToggleSection={toggleSection}
          onSectionMenu={sectionMenu}
        />
        {selecting && (
          // Picking hosts to open together: what is picked and the one action.
          <div className="space-y-2 border-t border-border p-2.5">
            <p className="text-xs text-muted">
              {selected.length === 0 ? t("select.none") : t("select.count", { count: selected.length })}
              {hiddenSelected > 0 && ` · ${t("select.hidden", { count: hiddenSelected })}`}
            </p>
            {selected.length > MAX_PANES && (
              <p className="text-[11px] text-coral">{t("select.max", { max: MAX_PANES })}</p>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={openSelected}
                disabled={selected.length === 0 || selected.length > MAX_PANES}
                className="min-w-0 flex-1 truncate rounded bg-accent px-2 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {t("select.open")}
              </button>
              <button
                onClick={stopSelecting}
                className="shrink-0 rounded px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-text"
              >
                {t("select.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
