import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Tunnel } from "../../types";

export const iconButton = "rounded p-1 text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40";

/** Header: who this is (big, so a host is never mistaken), drag to move. */
export function PanelHeader({
  titleId,
  where,
  tunnel,
  target,
  maximized,
  onPointerDown,
  onToggleMaximize,
  onPositionMenu,
  onFocusShell,
  onCloseClick,
}: {
  titleId: string;
  where: string;
  tunnel: Tunnel;
  target: string;
  maximized: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onToggleMaximize: () => void;
  onPositionMenu: (e: ReactMouseEvent) => void;
  onFocusShell: () => void;
  onCloseClick: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) onToggleMaximize();
      }}
      className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border bg-bg/60 px-2.5 py-1.5 active:cursor-grabbing"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0 text-accent" aria-hidden="true">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" strokeLinejoin="round" />
      </svg>
      <h2 id={titleId} className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-text" title={`${tunnel.name} · ${target}`}>
        {where}
        <span className="ml-2 font-sans text-[11px] font-normal text-muted">{tunnel.name}</span>
      </h2>
      <button onClick={onPositionMenu} disabled={maximized} className={iconButton} title={t("files.pos.menu")} aria-label={t("files.pos.menu")} aria-haspopup="menu">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <rect x="8.5" y="8.5" width="4" height="4" rx="0.5" fill="currentColor" />
        </svg>
      </button>
      <button
        onClick={onToggleMaximize}
        className={iconButton}
        title={maximized ? t("files.restore") : t("files.maximize")}
        aria-label={maximized ? t("files.restore") : t("files.maximize")}
        aria-pressed={maximized}
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="2.5" y="5" width="8.5" height="8.5" rx="1" />
            <path d="M5.5 5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H11" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
          </svg>
        )}
      </button>
      <button onClick={onFocusShell} className={iconButton} title={t("files.focusShell")} aria-label={t("files.focusShell")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5l3.5 3.5L3 11.5M8 12h5" />
        </svg>
      </button>
      <button onClick={onCloseClick} className={iconButton} title={t("files.close")} aria-label={t("files.close")}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
