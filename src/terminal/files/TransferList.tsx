// The transfer queue: in the file panel's footer and the terminal footer's chip.

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { filesCancelTransfer, filesReveal, filesRetry } from "../../api";
import { formatBytes } from "../../format";
import type { Conflict, FileTransfer, Tunnel } from "../../types";
import { isActive } from "./useTransfers";
import { joinPath } from "./paths";
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
    <div className="flex max-h-72 min-h-0 flex-col">
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

/** `user@host` (port 22 left out): the endpoint a job recorded, else the host's current one. */
const shown = (recorded: string | null, h?: Tunnel) =>
  recorded ? recorded.replace(/:22$/, "") : h ? `${h.username}@${h.host}` : "";

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
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const where = shown(x.endpoint, host);
  const destWhere = shown(x.destEndpoint, destHost);
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
  const partial = x.state === "failed" && x.error === "partial";
  const failure = partial
    ? t("files.queue.partial", { done: x.filesDone, failed: x.filesFailed })
    : code
      ? t(`files.err.${code}`, { where })
      : x.error;
  /**
   * Runs the row again (Rust takes it off the list and queues a fresh one on
   * the same server): a retry, or a skipped name as Replace / Keep both.
   * Pending until the row goes; a refusal is shown on the row.
   */
  const again = (mode: Conflict | null) => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    filesRetry(x.id, mode).catch((e) => {
      const c = knownErrorCode(String(e));
      setActionError(c ? t(`files.err.${c}`, { where }) : String(e));
      setPending(false);
    });
  };
  // Where the bytes go, so a renamed copy or a picked folder can be found.
  const flow =
    x.direction === "upload"
      ? `${x.localPath} → ${where}:${x.remotePath}`
      : x.direction === "download"
        ? `${where}:${x.remotePath} → ${x.localPath}`
        : isCopy
          ? `${where}:${x.remotePath} → ${destWhere}:${joinPath(x.localPath, x.name)}`
          : `${where}:${x.remotePath} → ${t("files.queue.explorer")}`;
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
        <span className="min-w-0 flex-1 truncate text-text" title={flow}>
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
        {x.state === "skipped" && (x.direction === "upload" || (x.direction === "copy" && x.destTunnelId)) && (
          <>
            <button
              onClick={() => again("replace")}
              disabled={pending}
              title={t("files.queue.replaceHint", { path: x.direction === "upload" ? `${where}:${x.remotePath}` : `${destWhere}:${joinPath(x.localPath, x.name)}` })}
              className="shrink-0 rounded px-1.5 text-[11px] text-coral hover:bg-coral/10 disabled:opacity-50"
            >
              {t("files.clash.replace")}
            </button>
            <button
              onClick={() => again("keepBoth")}
              disabled={pending}
              className="shrink-0 rounded px-1.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              {t("files.clash.keepBoth")}
            </button>
          </>
        )}
        {(x.state === "failed" || x.state === "cancelled") && x.direction !== "dragout" && (
          <button
            onClick={() => again(null)}
            disabled={pending}
            title={t("files.queue.retryHint")}
            className="shrink-0 rounded px-1.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            {pending ? t("files.queue.retrying") : t("files.queue.retry")}
          </button>
        )}
        {x.direction === "download" && !x.openWhenDone && (x.state === "done" || x.filesDone > 0) && (
          <button
            onClick={() => void filesReveal(x.id)}
            className="shrink-0 rounded px-1.5 text-[11px] text-accent hover:bg-accent/10"
          >
            {t("files.queue.reveal")}
          </button>
        )}
      </div>
      <div className="ml-5 flex items-center gap-2 text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate font-mono" title={x.error ? `${flow}\n${x.error}` : flow}>
          {flow}
        </span>
        {route && <span className="shrink-0">{route}</span>}
        <span className={`shrink-0 ${tone}`}>{failure && x.state === "failed" ? failure : stateText[x.state]}</span>
      </div>
      {actionError && <p className="ml-5 mt-0.5 text-[10px] text-coral">{actionError}</p>}
      {/* Also after a later fatal error ended the job: what failed before stays readable. */}
      {x.failures.length > 0 && (
        <div className="ml-5 mt-0.5 text-[10px]">
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="rounded text-coral underline-offset-2 hover:underline"
          >
            {open ? t("files.queue.hideFailed") : t("files.queue.showFailed", { count: x.filesFailed })}
          </button>
          {open && (
            <>
              <ul className="mt-0.5 max-h-28 space-y-px overflow-y-auto font-mono text-coral">
                {x.failures.map((f, i) => (
                  <li key={i} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-0.5 flex items-center gap-2 text-muted">
                {x.filesFailed > x.failures.length && (
                  <span>{t("files.queue.firstFailed", { shown: x.failures.length, count: x.filesFailed })}</span>
                )}
                <button onClick={() => void writeText(x.failures.join("\n"))} className="rounded px-1 hover:bg-surface-hover hover:text-text">
                  {t("files.queue.copyFailed")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {x.state === "running" && (
        <div className="ml-5 mt-1 h-1 overflow-hidden rounded bg-border">
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}
