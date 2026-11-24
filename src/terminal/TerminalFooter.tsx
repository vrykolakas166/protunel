import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../format";
import type { FileTransfer, Settings, Tunnel } from "../types";
import type { WatchMode } from "./paneWatch";
import { icons } from "./PaneLayer";
import { TransferList } from "./files/TransferList";
import { isActive, overallProgress } from "./files/useTransfers";
import type { Tab } from "./tabs";
import type { SessionInfo } from "./TerminalView";

/** Footer readout of transfers while the file panel is closed. */
function TransfersChip({
  transfers,
  open,
  onToggle,
  list,
}: {
  transfers: FileTransfer[];
  open: boolean;
  onToggle: () => void;
  list: React.ReactNode;
}) {
  const { t } = useTranslation("terminal");
  const running = transfers.filter(isActive);
  const progress = overallProgress(transfers);
  const failed = transfers.some((x) => x.state === "failed");
  return (
    <>
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={t("files.queue.title")}
        className={`flex shrink-0 items-center gap-1 rounded px-1.5 font-sans hover:bg-surface-hover ${
          running.length > 0 ? "text-accent" : failed ? "text-coral" : "text-muted hover:text-text"
        }`}
      >
        <span aria-hidden="true">⇅</span>
        {running.length > 0 ? `${running.length} · ${Math.round((progress ?? 0) * 100)}%` : t("files.queue.title")}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden whitespace-normal rounded-md border border-border bg-surface font-sans shadow-xl">
          {list}
        </div>
      )}
    </>
  );
}

interface Props {
  /** A file panel is on screen: it shows the transfers itself. */
  filesShown: boolean;
  transfers: FileTransfer[];
  footerQueue: boolean;
  setFooterQueue: (update: (open: boolean) => boolean) => void;
  clearFinished: () => void;
  byId: Record<string, Tunnel>;
  activeTab: Tab | null;
  activeMulti: boolean;
  activeTunnel: Tunnel | null | undefined;
  activeInfo: SessionInfo | undefined;
  broadcastTargets: number;
  broadcastHint: boolean;
  watches: Record<string, WatchMode>;
  alerted: Set<string>;
  paneMenu: (e: ReactMouseEvent, tabKey: string, paneId: string) => void;
  toggleSyncScroll: (tabKey: string) => void;
  settings: Settings | null;
  toggleAppMouse: () => Promise<void>;
}

/** The status line under the panes. */
export function TerminalFooter({
  filesShown,
  transfers,
  footerQueue,
  setFooterQueue,
  clearFinished,
  byId,
  activeTab,
  activeMulti,
  activeTunnel,
  activeInfo,
  broadcastTargets,
  broadcastHint,
  watches,
  alerted,
  paneMenu,
  toggleSyncScroll,
  settings,
  toggleAppMouse,
}: Props) {
  const { t } = useTranslation("terminal");
  // One line at any width: lower-priority readouts drop out as the footer
  // narrows (container queries), the host truncates last.
  return (
    <footer data-tour="term-footer" className="@container h-7 shrink-0 border-t border-border bg-surface px-3 font-mono text-[11px] text-muted">
      <div className="relative flex h-full items-center gap-4 whitespace-nowrap">
        {!filesShown && transfers.length > 0 && (
          <TransfersChip
            transfers={transfers}
            open={footerQueue}
            onToggle={() => setFooterQueue((v) => !v)}
            list={<TransferList transfers={transfers} byId={byId} onClear={clearFinished} />}
          />
        )}
        {activeTab?.broadcast && (
          <span className="flex shrink-0 items-center gap-1 font-sans font-medium text-amber">
            {icons.broadcast}
            {activeTab.zoomed ? t("broadcastPaused") : t("broadcastCount", { count: broadcastTargets })}
          </span>
        )}
        {broadcastHint && activeMulti && !activeTab?.broadcast && (
          <span className="flex shrink-0 items-center gap-1 font-sans text-accent">
            {icons.broadcast}
            {t("layout.broadcastHint")}
          </span>
        )}
        {activeTab && watches[activeTab.focused] && (
          <button
            onClick={(e) => paneMenu(e, activeTab.key, activeTab.focused)}
            title={t(watches[activeTab.focused] === "silence" ? "watch.armedSilence" : "watch.armedOutput")}
            className={`flex shrink-0 items-center gap-1 rounded px-1.5 font-sans hover:bg-surface-hover ${
              alerted.has(activeTab.focused) ? "text-amber" : "text-muted hover:text-text"
            }`}
          >
            {icons.watch}
            {t(watches[activeTab.focused] === "silence" ? "watch.chipSilence" : "watch.chipOutput")}
          </button>
        )}
        {activeTab?.syncScroll && activeMulti && (
          <button
            onClick={() => toggleSyncScroll(activeTab.key)}
            title={t("layout.syncScrollOff")}
            className="shrink-0 rounded px-1.5 font-sans text-accent hover:bg-surface-hover"
          >
            {activeTab.zoomed ? t("layout.syncPaused") : t("layout.syncOn")}
          </button>
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
  );
}
