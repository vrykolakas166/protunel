import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
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
import { formatTimestamp } from "../format";

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none disabled:opacity-50";
const primaryButton =
  "inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
const ghostButton =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50";

const DISPOSITION_COLOR: Record<TunnelDisposition, string> = {
  new: "text-accent",
  overwrite: "text-amber",
  nameConflict: "text-coral",
};

type View = "hub" | "export" | "import" | "imported";

type ImportToggles = Omit<ImportSections, "secrets" | "overwriteNameConflicts">;

const DEFAULT_IMPORT_TOGGLES: ImportToggles = {
  tunnels: true,
  router: true,
  settings: true,
  knownHosts: true,
  uiMode: false,
};

/** Errors from `apply_import` that belong next to the passphrase field. */
const isPassphraseError = (err: string) =>
  err.includes("wrong passphrase") || err.includes("passphrase required");

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

interface Props {
  tunnels: Tunnel[];
  onImported: () => void;
  /**
   * Whether the flow is past its hub (an export or import in progress).
   * The host keeps a stray click from closing it then: typed passphrases
   * would be lost.
   */
  onBusyChange?: (inFlow: boolean) => void;
}

/**
 * Export / import, rendered inline (the Settings "Backup" page): a hub with
 * the two actions, then each flow in place with a back button.
 */
export function ConfigFlow({ tunnels, onImported, onBusyChange }: Props) {
  const { t } = useTranslation("configPanel");
  const [view, setView] = useState<View>("hub");
  useEffect(() => {
    onBusyChange?.(view === "export" || view === "import");
  }, [view, onBusyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // ── Import ────────────────────────────────────────────────────────────────
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [toggles, setToggles] = useState<ImportToggles>(DEFAULT_IMPORT_TOGGLES);
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [skipSecrets, setSkipSecrets] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);

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

  const goHub = () => {
    setView("hub");
    setError(null);
    setExported(null);
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

  // The Import tile goes straight to the file dialog: picking a file is the
  // only thing that screen could ask for first.
  const chooseImportFile = () =>
    run(async () => {
      const path = await pickImportFile();
      if (!path) return;
      const next = await previewImport(path);
      setImportPath(path);
      setPreview(next);
      setToggles({ ...DEFAULT_IMPORT_TOGGLES, uiMode: next.uiMode !== null });
      setOverwriteConflicts(false);
      setImportPassphrase("");
      setSkipSecrets(false);
      setPassphraseError(null);
      setView("import");
    });

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
      setResult(outcome);
      setImportPassphrase("");
      setView("imported");
      onImported();
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
  const exportAnything = (exportTunnels && exportTunnelIds.size > 0) || exportRouter || exportSettings || exportKnownHosts;

  const titleText =
    view === "export"
      ? t("export.heading")
      : view === "import"
        ? t("import.heading")
        : view === "imported"
          ? t("result.heading")
          : null;

  return (
    <div className="flex flex-col gap-4">
      {titleText && (
        <div className="-mt-1 flex items-center gap-2">
          <button
            onClick={goHub}
            disabled={busy}
            className="rounded p-1 text-muted hover:bg-surface-hover hover:text-text disabled:opacity-50"
            aria-label={t("back")}
            title={t("back")}
          >
            <Icon size={16}>
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </Icon>
          </button>
          <h3 className="font-display text-sm font-semibold text-text">{titleText}</h3>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded border border-coral/40 bg-coral/10 p-2 text-sm text-coral">
          <AlertIcon />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {view === "hub" && (
        <div className="grid grid-cols-2 gap-3">
          <HubTile
            tone="accent"
            icon={<UploadIcon />}
            title={t("hub.exportTitle")}
            description={t("hub.exportDescription")}
            disabled={busy}
            onClick={() => {
              setError(null);
              setExported(null);
              setView("export");
            }}
          />
          <HubTile
            tone="amber"
            icon={<DownloadIcon />}
            title={t("hub.importTitle")}
            description={t("hub.importDescription")}
            disabled={busy}
            onClick={chooseImportFile}
          />
        </div>
      )}

      {view === "export" && (
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
      )}

      {view === "import" && preview && importPath && (
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
            <button onClick={chooseImportFile} disabled={busy} className={ghostButton}>
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
            <button onClick={goHub} disabled={busy} className={ghostButton}>
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
      )}

      {view === "imported" && result && (
        <div className="flex flex-col items-center gap-4 py-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
            <CheckIcon size={24} />
          </span>
          <p className="text-sm font-medium text-text">{t("result.done")}</p>
          <div className="grid w-full grid-cols-5 gap-2">
            <Stat value={result.tunnelsAdded} label={t("result.added")} />
            <Stat value={result.tunnelsUpdated} label={t("result.updated")} />
            <Stat value={result.rulesReplaced} label={t("result.rules")} />
            <Stat value={result.secretsRestored} label={t("result.secrets")} />
            <Stat value={result.knownHostsAdded} label={t("result.hosts")} />
          </div>
          {result.secretsRestored === 0 && result.tunnelsAdded + result.tunnelsUpdated > 0 && (
            <div className="w-full">
              <Callout tone="amber">{t("result.noSecretsReminder")}</Callout>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={goHub} className={primaryButton}>
              {t("result.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Building blocks ─────────────────────────────────────────────────────────

const TILE_TONE = {
  accent: { ring: "hover:border-accent", badge: "bg-accent/15 text-accent" },
  amber: { ring: "hover:border-amber", badge: "bg-amber/15 text-amber" },
} as const;

function HubTile({
  tone,
  icon,
  title,
  description,
  disabled,
  onClick,
}: {
  tone: keyof typeof TILE_TONE;
  icon: ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const style = TILE_TONE[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group flex flex-col items-center gap-3 rounded-xl border-2 border-border bg-bg px-4 py-7 text-center transition-all hover:-translate-y-0.5 hover:bg-surface-hover hover:shadow-lg disabled:pointer-events-none disabled:opacity-50 ${style.ring}`}
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-transform group-hover:scale-110 ${style.badge}`}
      >
        {icon}
      </span>
      <span className="font-display text-base font-semibold text-text">{title}</span>
      <span className="text-xs text-muted">{description}</span>
    </button>
  );
}

function OptionCard({
  checked,
  onChange,
  icon,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${
        checked ? "border-accent/60 bg-accent/10" : "border-border bg-bg hover:bg-surface-hover"
      }`}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={`mt-0.5 ${checked ? "text-accent" : "text-muted"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium ${checked ? "text-text" : "text-muted"}`}>
          {title}
        </span>
        <span className="block text-[11px] text-muted">{detail}</span>
      </span>
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent text-on-accent" : "border-border"
        }`}
      >
        {checked && <CheckIcon size={11} />}
      </span>
    </label>
  );
}

function PasswordInput({
  value,
  onChange,
  onEnter,
  placeholder,
  disabled,
  invalid,
  autoFocus,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const { t } = useTranslation("configPanel");
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type={shown ? "text" : "password"}
        className={`${inputClass} pr-8 ${invalid ? "border-coral" : ""}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 right-0 flex items-center px-2 text-muted hover:text-text"
        aria-label={shown ? t("hidePassphrase") : t("showPassphrase")}
        title={shown ? t("hidePassphrase") : t("showPassphrase")}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</p>
  );
}

const CALLOUT_TONE = {
  coral: "border-coral/40 bg-coral/10",
  amber: "border-amber/50 bg-amber/10",
  muted: "border-border bg-surface",
} as const;

function Callout({ tone, children }: { tone: keyof typeof CALLOUT_TONE; children: ReactNode }) {
  return (
    <div className={`rounded-lg border p-2.5 text-[11px] text-text ${CALLOUT_TONE[tone]}`}>
      {children}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-bg px-1 py-2.5">
      <span className={`font-display text-xl font-semibold ${value > 0 ? "text-accent" : "text-muted"}`}>
        {value}
      </span>
      <span className="text-center text-[10px] text-muted">{label}</span>
    </div>
  );
}

// ── Icons (24-unit stroke icons, sized by `size`) ───────────────────────────

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

const UploadIcon = ({ size = 28 }: IconProps) => (
  <Icon size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Icon>
);
const DownloadIcon = ({ size = 28 }: IconProps) => (
  <Icon size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Icon>
);
const ServerIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  </Icon>
);
const RouteIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <circle cx="6" cy="19" r="3" />
    <circle cx="18" cy="5" r="3" />
    <path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-8a3.5 3.5 0 0 1 0-7H12" />
  </Icon>
);
const SlidersIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
);
const ShieldIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);
const LockIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Icon>
);
const CheckIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);
const FileIcon = ({ size = 22 }: IconProps) => (
  <Icon size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Icon>
);
const EyeIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
const EyeOffIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22" />
  </Icon>
);
const AlertIcon = () => (
  <span className="mt-0.5 shrink-0">
    <Icon size={14}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
    </Icon>
  </span>
);
