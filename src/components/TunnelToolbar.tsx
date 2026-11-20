import { useTranslation } from "react-i18next";

interface Props {
  /** Every tunnel (the bulk actions ignore the search filter). */
  total: number;
  /** Of those, how many are up. */
  connected: number;
  /** And how many are on their way up (connecting or reconnecting). */
  connecting: number;
  searching: boolean;
  onConnectAll: () => void;
  onDisconnectAll: () => void;
  onSearch: () => void;
  onAdd: () => void;
}

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/**
 * The row above the tunnel list: how many are up, the two bulk actions as
 * one quiet pair (disconnect only turns coral on hover — it's not the thing
 * to reach for), search, and the one primary action, Add.
 */
export function TunnelToolbar({ total, connected, connecting, searching, onConnectAll, onDisconnectAll, onSearch, onAdd }: Props) {
  const { t } = useTranslation("app");
  const live = connected + connecting;
  const fraction = total ? connected / total : 0;

  const pairButton =
    "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";

  return (
    // A floating card, matching the update card above it (`UpdateBanner`).
    <div className="px-4 pt-3">
      <div data-tour="bulk" className="flex items-center gap-2 rounded-xl border border-border bg-surface p-2 shadow-sm">
        {/* A ring that fills as tunnels come up; the count says only what is up. */}
        <span
          title={t("toolbar.connectedHint")}
          className="flex items-center gap-2 rounded-full border border-border bg-bg py-1 pl-1 pr-2.5 text-xs text-muted"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" className="-rotate-90" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" fill="none" strokeWidth="2.5" className="stroke-border" />
            <circle
              cx="10"
              cy="10"
              r="7.5"
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="stroke-accent transition-[stroke-dasharray] duration-500"
              strokeDasharray={`${fraction * 47.1} 47.1`}
            />
          </svg>
          <span>
            <span className="font-mono font-semibold text-text">{connected}</span>
            <span className="font-mono">/{total}</span> {t("toolbar.connected")}
            {connecting > 0 && (
              <span className="text-amber">
                {" · "}
                <span className="font-mono font-semibold">{connecting}</span> {t("toolbar.connecting")}
              </span>
            )}
          </span>
        </span>

        <div className="flex overflow-hidden rounded-lg border border-border bg-bg">
          <button
            onClick={onConnectAll}
            disabled={total === 0 || live === total}
            title={t("connectAllMessage")}
            className={`${pairButton} text-text hover:bg-accent/12 hover:text-accent`}
          >
            <svg {...iconProps}>
              <path d="M5 3.5v9l7-4.5z" />
            </svg>
            {t("connectAll")}
          </button>
          <span className="w-px bg-border" aria-hidden="true" />
          <button
            onClick={onDisconnectAll}
            disabled={live === 0}
            title={t("disconnectAllMessage")}
            className={`${pairButton} text-muted hover:bg-coral/12 hover:text-coral`}
          >
            <svg {...iconProps}>
              <rect x="4" y="4" width="8" height="8" rx="1.2" />
            </svg>
            {t("disconnectAll")}
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onSearch}
            title={t("toolbar.search")}
            aria-label={t("toolbar.search")}
            aria-pressed={searching}
            className={`rounded-lg p-2 transition-colors ${
              searching ? "bg-accent/12 text-accent" : "text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <svg {...iconProps} width={14} height={14}>
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.2 10.2L13.5 13.5" />
            </svg>
          </button>
          <button
            onClick={onAdd}
            data-tour="add"
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent shadow-sm transition-all hover:-translate-y-px hover:bg-accent-hover hover:shadow-md"
          >
            <svg {...iconProps} width={14} height={14} strokeWidth={2}>
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("addTunnel")}
          </button>
        </div>
      </div>
    </div>
  );
}
