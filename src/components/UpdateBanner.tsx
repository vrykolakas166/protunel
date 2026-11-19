import { useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadUpdate } from "../api";
import type { UpdateSnapshot } from "../types";

interface Props {
  updates: UpdateSnapshot | null;
  restarting: boolean;
  onRestart: () => void;
  onWhatsNew: () => void;
}

const SHOWN = ["available", "downloading", "ready"];

/**
 * A floating card under the header while an update is found, downloading or
 * ready. "Later" hides it until the update moves on to its next phase, so a
 * finished download still gets announced.
 */
export function UpdateBanner({ updates, restarting, onRestart, onWhatsNew }: Props) {
  const { t } = useTranslation("app");
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!updates || !SHOWN.includes(updates.phase)) return null;
  const key = `${updates.phase}:${updates.version}`;
  if (dismissed === key) return null;

  const percent = Math.round((updates.progress ?? 0) * 100);
  const version = updates.version ?? "";
  const phase = updates.phase as "available" | "downloading" | "ready";

  const icon = {
    available: (
      <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
    ),
    downloading: (
      <g className="nudge-down">
        <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5" />
      </g>
    ),
    // Sparkle: something new is waiting.
    ready: (
      <path d="M8 1.8l1.4 3.8 3.8 1.4-3.8 1.4L8 12.2 6.6 8.4 2.8 7l3.8-1.4zM12.6 11.2l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    ),
  }[phase];

  return (
    // A floating card, like the tunnel toolbar under it (`TunnelToolbar`).
    <div className="rise-in px-4 pt-3">
      <div className="relative overflow-hidden rounded-xl border border-accent/35 bg-surface shadow-sm">
        <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-accent/18 via-accent/6 to-transparent" aria-hidden="true" />
        <div className="relative flex items-center gap-3 px-3 py-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent shadow-sm">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {icon}
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">{t(`update.${phase}Title`, { version })}</p>
            <p className="truncate text-[11px] text-muted">{t(`update.${phase}Sub`, { percent })}</p>
          </div>
          <button
            onClick={onWhatsNew}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {t("update.whatsNew")}
          </button>
          {phase === "available" && (
            <button
              onClick={() => void downloadUpdate()}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:bg-accent-hover"
            >
              {t("update.download")}
            </button>
          )}
          {phase === "ready" && (
            <button
              onClick={onRestart}
              disabled={restarting}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50"
            >
              {restarting ? t("installing") : t("restartToUpdate")}
            </button>
          )}
          {phase !== "downloading" && (
            <button
              onClick={() => setDismissed(key)}
              title={t("update.later")}
              aria-label={t("update.later")}
              className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-text"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        {phase === "downloading" && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/15">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
