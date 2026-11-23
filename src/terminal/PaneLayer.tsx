import {
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { ITheme } from "@xterm/xterm";
import type { Tunnel } from "../types";
import { computeLayout, type DividerRect, type DropSide, type PaneRect, type Rect } from "./layout";
import type { DragSource, Tab } from "./tabs";
import { TerminalView, type PaneHandle, type SessionInfo, type SessionPhase } from "./TerminalView";
import type { WatchMode } from "./paneWatch";
import type { DragState } from "./useDragDrop";

export const PHASE_DOT: Record<SessionPhase, string> = {
  connecting: "bg-amber animate-pulse",
  open: "bg-accent",
  closed: "bg-slate",
};

/** Smallest a pane may be dragged to, in pixels. */
const MIN_PANE_PX = 120;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const pct = (n: number) => `${n * 100}%`;

/** The half of a pane a drop on `side` would occupy. */
const PREVIEW_INSET: Record<DropSide, string> = {
  left: "0 50% 0 0",
  right: "0 0 0 50%",
  top: "0 0 50% 0",
  bottom: "50% 0 0 0",
};

export const icons = {
  // A folder: the file panel.
  files: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
    </svg>
  ),
  // A bookmark ribbon: a workspace is a named set of tabs kept to reopen
  // later. Never draw panes here: that is what the layout menu (four tiles)
  // and tiling change, and two boxes read as "copy".
  workspace: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5H12V13.5L8 10.5L4 13.5Z" />
    </svg>
  ),
  // A bell: a watch fired or a long command finished (static, unlike the
  // pulsing amber "connecting" dot).
  bell: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3Z" />
      <path d="M6.5 14h3" />
    </svg>
  ),
  restore: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5" />
    </svg>
  ),
  zoom: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 6V2H6M10 2H14V6M14 10V14H10M6 14H2V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // Brackets pointing in: back to the whole layout (zoom's counterpart).
  unzoom: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 2V6H2M14 6H10V2M10 14V10H14M2 10H6V14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  broadcast: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path
        d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
  // An eye: this pane is watched for output or silence.
  watch: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  ),
  // Four tiles: the pane layout menu.
  layout: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  close: (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  grip: (
    <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1" />
      <circle cx="6" cy="2" r="1" />
      <circle cx="2" cy="6" r="1" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="2" cy="10" r="1" />
      <circle cx="6" cy="10" r="1" />
    </svg>
  ),
};

function IconButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: (e: ReactMouseEvent) => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onMouseDown={(e) => e.preventDefault()} // keep focus in the terminal
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded p-0.5 hover:bg-surface-hover ${active ? "text-amber" : "text-muted hover:text-text"}`}
    >
      {children}
    </button>
  );
}

interface Props {
  tabs: Tab[];
  activeKey: string | null;
  byId: Record<string, Tunnel>;
  terminalTheme: ITheme;
  /** Programs on the server may take over the mouse. */
  appMouse: boolean;
  /** GPU rendering for terminals. */
  webgl: boolean;
  focusSignal: number;
  infos: Record<string, SessionInfo>;
  drag: DragState | null;
  beginDrag: (source: DragSource, label: string) => (e: ReactPointerEvent) => void;
  onInfo: (paneId: string, info: SessionInfo) => void;
  onTerminalId: (paneId: string, id: string | null) => void;
  onFocusPane: (tabKey: string, paneId: string) => void;
  onRatio: (tabKey: string, splitId: string, ratio: number) => void;
  onClosePane: (tabKey: string, paneId: string) => void;
  onToggleZoom: (tabKey: string, paneId: string) => void;
  onToggleExclude: (tabKey: string, paneId: string) => void;
  send: (tabKey: string, paneId: string, data: string, ownId: string) => void;
  confirmPaste: (tabKey: string, paneId: string, text: string) => Promise<boolean>;
  suggestions: boolean;
  longCommandSecs: number;
  onAttention: (paneId: string) => void;
  /** Dim panes without focus (`settings.terminalDimInactive`). */
  dimInactive: boolean;
  /** Panes with output you have not looked at yet. */
  unread: Set<string>;
  /** Panes whose watch has fired since you last focused them. */
  alerted: Set<string>;
  watches: Record<string, WatchMode>;
  onPaneMenu: (e: ReactMouseEvent, tabKey: string, paneId: string) => void;
  onBurst: (tabKey: string, paneId: string) => void;
  onSilence: (paneId: string) => void;
  onUserScroll: (tabKey: string, paneId: string, fromBottom: number) => void;
  onHandle: (paneId: string, handle: PaneHandle | null) => void;
  /** Panes with an open file panel: framed while it is open. */
  filesPanes: Set<string>;
  onOpenFiles: (tabKey: string, paneId: string) => void;
}

/**
 * Every pane of every tab, as flat absolutely positioned siblings keyed by
 * pane id. Splitting, closing, zooming and dragging panes between tabs only
 * move boxes — no terminal ever remounts and drops its shell.
 */
export function PaneLayer({
  tabs,
  activeKey,
  byId,
  terminalTheme,
  appMouse,
  webgl,
  focusSignal,
  infos,
  drag,
  beginDrag,
  onInfo,
  onTerminalId,
  onFocusPane,
  onRatio,
  onClosePane,
  onToggleZoom,
  onToggleExclude,
  send,
  confirmPaste,
  suggestions,
  longCommandSecs,
  onAttention,
  dimInactive,
  unread,
  alerted,
  watches,
  onPaneMenu,
  onBurst,
  onSilence,
  onUserScroll,
  onHandle,
  filesPanes,
  onOpenFiles,
}: Props) {
  const { t } = useTranslation("terminal");
  const areaRef = useRef<HTMLDivElement>(null);

  const layouts = useMemo(
    () => tabs.map((tab) => ({ tab, ...computeLayout(tab.root) })),
    [tabs],
  );
  const active = layouts.find((l) => l.tab.key === activeKey);

  const startResize = (tabKey: string, divider: DividerRect) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const area = areaRef.current;
    if (!area || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const bounds = area.getBoundingClientRect();
    const { parent, dir, splitId } = divider;
    const spanPx = dir === "row" ? parent.w * bounds.width : parent.h * bounds.height;
    const min = Math.min(0.45, MIN_PANE_PX / Math.max(spanPx, 1));
    const move = (ev: PointerEvent) => {
      const fraction =
        dir === "row"
          ? ((ev.clientX - bounds.left) / bounds.width - parent.x) / parent.w
          : ((ev.clientY - bounds.top) / bounds.height - parent.y) / parent.h;
      onRatio(tabKey, splitId, Math.min(1 - min, Math.max(min, fraction)));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      const tab = tabs.find((x) => x.key === tabKey);
      if (tab) onFocusPane(tabKey, tab.focused); // hand the keyboard back
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const renderPane = (tab: Tab, { id, tunnelId, rect }: PaneRect, multi: boolean) => {
    const tunnel = byId[tunnelId];
    if (!tunnel) return null;
    const tabVisible = tab.key === activeKey;
    const hiddenByZoom = tab.zoomed !== null && tab.zoomed !== id;
    const shown = tabVisible && !hiddenByZoom;
    const box = tab.zoomed === id ? FULL : rect;
    const isFocused = tab.focused === id;
    // Broadcast pauses while a pane is zoomed: the hidden panes must not
    // take keystrokes nobody can see landing.
    const member = tab.broadcast && !tab.excluded.includes(id);
    const included = member && !tab.zoomed;
    const watch = watches[id];
    const isAlerted = alerted.has(id);
    const isUnread = unread.has(id);
    const dimmed = dimInactive && multi && shown && !isFocused && tab.zoomed !== id && !included;
    const phase = infos[id]?.phase ?? "connecting";
    // Where the shell really is; the saved host may have been edited since.
    const saved = `${tunnel.username}@${tunnel.host}:${tunnel.port}`;
    const target = infos[id]?.target ?? saved;
    const stale = target !== saved;
    const showHeader = multi || tab.broadcast;
    const dragged = drag?.source.kind === "pane" && drag.source.paneId === id;
    const preview =
      drag?.target?.kind === "pane" && drag.target.paneId === id ? drag.target.side : null;
    // Amber frames mark every pane that receives broadcast keystrokes; the
    // focused one, where the typing happens, gets the heavier frame.
    const frame = included ? `inset 0 0 0 ${isFocused ? 2 : 1}px var(--color-amber)` : undefined;

    return (
      <div
        key={id}
        data-drop-pane={shown ? id : undefined}
        data-tab-key={tab.key}
        data-pin-scroll
        className={shown ? "absolute flex flex-col overflow-hidden" : "hidden"}
        style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
        onMouseDownCapture={(e) => {
          if (isFocused) return;
          onFocusPane(tab.key, id);
          // The click that focuses a pane is not meant for the app inside it:
          // in htop, mc or vim with mouse reporting on, it would land as a
          // real click (htop quits on a click on its F10 label).
          const inTerminal = (e.target as HTMLElement).closest(".xterm.enable-mouse-events");
          if (inTerminal) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {showHeader && (
          <div
            data-tour={shown && isFocused ? "term-header" : undefined}
            onPointerDown={beginDrag({ kind: "pane", tabKey: tab.key, paneId: id }, tunnel.name)}
            onContextMenu={(e) => onPaneMenu(e, tab.key, id)}
            title={t("dragPaneHint")}
            className={`flex h-6 shrink-0 cursor-grab items-center gap-1.5 border-b border-border bg-surface px-1.5 text-[11px] ${
              isFocused ? "text-text" : "text-muted"
            }`}
            style={{
              boxShadow: isFocused && !included ? "inset 0 -2px 0 var(--color-accent)" : undefined,
            }}
          >
            <span className="text-muted/70">{icons.grip}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`} />
            <span className="min-w-0 flex-1 truncate" title={`${tunnel.name} · ${target}`}>
              {tunnel.name}
              <span className="ml-1.5 font-mono text-[10px] text-muted">{target}</span>
            </span>
            {isUnread && !isAlerted && (
              <span
                role="status"
                title={t("watch.newOutput")}
                aria-label={t("watch.newOutput")}
                // A ring, unlike the solid connection dot before the name.
                className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-accent"
              />
            )}
            {(watch || isAlerted) && (
              // Shown only while a watch is armed; amber once it has fired.
              <IconButton
                label={
                  isAlerted
                    ? t(watch === "silence" ? "watch.firedSilence" : "watch.firedOutput")
                    : t(watch === "silence" ? "watch.armedSilence" : "watch.armedOutput")
                }
                onClick={(e) => onPaneMenu(e, tab.key, id)}
                active={isAlerted}
              >
                {/* Steady amber once fired: pulsing amber means "connecting". */}
                {icons.watch}
              </IconButton>
            )}
            {stale && (
              <span
                title={t("staleTargetHint", { saved })}
                className="shrink-0 rounded bg-amber/15 px-1 text-[10px] font-medium text-amber"
              >
                {t("staleTarget")}
              </span>
            )}
            {tab.broadcast && (
              <IconButton
                label={member ? t("excludeFromBroadcast") : t("includeInBroadcast")}
                onClick={() => onToggleExclude(tab.key, id)}
                active={member}
              >
                {icons.broadcast}
              </IconButton>
            )}
            <IconButton
              label={`${t("files.open")} (Ctrl+Shift+O)`}
              onClick={() => onOpenFiles(tab.key, id)}
              active={filesPanes.has(id)}
            >
              {icons.files}
            </IconButton>
            {multi && (
              <IconButton
                label={tab.zoomed === id ? t("unzoom") : t("zoom")}
                onClick={() => onToggleZoom(tab.key, id)}
                active={tab.zoomed === id}
              >
                {tab.zoomed === id ? icons.unzoom : icons.zoom}
              </IconButton>
            )}
            <IconButton label={t("closePane")} onClick={() => onClosePane(tab.key, id)}>
              {icons.close}
            </IconButton>
          </div>
        )}
        <div data-pin-scroll className={`relative min-h-0 flex-1 overflow-hidden transition-opacity ${dragged ? "opacity-40" : ""}`}>
          <TerminalView
            tunnel={tunnel}
            visible={shown}
            focused={isFocused}
            theme={terminalTheme}
            appMouse={appMouse}
            webgl={webgl}
            focusSignal={focusSignal}
            onInfo={(info) => onInfo(id, info)}
            onFocus={() => onFocusPane(tab.key, id)}
            onTerminalId={(terminalId) => onTerminalId(id, terminalId)}
            send={(data, ownId) => send(tab.key, id, data, ownId)}
            confirmPaste={(text) => confirmPaste(tab.key, id, text)}
            suggestions={suggestions}
            longCommandSecs={longCommandSecs}
            onAttention={() => onAttention(id)}
            onBurst={() => onBurst(tab.key, id)}
            outputWatch={watch === "output"}
            silenceWatch={watch === "silence"}
            onSilence={() => onSilence(id)}
            onUserScroll={(fromBottom) => onUserScroll(tab.key, id, fromBottom)}
            onHandle={(handle) => onHandle(id, handle)}
          />
          {dimmed && <div className="pointer-events-none absolute inset-0 bg-bg/15" />}
          {frame && <div className="pointer-events-none absolute inset-0" style={{ boxShadow: frame }} />}
          {filesPanes.has(id) && (
            // The file panel works on this pane's server.
            <div className="pointer-events-none absolute inset-0.5 rounded-sm border border-dashed border-accent/70" />
          )}
        </div>
        {preview && (
          // Where the dropped thing will land: the half it is about to take.
          <div
            className="pointer-events-none absolute z-20 p-1 transition-[inset] duration-150 ease-out"
            style={{ inset: PREVIEW_INSET[preview] }}
          >
            <div className="flex h-full w-full items-center justify-center rounded-md border-2 border-accent bg-accent/15 backdrop-blur-[1px]">
              <span className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-on-accent shadow">
                {drag?.label}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={areaRef} data-pin-scroll className="absolute inset-0 overflow-hidden">
      {layouts
        .flatMap(({ tab, panes }) => panes.map((pane) => ({ tab, pane, multi: panes.length > 1 })))
        // A fixed DOM order: rearranging panes only changes their coordinates,
        // so React never moves a terminal's node (and its WebGL canvas).
        .sort((a, b) => (a.pane.id < b.pane.id ? -1 : 1))
        .map(({ tab, pane, multi }) => renderPane(tab, pane, multi))}

      {active &&
        active.tab.zoomed === null &&
        active.dividers.map((d) => {
          const row = d.dir === "row";
          return (
            <div
              key={d.splitId}
              onPointerDown={startResize(active.tab.key, d)}
              onDoubleClick={() => onRatio(active.tab.key, d.splitId, 0.5)}
              title={t("dividerHint")}
              className={`group absolute z-10 flex justify-center ${
                row ? "w-2 -translate-x-1/2 cursor-col-resize" : "h-2 -translate-y-1/2 cursor-row-resize flex-col"
              }`}
              style={
                row
                  ? { left: pct(d.at), top: pct(d.parent.y), height: pct(d.parent.h) }
                  : { top: pct(d.at), left: pct(d.parent.x), width: pct(d.parent.w) }
              }
            >
              <div
                className={`bg-border transition-colors group-hover:bg-accent group-active:bg-accent ${
                  row ? "h-full w-px" : "h-px w-full"
                }`}
              />
            </div>
          );
        })}
    </div>
  );
}
