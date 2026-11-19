import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { debugFailTunnel, debugSimulateUpdate } from "../api";
import type { DebugTunnelFailure, Tunnel } from "../types";
import { Group, Row } from "./SettingsPanel";

interface Props {
  tunnels: Tunnel[];
  onShowWhatsNew: () => void;
  /** Clears `settings.uiMode` so the mode question comes back. */
  onAskMode: () => void;
  onError: (text: string) => void;
}

const button =
  "shrink-0 rounded border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-50";

/**
 * Settings › Developer tools: fakes the states that are hard to reach on a
 * development machine (an update to install, a server that rejects the
 * password or changed its key) so their screens can be checked. Backed by
 * `debug_*` commands that refuse to run unless `dev_tools_enabled`.
 */
export function DevToolsPage({ tunnels, onShowWhatsNew, onAskMode, onError }: Props) {
  const { t } = useTranslation("devTools");
  const [next, setNext] = useState("");
  const [tunnelId, setTunnelId] = useState(tunnels[0]?.id ?? "");

  useEffect(() => {
    getVersion().then((v) => {
      const [major, minor, patch] = v.split(".").map(Number);
      setNext(`${major}.${minor}.${patch + 1}`);
    });
  }, []);

  useEffect(() => {
    if (!tunnels.some((tun) => tun.id === tunnelId)) setTunnelId(tunnels[0]?.id ?? "");
  }, [tunnels, tunnelId]);

  const run = (action: () => Promise<unknown>) => () => void action().catch((err) => onError(String(err)));

  const failures: DebugTunnelFailure[] = ["auth", "unreachable", "hostKey"];

  return (
    <>
      <p className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-[11px] text-text">{t("intro")}</p>

      <Group title={t("groups.updates")}>
        <Row
          title={t("updateAvailable")}
          description={t("updateAvailableHint", { next })}
          control={
            <button className={button} onClick={run(() => debugSimulateUpdate("available"))}>
              {t("simulate")}
            </button>
          }
        />
        <Row
          title={t("updateError")}
          description={t("updateErrorHint")}
          control={
            <button className={button} onClick={run(() => debugSimulateUpdate("error"))}>
              {t("simulate")}
            </button>
          }
        />
        <Row
          title={t("updateReset")}
          description={t("updateResetHint")}
          control={
            <button className={button} onClick={run(() => debugSimulateUpdate("reset"))}>
              {t("updateReset")}
            </button>
          }
        />
        <Row
          title={t("whatsNew")}
          description={t("whatsNewHint")}
          control={
            <button className={button} onClick={onShowWhatsNew}>
              {t("show")}
            </button>
          }
        />
      </Group>

      <Group title={t("groups.mode")}>
        <Row
          title={t("askMode")}
          description={t("askModeHint")}
          control={
            <button className={button} onClick={onAskMode}>
              {t("askAgain")}
            </button>
          }
        />
      </Group>

      <Group title={t("groups.failures")}>
        <Row title={t("tunnel")} description={tunnels.length ? t("failuresHint") : t("noTunnels")}>
          {tunnels.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <select
                value={tunnelId}
                onChange={(e) => setTunnelId(e.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
              >
                {tunnels.map((tun) => (
                  <option key={tun.id} value={tun.id}>
                    {tun.name}
                  </option>
                ))}
              </select>
              {failures.map((kind) => (
                <button
                  key={kind}
                  className={button}
                  disabled={!tunnelId}
                  onClick={run(() => debugFailTunnel(tunnelId, kind))}
                >
                  {t(`fail.${kind}`)}
                </button>
              ))}
            </div>
          )}
        </Row>
      </Group>
    </>
  );
}
