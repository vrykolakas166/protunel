// The transfer queue: in the file panel's footer and the terminal footer's chip.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { filesCancelTransfer, filesCopyAcross, filesReveal, filesUpload } from "../../api";
import { formatBytes } from "../../format";
import type { FileTransfer, Tunnel } from "../../types";
import { isActive } from "./useTransfers";
import { parentPath } from "./paths";
import { nextSpeed, type SpeedSample } from "./dropLogic";
import { knownErrorCode } from "./panelLogic";

interface Props {
  transfers: FileTransfer[];
  byId: Record<string, Tunnel>;
  onClear: () => void;
  /** Shown above the list; "this host" hints in the panel. */
  emptyHint?: string;
}

export function TransferList({ transfers, byId, onClear, emptyHint }: Props) {
  const { t } = useTranslation("terminal");
  const finished = transfers.some((x) => !isActive(x));
  if (transfers.length === 0) {
    return <p className="px-3 py-4 text-center text-xs text-muted">{emptyHint ?? t("files.queue.empty")}</p>;
  }
  return (
    <div className="flex max-h-72 flex-col">
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {[...transfers].reverse().map((x) => (
          <TransferRow key={x.id} transfer={x} host={byId[x.tunnelId]} destHost={x.destTunnelId ? byId[x.destTunnelId] : undefined} />
        ))}
      </ul>
      {finished && (
        <button
          onClick={() => onClear()}
          className="shrink-0 border-t border-border px-3 py-1.5 text-left text-[11px] text-muted hover:bg-surface-hover hover:text-text"
        >
          {t("files.queue.clear")}
        </button>
      )}
    </div>
  );
}

const endpoint = (h?: Tunnel) => (h ? `${h.username}@${h.host}` : "");

function TransferRow({ transfer: x, host, destHost }: { transfer: FileTransfer; host?: Tunnel; destHost?: Tunnel }) {
  const { t } = useTranslation("terminal");
  // Relay speed from the progress deltas (Rust reports bytes, not a rate).
  const sample = useRef<SpeedSample | undefined>(undefined);
  if (x.direction === "copy" && x.state === "running") sample.current = nextSpeed(sample.current, x.done, Date.now());
  else sample.current = undefined;
  const speed = sample.current?.speed ?? null;
  const isCopy = x.direction === "copy";
  const route = !isCopy || !x.route
    ? null
    : x.route === "relay"
      ? speed !== null && x.state === "running"
        ? t("files.queue.routeRelaySpeed", { speed: formatBytes(speed) })
        : t("files.queue.routeRelay")
      : t(x.route === "rsync" ? "files.queue.routeRsync" : "files.queue.routeScp");
  const pct = x.total > 0 ? Math.min(100, Math.round((x.done / x.total) * 100)) : 0;
  const where = host ? `${host.username}@${host.host}` : "";
  const arrow = x.direction === "upload" ? "↑" : x.direction === "copy" ? "⇄" : "↓";
  const stateText: Record<FileTransfer["state"], string> = {
    queued: t("files.queue.queued"),
    running: `${pct}% · ${formatBytes(x.done)} / ${formatBytes(x.total)}`,
    done:
      x.direction === "upload"
        ? t("files.queue.uploaded")
        : x.direction === "copy"
          ? t("files.queue.copied")
          : x.direction === "dragout"
            ? t("files.queue.dragged")
            : x.openWhenDone
              ? t("files.queue.opened")
              : t("files.queue.downloaded"),
    skipped: t("files.queue.skipped"),
    failed: t("files.queue.failed"),
    cancelled: t("files.queue.cancelled"),
  };
  // A finished relay copy that left symlinks behind says so ("skipped-links:N").
  const skippedLinks = x.state === "done" ? /^skipped-links:(\d+)$/.exec(x.error ?? "") : null;
  if (skippedLinks) stateText.done = t("files.queue.skippedLinks", { count: Number(skippedLinks[1]) });
  const code = x.state === "failed" ? knownErrorCode(x.error) : null;
  const failure = code ? t(`files.err.${code}`, { where }) : x.error;
  const tone =
    x.state === "failed"
      ? "text-coral"
      : x.state === "skipped" || skippedLinks
        ? "text-amber"
        : x.state === "done"
          ? "text-accent"
          : "text-muted";
  return (
    <li className="px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className={`w-3 shrink-0 text-center font-mono ${tone}`}>{arrow}</span>
        <span className="min-w-0 flex-1 truncate text-text" title={x.direction === "upload" ? x.localPath : x.remotePath}>
          {x.name}
        </span>
        {isActive(x) && (
          <button
            onClick={() => void filesCancelTransfer(x.id)}
            className="shrink-0 rounded px-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-coral"
          >
            {t("files.queue.cancel")}
          </button>
        )}
        {x.state === "skipped" && x.direction === "upload" && (
          <button
            onClick={() => void filesUpload(x.tunnelId, [x.localPath], parentPath(x.remotePath), true)}
            className="shrink-0 rounded px-1.5 text-[11px] text-amber hover:bg-amber/10"
          >
            {t("files.queue.overwrite")}
          </button>
        )}
        {x.state === "skipped" && x.direction === "copy" && x.destTunnelId && (
          <button
            onClick={() => void filesCopyAcross(x.tunnelId, [x.remotePath], x.destTunnelId!, x.localPath, true).catch(() => {})}
            className="shrink-0 rounded px-1.5 text-[11px] text-amber hover:bg-amber/10"
          >
            {t("files.queue.overwrite")}
          </button>
        )}
        {x.state === "done" && x.direction === "download" && !x.openWhenDone && (
          <button
            onClick={() => void filesReveal(x.id)}
            className="shrink-0 rounded px-1.5 text-[11px] text-accent hover:bg-accent/10"
          >
            {t("files.queue.reveal")}
          </button>
        )}
      </div>
      <div className="ml-5 flex items-center gap-2 text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate font-mono" title={x.error ?? undefined}>
          {isCopy
            ? `${where} → ${endpoint(destHost)}:${x.localPath}`
            : x.direction === "dragout"
              ? `${where}:${x.remotePath} → ${t("files.queue.explorer")}`
              : `${where}:${x.remotePath}`}
        </span>
        {route && <span className="shrink-0">{route}</span>}
        <span className={`shrink-0 ${tone}`}>{failure && x.state === "failed" ? failure : stateText[x.state]}</span>
      </div>
      {x.state === "running" && (
        <div className="ml-5 mt-1 h-1 overflow-hidden rounded bg-border">
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}
