import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { applyImport, exportConfig, pickImportFile, previewImport } from "../api";
import type {
  ExportSections,
  ImportPreview,
  ImportResult,
  ImportSections,
  Tunnel,
  TunnelDisposition,
} from "../types";
import { Modal } from "./Modal";

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const primaryButton =
  "rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
const ghostButton =
  "rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50";

const DISPOSITION_COLOR: Record<TunnelDisposition, string> = {
  new: "text-accent",
  overwrite: "text-amber",
  nameConflict: "text-coral",
};

const DEFAULT_SECTIONS: ImportSections = {
  tunnels: true,
  router: true,
  settings: true,
  knownHosts: true,
  secrets: true,
  overwriteNameConflicts: false,
};

interface Props {
  tunnels: Tunnel[];
  onClose: () => void;
  onImported: () => void;
}

export function ConfigPanel({ tunnels, onClose, onImported }: Props) {
  const { t } = useTranslation("configPanel");
  const { t: tc } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportTunnels, setExportTunnels] = useState(true);
  const [exportTunnelIds, setExportTunnelIds] = useState<Set<string>>(
    () => new Set(tunnels.map((tun) => tun.id)),
  );
  const [exportRouter, setExportRouter] = useState(true);
  const [exportSettings, setExportSettings] = useState(true);
  const [exportKnownHosts, setExportKnownHosts] = useState(true);

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

  const [importPath, setImportPath] = useState<string | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sections, setSections] = useState<ImportSections>(DEFAULT_SECTIONS);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const doExport = () =>
    run(async () => {
      setNote(null);
      const sections: ExportSections = {
        tunnels: exportTunnels,
        tunnelIds: exportTunnels ? Array.from(exportTunnelIds) : [],
        router: exportRouter,
        settings: exportSettings,
        knownHosts: exportKnownHosts,
      };
      const path = await exportConfig(exportPassphrase, sections);
      if (!path) return;
      setNote(
        exportPassphrase
          ? t("export.exportedWithSecrets", { path })
          : t("export.exportedNoSecrets", { path }),
      );
    });

  const choose = () =>
    run(async () => {
      setResult(null);
      setNote(null);
      const path = await pickImportFile();
      if (!path) return;
      setImportPath(path);
      setPreview(await previewImport(path, importPassphrase));
    });

  const reloadPreview = (passphrase: string) =>
    run(async () => {
      if (!importPath) return;
      setPreview(await previewImport(importPath, passphrase));
    });

  const doImport = () =>
    run(async () => {
      if (!importPath) return;
      const outcome = await applyImport(importPath, importPassphrase, sections);
      setResult(outcome);
      setPreview(null);
      setImportPath(null);
      setImportPassphrase("");
      onImported();
    });

  const conflicts = preview?.tunnels.filter((tun) => tun.disposition === "nameConflict") ?? [];
  const missingKeys = preview?.tunnels.filter((tun) => tun.missingKeyPath) ?? [];

  return (
    <Modal
      dismissible={false}
      title={
        <h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>
      }
      onClose={onClose}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-coral">{error}</p>}
        {note && <p className="text-sm text-accent">{note}</p>}

        <section className="space-y-2 rounded border border-border bg-bg p-3">
          <h3 className="text-sm font-medium text-text">{t("export.heading")}</h3>
          <p className="text-xs text-muted">{t("export.description")}</p>

          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={exportTunnels}
                onChange={(e) => setExportTunnels(e.target.checked)}
              />
              {t("export.tunnelsCheckbox", {
                selected: exportTunnelIds.size,
                total: tunnels.length,
              })}
            </label>
            {exportTunnels && tunnels.length > 0 && (
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border bg-surface p-2">
                {tunnels.map((tun) => (
                  <label
                    key={tun.id}
                    className="flex items-center gap-2 font-mono text-[11px] text-text"
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
            )}

            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={exportRouter}
                onChange={(e) => setExportRouter(e.target.checked)}
              />
              {t("export.routerCheckbox")}
            </label>

            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={exportSettings}
                onChange={(e) => setExportSettings(e.target.checked)}
              />
              {t("export.settingsCheckbox")}
            </label>

            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={exportKnownHosts}
                onChange={(e) => setExportKnownHosts(e.target.checked)}
              />
              {t("export.knownHostsCheckbox")}
            </label>
          </div>

          <div>
            <label className={labelClass}>{t("export.passphraseLabel")}</label>
            <input
              type="password"
              className={inputClass}
              value={exportPassphrase}
              placeholder={t("export.passphrasePlaceholder")}
              disabled={busy}
              onChange={(e) => setExportPassphrase(e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted">
            {exportPassphrase
              ? t("export.secretsIncludedNote")
              : t("export.secretsExcludedNote")}
          </p>
          <button onClick={doExport} disabled={busy} className={primaryButton}>
            {t("export.chooseFileAndExport")}
          </button>
        </section>

        <section className="space-y-2 rounded border border-border bg-bg p-3">
          <h3 className="text-sm font-medium text-text">{t("import.heading")}</h3>

          {!preview && (
            <>
              <p className="text-xs text-muted">{t("import.hint")}</p>
              <button onClick={choose} disabled={busy} className={ghostButton}>
                {t("import.chooseFile")}
              </button>
            </>
          )}

          {result && (
            <p className="text-xs text-accent">
              {t("import.summary", {
                added: result.tunnelsAdded,
                updated: result.tunnelsUpdated,
                rules: result.rulesReplaced,
                secrets: result.secretsRestored,
                hosts: result.knownHostsAdded,
              })}
            </p>
          )}

          {preview && (
            <div className="space-y-3">
              <p className="font-mono text-[11px] text-muted">
                {importPath}
                <br />
                {t("import.writtenBy", {
                  version: preview.appVersion,
                  date: new Date(preview.exportedAt * 1000).toLocaleString(),
                })}
              </p>

              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.tunnels}
                    onChange={(e) => setSections({ ...sections, tunnels: e.target.checked })}
                  />
                  {t("import.tunnelsCheckbox", { count: preview.tunnels.length })}
                </label>
                {sections.tunnels && preview.tunnels.length > 0 && (
                  <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border bg-surface p-2">
                    {preview.tunnels.map((tun) => (
                      <div key={tun.id} className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="min-w-0 flex-1 truncate text-text">{tun.name}</span>
                        <span className="shrink-0 truncate text-muted">{tun.host}</span>
                        <span className={`w-44 shrink-0 ${DISPOSITION_COLOR[tun.disposition]}`}>
                          {t(`disposition.${tun.disposition}`)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {sections.tunnels && missingKeys.length > 0 && (
                  <div className="rounded border border-coral/40 bg-coral/10 p-2 text-[11px] text-text">
                    <p className="mb-1 text-coral">
                      {t("import.missingKeysWarning", { count: missingKeys.length })}
                    </p>
                    <ul className="space-y-0.5 font-mono">
                      {missingKeys.map((tun) => (
                        <li key={tun.id} className="truncate">
                          {tun.name}: <span className="text-muted">{tun.missingKeyPath}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {sections.tunnels && conflicts.length > 0 && (
                  <div className="rounded border border-coral/40 bg-coral/10 p-2 text-[11px] text-text">
                    <p className="mb-1 text-coral">
                      {t("import.conflictWarning", { count: conflicts.length })}
                    </p>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={sections.overwriteNameConflicts}
                        onChange={(e) =>
                          setSections({
                            ...sections,
                            overwriteNameConflicts: e.target.checked,
                          })
                        }
                      />
                      {t("import.conflictReplace")}
                    </label>
                  </div>
                )}

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.router}
                    onChange={(e) => setSections({ ...sections, router: e.target.checked })}
                  />
                  <Trans
                    t={t}
                    i18nKey="import.routerCheckbox"
                    values={{
                      current: preview.currentRouterRuleCount,
                      incoming: preview.routerRuleCount,
                    }}
                    components={{ replaces: <span className="text-coral" /> }}
                  />
                </label>

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.settings}
                    onChange={(e) => setSections({ ...sections, settings: e.target.checked })}
                  />
                  {t("import.settingsCheckbox")}
                </label>

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.knownHosts}
                    onChange={(e) =>
                      setSections({ ...sections, knownHosts: e.target.checked })
                    }
                  />
                  {t("import.knownHostsCheckbox", { count: preview.knownHostCount })}
                </label>

                {preview.hasSecrets && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 text-sm text-text">
                      <input
                        type="checkbox"
                        checked={sections.secrets}
                        disabled={!preview.secretsUnlocked}
                        onChange={(e) =>
                          setSections({ ...sections, secrets: e.target.checked })
                        }
                      />
                      {preview.secretsUnlocked
                        ? t("import.secretsUnlocked", { count: preview.secretCount })
                        : t("import.secretsLocked")}
                    </label>
                    {!preview.secretsUnlocked && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="password"
                          className={inputClass}
                          value={importPassphrase}
                          placeholder={t("import.passphrasePlaceholder")}
                          disabled={busy}
                          onChange={(e) => setImportPassphrase(e.target.value)}
                        />
                        <button
                          onClick={() => reloadPreview(importPassphrase)}
                          disabled={busy || !importPassphrase}
                          className={ghostButton}
                        >
                          {t("import.unlock")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {!preview.hasSecrets && (
                  <p className="text-[11px] text-muted">{t("import.noSecretsNote")}</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button onClick={doImport} disabled={busy} className={primaryButton}>
                  {t("import.importButton")}
                </button>
                <button
                  onClick={() => {
                    setPreview(null);
                    setImportPath(null);
                  }}
                  disabled={busy}
                  className={ghostButton}
                >
                  {tc("cancel")}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
