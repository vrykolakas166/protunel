import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { FileTransfer, Tunnel } from "../../types";
import { TransferList } from "./TransferList";
import type { Clip, RelayHint } from "./panelStore";

/** Footer: what is selected, the clipboard, transfers. */
export function PanelFooter({
  notice,
  selectedCount,
  itemCount,
  canPaste,
  clipboard,
  onPaste,
  running,
  progress,
  queueOpen,
  toggleQueue,
  transfers,
  byId,
  onClearTransfers,
}: {
  notice: string | null;
  selectedCount: number;
  itemCount: number;
  canPaste: boolean;
  clipboard: Clip | null;
  onPaste: () => void;
  running: number;
  progress: number | null;
  queueOpen: boolean;
  toggleQueue: () => void;
  transfers: FileTransfer[];
  byId: Record<string, Tunnel>;
  onClearTransfers: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <div className="relative flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg/60 px-2.5 text-[11px] text-muted">
      <span className="min-w-0 flex-1 truncate" role="status">
        {notice ??
          (selectedCount > 1
            ? t("files.selectedCount", { count: selectedCount })
            : t("files.itemCount", { count: itemCount }))}
      </span>
      {canPaste && clipboard && (
        <button onClick={onPaste} className="shrink-0 rounded px-1.5 text-accent hover:bg-accent/10" title={t("files.menu.paste")}>
          {t(clipboard.cut ? "files.clipCut" : "files.clipCopy", { count: clipboard.paths.length })}
        </button>
      )}
      <button
        onClick={toggleQueue}
        aria-expanded={queueOpen}
        className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 hover:bg-surface-hover ${running > 0 ? "text-accent" : "hover:text-text"}`}
      >
        <span aria-hidden="true">⇅</span>
        {running > 0 ? `${running} · ${Math.round((progress ?? 0) * 100)}%` : t("files.queue.title")}
      </button>
      {queueOpen && (
        <div className="absolute bottom-full right-1 z-10 mb-1 w-[min(26rem,calc(100%-0.5rem))] overflow-hidden rounded-md border border-border bg-surface shadow-xl">
          <TransferList transfers={transfers} byId={byId} onClear={onClearTransfers} />
        </div>
      )}
    </div>
  );
}

/** After a relayed server-to-server copy: the way to make it direct next time. */
export function RelayHintBar({
  relayHint,
  where,
  byId,
  shellAlive,
  onType,
  onCopied,
  onDismiss,
}: {
  relayHint: RelayHint;
  where: string;
  byId: Record<string, Tunnel>;
  shellAlive: boolean;
  onType: () => void;
  onCopied: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border bg-amber/10 px-2.5 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1 text-text">
        {t("files.relay.hint", {
          from: byId[relayHint.fromTunnelId] ? `${byId[relayHint.fromTunnelId].username}@${byId[relayHint.fromTunnelId].host}` : "",
          to: where,
        })}
        <code className="ml-2 break-all font-mono text-muted">{relayHint.command}</code>
      </span>
      {shellAlive && (
        <button onClick={onType} title={t("files.relay.typeTitle", { from: byId[relayHint.fromTunnelId]?.host ?? "" })} className="shrink-0 rounded bg-accent px-2 py-0.5 font-medium text-on-accent">
          {t("files.relay.type")}
        </button>
      )}
      <button
        onClick={() => {
          void writeText(relayHint.command).catch(() => {});
          onCopied();
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-surface-hover hover:text-text"
      >
        {t("files.relay.copy")}
      </button>
      <button onClick={onDismiss} aria-label={t("files.relay.dismiss")} className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-surface-hover hover:text-text">
        ×
      </button>
    </div>
  );
}
