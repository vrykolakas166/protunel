// The export screen: what to put in the file, and an optional passphrase that
// seals passwords into it.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { exportConfig } from "../../api";
import type { ExportSections, Tunnel } from "../../types";
import { primaryButton, OptionCard, PasswordInput, SectionLabel, UploadIcon, ServerIcon, RouteIcon, SlidersIcon, ShieldIcon, LockIcon, CheckIcon } from "./parts";

interface Props {
  tunnels: Tunnel[];
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}

export function ExportView({ tunnels, busy, run }: Props) {
  const { t } = useTranslation("configPanel");
  // ── Export ────────────────────────────────────────────────────────────────
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportTunnels, setExportTunnels] = useState(true);
  const [exportTunnelIds, setExportTunnelIds] = useState<Set<string>>(
    () => new Set(tunnels.map((tun) => tun.id)),
  );
  const [exportRouter, setExportRouter] = useState(true);
  const [exportSettings, setExportSettings] = useState(true);
  const [exportKnownHosts, setExportKnownHosts] = useState(true);
  /** Hand-off to someone who only browses: the file opens Simple mode. */
  const [exportSimple, setExportSimple] = useState(false);
  const [exported, setExported] = useState<{ path: string; withSecrets: boolean } | null>(null);

  // New tunnels created after the panel opened should default to included.
  useEffect(() => {
    setExportTunnelIds((current) => {
      const next = new Set(current);
      for (const tun of tunnels) next.add(tun.id);
      for (const id of next) if (!tunnels.some((tun) => tun.id === id)) next.delete(id);
      return next;
    });
  }, [tunnels]);

  const toggleExportTunnel = (id: string) => {
    setExportTunnelIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };


  const doExport = () =>
    run(async () => {
      setExported(null);
      const sections: ExportSections = {
        tunnels: exportTunnels,
        tunnelIds: exportTunnels ? Array.from(exportTunnelIds) : [],
        router: exportRouter,
        settings: exportSettings,
        knownHosts: exportKnownHosts,
        simpleMode: exportSimple,
      };
      const path = await exportConfig(exportPassphrase, sections);
      if (path) setExported({ path, withSecrets: !!exportPassphrase });
    });

  const exportAnything = (exportTunnels && exportTunnelIds.size > 0) || exportRouter || exportSettings || exportKnownHosts;

  return (
        <div className="flex flex-col gap-4">
          <div>
            <SectionLabel>{t("export.whatLabel")}</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              <OptionCard
                checked={exportTunnels}
                onChange={setExportTunnels}
                icon={<ServerIcon />}
                title={t("export.tunnels")}
                detail={t("export.tunnelsDetail", {
                  selected: exportTunnelIds.size,
                  total: tunnels.length,
                })}
              />
              <OptionCard
                checked={exportRouter}
                onChange={setExportRouter}
                icon={<RouteIcon />}
                title={t("export.router")}
                detail={t("export.routerDetail")}
              />
              <OptionCard
                checked={exportSettings}
                onChange={setExportSettings}
                icon={<SlidersIcon />}
                title={t("export.settings")}
                detail={t("export.settingsDetail")}
              />
              <OptionCard
                checked={exportKnownHosts}
                onChange={setExportKnownHosts}
                icon={<ShieldIcon />}
                title={t("export.knownHosts")}
                detail={t("export.knownHostsDetail")}
              />
              <div className="col-span-2">
                <OptionCard
                  checked={exportSimple}
                  onChange={setExportSimple}
                  icon={<SlidersIcon />}
                  title={t("export.simpleMode")}
                  detail={t("export.simpleModeDetail")}
                />
              </div>
            </div>

            {exportTunnels && tunnels.length > 0 && (
              <div className="mt-2 rounded-lg border border-border bg-surface">
                <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5 text-[11px] text-muted">
                  <span>{t("export.pickTunnels")}</span>
                  <span className="flex gap-2">
                    <button
                      className="hover:text-accent"
                      onClick={() => setExportTunnelIds(new Set(tunnels.map((tun) => tun.id)))}
                    >
                      {t("export.selectAll")}
                    </button>
                    <span>·</span>
                    <button className="hover:text-accent" onClick={() => setExportTunnelIds(new Set())}>
                      {t("export.selectNone")}
                    </button>
                  </span>
                </div>
                <div className="max-h-36 space-y-0.5 overflow-y-auto p-2">
                  {tunnels.map((tun) => (
                    <label
                      key={tun.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 font-mono text-[11px] text-text hover:bg-surface-hover"
                    >
                      <input
                        type="checkbox"
                        checked={exportTunnelIds.has(tun.id)}
                        onChange={() => toggleExportTunnel(tun.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">{tun.name}</span>
                      <span className="shrink-0 truncate text-muted">{tun.host}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div>
            <SectionLabel>{t("export.secretsLabel")}</SectionLabel>
            <div
              className={`space-y-2 rounded-lg border p-3 ${
                exportPassphrase ? "border-accent/50 bg-accent/5" : "border-border bg-bg"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span className={exportPassphrase ? "text-accent" : "text-muted"}>
                  <LockIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">
                    {exportPassphrase ? t("export.secretsOn") : t("export.secretsOff")}
                  </p>
                  <p className="text-[11px] text-muted">
                    {exportPassphrase
                      ? t("export.secretsOnNote")
                      : t("export.secretsOffNote")}
                  </p>
                </div>
              </div>
              <PasswordInput
                value={exportPassphrase}
                onChange={setExportPassphrase}
                placeholder={t("export.passphrasePlaceholder")}
                disabled={busy}
              />
            </div>
          </div>

          {exported && (
            <div className="flex items-start gap-2.5 rounded-lg border border-accent/50 bg-accent/10 p-3">
              <span className="text-accent">
                <CheckIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">
                  {exported.withSecrets ? t("export.doneWithSecrets") : t("export.doneNoSecrets")}
                </p>
                <p className="break-all font-mono text-[11px] text-muted">{exported.path}</p>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button onClick={doExport} disabled={busy || !exportAnything} className={primaryButton}>
              <UploadIcon size={14} />
              {t("export.button")}
            </button>
          </div>
        </div>
  );
}
