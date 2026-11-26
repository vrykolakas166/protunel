import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../format";
import type { Throughput, TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { UpdateSnapshot } from "../types";

interface Props {
  statuses: Record<string, TunnelRuntimeState>;
  throughput: Record<string, Throughput>;
  updates: UpdateSnapshot | null;
  restarting: boolean;
  onRestart: () => void;
  onOpenAbout: () => void;
}

/** Bytes per second over every connected tunnel, from the last waveform tick. */
export function totalRate(statuses: Record<string, TunnelRuntimeState>, throughput: Record<string, Throughput>) {
  let up = 0;
  let down = 0;
  for (const [id, series] of Object.entries(throughput)) {
    if (statuses[id]?.status !== "connected") continue;
    up += series.up[series.up.length - 1] ?? 0;
    down += series.down[series.down.length - 1] ?? 0;
  }
  return { up, down };
}

const chip = "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text";

/**
 * The main window's status bar (Full mode): live traffic and the version or
 * a pending update. One line, never more; per-tunnel detail
 * stays on the rows. Errors stay in the message bar at the top.
 */
export function MainFooter({ statuses, throughput, updates, restarting, onRestart, onOpenAbout }: Props) {
  const { t } = useTranslation("app");
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const { up, down } = totalRate(statuses, throughput);
  const phase = updates?.phase;
  const percent = Math.round((updates?.progress ?? 0) * 100);

  return (
    <footer data-tour="main-footer" className="@container flex h-7 shrink-0 items-center gap-1 border-t border-border bg-surface px-2 text-[11px] text-muted">
      <span className="flex items-center gap-1.5 px-1.5 font-mono tabular-nums" title={t("footer.trafficHint")}>
        <span aria-hidden="true">↓</span>
        <span className="sr-only">{t("footer.down")}</span>
        {formatBytes(down)}/s
        <span aria-hidden="true" className="ml-1.5">↑</span>
        <span className="sr-only">{t("footer.up")}</span>
        {formatBytes(up)}/s
      </span>


      <span className="ml-auto" />
      {phase === "ready" ? (
        <button onClick={onRestart} disabled={restarting} className={`${chip} font-medium text-accent`}>
          {t("footer.updateReady", { version: updates?.version ?? "" })}
        </button>
      ) : phase === "downloading" ? (
        <button onClick={onOpenAbout} className={chip}>
          {t("footer.updateDownloading", { percent })}
        </button>
      ) : phase === "available" ? (
        <button onClick={onOpenAbout} className={`${chip} text-accent`}>
          {t("footer.updateAvailable", { version: updates?.version ?? "" })}
        </button>
      ) : (
        version && (
          <button onClick={onOpenAbout} className={chip} title={t("footer.aboutHint")}>
            v{version}
          </button>
        )
      )}
    </footer>
  );
}
