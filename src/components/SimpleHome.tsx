import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRouterConfig, listRouterRules, setNetworkAccess } from "../api";
import { hostKeyId } from "../hooks/useHostKeyMismatches";
import type { RouterRuntimeState } from "../hooks/useRouterEvents";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";
import { isWindows } from "../platform";
import { classifyError, routedTunnels } from "../simpleMode";
import type { HostKeyMismatch, RouterConfig, RouterRule, Tunnel } from "../types";
import { CopyLine } from "./CopyLine";
import { openMenu } from "../contextMenu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

interface Props {
  tunnels: Tunnel[];
  statuses: Record<string, TunnelRuntimeState>;
  router: RouterRuntimeState;
  hostKeyMismatches: Record<string, HostKeyMismatch>;
  /** Opens Settings › Backup to import the administrator's file. */
  onImport: () => void;
  onError: (text: string) => void;
}

const DOT: Record<string, string> = {
  disconnected: "bg-slate",
  connecting: "bg-amber",
  reconnecting: "bg-amber",
  connected: "bg-accent",
  error: "bg-coral",
};

/**
 * Simple mode's whole window: one "internal network" switch and a read-only
 * list of the servers it goes through. For people who browse internal sites
 * through tunnels an administrator set up and never need to change them; anything that
 * needs fixing is the administrator's job, so errors say who to ask, not how to fix.
 */
export function SimpleHome({ tunnels, statuses, router, hostKeyMismatches, onImport, onError }: Props) {
  const { t } = useTranslation("simple");
  const [rules, setRules] = useState<RouterRule[]>([]);
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [pending, setPending] = useState(false);

  // Tunnels change on import, which also replaces the rules.
  useEffect(() => {
    listRouterRules().then(setRules).catch(() => {});
    getRouterConfig().then(setConfig).catch(() => {});
  }, [tunnels]);

  const on = router.status === "running";

  const toggle = async () => {
    setPending(true);
    try {
      await setNetworkAccess(!on);
    } catch (err) {
      onError(t("switchFailed", { error: String(err) }));
    } finally {
      setPending(false);
    }
  };

  if (tunnels.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm space-y-3 text-center">
          <p className="font-display text-base font-semibold text-text">{t("empty.title")}</p>
          <p className="text-sm text-muted">{t("empty.body")}</p>
          <button
            onClick={onImport}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            {t("empty.import")}
          </button>
        </div>
      </div>
    );
  }

  // The router serves either way; a failed system proxy only means the
  // browser isn't pointed at it, which is worth saying (`router::start`).
  const proxyProblem = on && isWindows && router.message ? router.message : null;
  const statusLine = pending
    ? on
      ? t("turningOff")
      : t("turningOn")
    : router.status === "error"
      ? t("error", { error: router.message ?? "" })
      : on
        ? proxyProblem
          ? t("onNoProxy", { error: proxyProblem })
          : isWindows
            ? t("on")
            : t("onManual")
        : isWindows
          ? t("off")
          : t("offManual");

  const shown = routedTunnels(tunnels, rules, config);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <section
        className={`rounded-xl border p-4 transition-colors ${
          on ? "border-accent/50 bg-accent/10" : "border-border bg-surface"
        }`}
      >
        <div className="flex items-center gap-4">
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
              on ? "bg-accent text-on-accent" : "bg-bg text-muted"
            }`}
          >
            {/* Globe: "the network", not a particular server. */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>
            <p className={`text-xs ${router.status === "error" || proxyProblem ? "text-coral" : "text-muted"}`}>
              {statusLine}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={on}
            aria-label={t("title")}
            onClick={() => void toggle()}
            disabled={pending}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
              on ? "bg-accent" : "bg-slate/40"
            }`}
          >
            <span
              className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-surface shadow transition-transform ${
                on ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>
        {on && !isWindows && router.port && (
          <div className="mt-3 space-y-1 text-[11px] text-muted">
            <p>{t("pacHint")}</p>
            <CopyLine text={`http://127.0.0.1:${router.port}/protunel.pac`} />
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="px-1 text-xs font-semibold text-text">{t("servers")}</h3>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {shown.map((tunnel) => {
            const runtime = statuses[tunnel.id];
            const status = runtime?.status ?? "disconnected";
            const keyChanged = !!hostKeyMismatches[hostKeyId(tunnel)] && status !== "connected";
            const problem = keyChanged ? "hostKey" : status === "error" ? classifyError(runtime?.message ?? "") : null;
            const text = problem
              ? t(`problem.${problem}`)
              : status === "connected"
                ? t("status.connected")
                : status === "connecting" || status === "reconnecting"
                  ? t("status.connecting")
                  : on
                    ? t("status.standby")
                    : t("status.off");
            return (
              <li
                key={tunnel.id}
                onContextMenu={(e) => {
                  // Only something worth sending to the administrator.
                  if (problem && runtime?.message) {
                    openMenu(e, [
                      {
                        label: t("copyError"),
                        action: () => void writeText(`${tunnel.name} (${tunnel.host}:${tunnel.port}): ${runtime.message}`),
                      },
                    ]);
                  }
                }}
                className="flex items-center gap-3 px-3.5 py-2.5"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${problem ? "bg-coral" : DOT[status]}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{tunnel.name}</span>
                <span
                  // The raw error, for whoever ends up helping.
                  title={problem ? (runtime?.message ?? undefined) : undefined}
                  className={`max-w-[60%] shrink-0 truncate text-right text-[11px] ${problem ? "text-coral" : "text-muted"}`}
                >
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="mt-auto px-1 text-[11px] text-muted">{t("needChanges")}</p>
    </div>
  );
}
