// The import screen: a preview of what the chosen file would change, the
// sections to take, and the passphrase for sealed passwords.

import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { applyImport } from "../../api";
import type { ImportPreview, ImportResult } from "../../types";
import { formatTimestamp } from "../../format";
import { primaryButton, ghostButton, DISPOSITION_COLOR, type ImportToggles, DEFAULT_IMPORT_TOGGLES, isPassphraseError, basename, OptionCard, PasswordInput, SectionLabel, Callout, DownloadIcon, ServerIcon, RouteIcon, SlidersIcon, ShieldIcon, LockIcon, FileIcon } from "./parts";

interface Props {
  importPath: string;
  preview: ImportPreview;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onImported: (result: ImportResult) => void;
  /** Picks another file (the parent re-mounts this view with its preview). */
  onChangeFile: () => void;
  onCancel: () => void;
}

export function ImportView({ importPath, preview, busy, setBusy, setError, onImported, onChangeFile, onCancel }: Props) {
  const { t } = useTranslation("configPanel");
  const [toggles, setToggles] = useState<ImportToggles>({ ...DEFAULT_IMPORT_TOGGLES, uiMode: preview.uiMode !== null });
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [skipSecrets, setSkipSecrets] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);

  const secretsStepActive = !!preview?.hasSecrets && toggles.tunnels;
  const restoreSecrets = secretsStepActive && !skipSecrets;
  const anyImportSection = Object.values(toggles).some(Boolean);
  // A file with secrets needs either the passphrase or an explicit "skip" —
  // never a silent fallthrough to "imported without passwords".
  const canImport =
    anyImportSection && (!restoreSecrets || importPassphrase.length > 0) && !busy;

  const doImport = async () => {
    if (!importPath || !canImport) return;
    setBusy(true);
    setError(null);
    setPassphraseError(null);
    try {
      const outcome = await applyImport(importPath, restoreSecrets ? importPassphrase : undefined, {
        ...toggles,
        secrets: restoreSecrets,
        overwriteNameConflicts: overwriteConflicts,
      });
      setImportPassphrase("");
      onImported(outcome);
    } catch (err) {
      const message = String(err);
      if (restoreSecrets && isPassphraseError(message)) {
        setPassphraseError(t("import.secrets.wrong"));
        requestAnimationFrame(() => passphraseRef.current?.select());
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };


  const conflicts = preview?.tunnels.filter((tun) => tun.disposition === "nameConflict") ?? [];
  const missingKeys = preview?.tunnels.filter((tun) => tun.missingKeyPath) ?? [];

  return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
            <span className="text-amber">
              <FileIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text" title={importPath}>
                {basename(importPath)}
              </p>
              <p className="text-[11px] text-muted">
                {t("import.writtenBy", {
                  version: preview.appVersion,
                  date: formatTimestamp(preview.exportedAt),
                })}
              </p>
            </div>
            <button onClick={onChangeFile} disabled={busy} className={ghostButton}>
              {t("import.changeFile")}
            </button>
          </div>

          <div>
            <SectionLabel>{t("import.whatLabel")}</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              <OptionCard
                checked={toggles.tunnels}
                onChange={(v) => setToggles({ ...toggles, tunnels: v })}
                icon={<ServerIcon />}
                title={t("import.tunnels")}
                detail={t("import.tunnelsDetail", { count: preview.tunnels.length })}
              />
              <OptionCard
                checked={toggles.router}
                onChange={(v) => setToggles({ ...toggles, router: v })}
                icon={<RouteIcon />}
                title={t("import.router")}
                detail={
                  <Trans
                    t={t}
                    i18nKey="import.routerDetail"
                    values={{
                      current: preview.currentRouterRuleCount,
                      incoming: preview.routerRuleCount,
                    }}
                    components={{ replaces: <span className="text-coral" /> }}
                  />
                }
              />
              <OptionCard
                checked={toggles.settings}
                onChange={(v) => setToggles({ ...toggles, settings: v })}
                icon={<SlidersIcon />}
                title={t("import.settings")}
                detail={t("import.settingsDetail")}
              />
              <OptionCard
                checked={toggles.knownHosts}
                onChange={(v) => setToggles({ ...toggles, knownHosts: v })}
                icon={<ShieldIcon />}
                title={t("import.knownHosts")}
                detail={t("import.knownHostsDetail", { count: preview.knownHostCount })}
              />
              {preview.uiMode === "simple" && (
                <div className="col-span-2">
                  <OptionCard
                    checked={toggles.uiMode}
                    onChange={(v) => setToggles({ ...toggles, uiMode: v })}
                    icon={<SlidersIcon />}
                    title={t("import.simpleMode")}
                    detail={t("import.simpleModeDetail")}
                  />
                </div>
              )}
            </div>

            {toggles.tunnels && preview.tunnels.length > 0 && (
              <div className="mt-2 max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                {preview.tunnels.map((tun) => (
                  <div key={tun.id} className="flex items-center gap-2 px-1 font-mono text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-text">{tun.name}</span>
                    <span className="shrink-0 truncate text-muted">{tun.host}</span>
                    <span className={`w-44 shrink-0 text-right ${DISPOSITION_COLOR[tun.disposition]}`}>
                      {t(`disposition.${tun.disposition}`)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {toggles.tunnels && missingKeys.length > 0 && (
            <Callout tone="coral">
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
            </Callout>
          )}

          {toggles.tunnels && conflicts.length > 0 && (
            <Callout tone="coral">
              <p className="mb-1 text-coral">
                {t("import.conflictWarning", { count: conflicts.length })}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={overwriteConflicts}
                  onChange={(e) => setOverwriteConflicts(e.target.checked)}
                />
                {t("import.conflictReplace")}
              </label>
            </Callout>
          )}

          {secretsStepActive && (
            <div
              className={`space-y-2.5 rounded-lg border-2 p-3 ${
                passphraseError
                  ? "border-coral bg-coral/5"
                  : skipSecrets
                    ? "border-border bg-bg"
                    : "border-amber bg-amber/10"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span className={skipSecrets ? "text-muted" : "text-amber"}>
                  <LockIcon size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text">{t("import.secrets.title")}</p>
                  <p className="text-xs text-muted">{t("import.secrets.description")}</p>
                </div>
              </div>
              <div>
                <PasswordInput
                  inputRef={passphraseRef}
                  value={importPassphrase}
                  onChange={(v) => {
                    setImportPassphrase(v);
                    setPassphraseError(null);
                  }}
                  onEnter={doImport}
                  placeholder={t("import.secrets.placeholder")}
                  disabled={busy || skipSecrets}
                  invalid={!!passphraseError}
                  autoFocus
                />
                {passphraseError && (
                  <p className="mt-1 text-xs text-coral">{passphraseError}</p>
                )}
              </div>
              <label className="flex items-start gap-2 text-xs text-text">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={skipSecrets}
                  onChange={(e) => {
                    setSkipSecrets(e.target.checked);
                    setPassphraseError(null);
                    if (!e.target.checked) requestAnimationFrame(() => passphraseRef.current?.focus());
                  }}
                />
                <span>{t("import.secrets.skip")}</span>
              </label>
            </div>
          )}

          {toggles.tunnels && !preview.hasSecrets && preview.tunnels.length > 0 && (
            <Callout tone="muted">{t("import.noSecretsNote")}</Callout>
          )}

          <div className="flex items-center justify-end gap-3">
            {restoreSecrets && !importPassphrase && (
              <span className="text-xs text-amber">{t("import.needPassphrase")}</span>
            )}
            <button onClick={onCancel} disabled={busy} className={ghostButton}>
              {t("import.cancel")}
            </button>
            <button onClick={doImport} disabled={!canImport} className={primaryButton}>
              <DownloadIcon size={14} />
              {busy
                ? t("import.importing")
                : restoreSecrets
                  ? t("import.buttonWithSecrets")
                  : secretsStepActive
                    ? t("import.buttonWithoutSecrets")
                    : t("import.button")}
            </button>
          </div>
        </div>
  );
}
