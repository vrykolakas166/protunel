import { useState } from "react";
import { applyImport, exportConfig, pickImportFile, previewImport } from "../api";
import type { ImportPreview, ImportResult, ImportSections, TunnelDisposition } from "../types";
import { Modal } from "./Modal";

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const primaryButton =
  "rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50";
const ghostButton =
  "rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50";

const DISPOSITION_LABEL: Record<TunnelDisposition, string> = {
  new: "new",
  overwrite: "updates existing",
  nameConflict: "same name, different tunnel",
};

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
  onClose: () => void;
  onImported: () => void;
}

export function ConfigPanel({ onClose, onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [exportPassphrase, setExportPassphrase] = useState("");

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
      const path = await exportConfig(exportPassphrase);
      if (!path) return;
      setNote(
        exportPassphrase
          ? `Exported to ${path} — secrets included, encrypted.`
          : `Exported to ${path} — no secrets included.`,
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

  const conflicts = preview?.tunnels.filter((t) => t.disposition === "nameConflict") ?? [];

  return (
    <Modal
      title={
        <h2 className="font-display text-base font-semibold text-text">
          Export / import config
        </h2>
      }
      onClose={onClose}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-coral">{error}</p>}
        {note && <p className="text-sm text-accent">{note}</p>}

        <section className="space-y-2 rounded border border-border bg-bg p-3">
          <h3 className="text-sm font-medium text-text">Export</h3>
          <p className="text-xs text-muted">
            Writes tunnels, port forwards, router config and rules, settings, and known
            hosts to one JSON file.
          </p>
          <div>
            <label className={labelClass}>
              Passphrase — leave blank to export without any secrets
            </label>
            <input
              type="password"
              className={inputClass}
              value={exportPassphrase}
              placeholder="(no secrets)"
              disabled={busy}
              onChange={(e) => setExportPassphrase(e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted">
            {exportPassphrase
              ? "SSH passwords and key passphrases will be included, encrypted with this passphrase. There is no way to recover them if you forget it."
              : "SSH passwords and key passphrases stay in the Windows Credential Manager and are not written to the file."}
          </p>
          <button onClick={doExport} disabled={busy} className={primaryButton}>
            Choose file &amp; export
          </button>
        </section>

        <section className="space-y-2 rounded border border-border bg-bg p-3">
          <h3 className="text-sm font-medium text-text">Import</h3>

          {!preview && (
            <>
              <p className="text-xs text-muted">
                Nothing is changed until you confirm on the next screen.
              </p>
              <button onClick={choose} disabled={busy} className={ghostButton}>
                Choose file…
              </button>
            </>
          )}

          {result && (
            <p className="text-xs text-accent">
              Imported: {result.tunnelsAdded} added, {result.tunnelsUpdated} updated,{" "}
              {result.rulesReplaced} router rules, {result.secretsRestored} secrets,{" "}
              {result.knownHostsAdded} known hosts.
            </p>
          )}

          {preview && (
            <div className="space-y-3">
              <p className="font-mono text-[11px] text-muted">
                {importPath}
                <br />
                written by v{preview.appVersion} on{" "}
                {new Date(preview.exportedAt * 1000).toLocaleString()}
              </p>

              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.tunnels}
                    onChange={(e) => setSections({ ...sections, tunnels: e.target.checked })}
                  />
                  Tunnels ({preview.tunnels.length})
                </label>
                {sections.tunnels && preview.tunnels.length > 0 && (
                  <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border bg-surface p-2">
                    {preview.tunnels.map((t) => (
                      <div key={t.id} className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="min-w-0 flex-1 truncate text-text">{t.name}</span>
                        <span className="shrink-0 truncate text-muted">{t.host}</span>
                        <span className={`w-44 shrink-0 ${DISPOSITION_COLOR[t.disposition]}`}>
                          {DISPOSITION_LABEL[t.disposition]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {sections.tunnels && conflicts.length > 0 && (
                  <div className="rounded border border-coral/40 bg-coral/10 p-2 text-[11px] text-text">
                    <p className="mb-1 text-coral">
                      {conflicts.length} imported tunnel(s) share a name with one you already
                      have, but are a different tunnel.
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
                      Replace mine. Unticked, they come in as separate copies named
                      "… (imported)".
                    </label>
                  </div>
                )}

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.router}
                    onChange={(e) => setSections({ ...sections, router: e.target.checked })}
                  />
                  Router config + rules — <span className="text-coral">replaces</span> your{" "}
                  {preview.currentRouterRuleCount} rule(s) with {preview.routerRuleCount}
                </label>

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.settings}
                    onChange={(e) => setSections({ ...sections, settings: e.target.checked })}
                  />
                  Settings
                </label>

                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={sections.knownHosts}
                    onChange={(e) =>
                      setSections({ ...sections, knownHosts: e.target.checked })
                    }
                  />
                  Known hosts ({preview.knownHostCount}) — merged; yours always win
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
                      Secrets{" "}
                      {preview.secretsUnlocked
                        ? `(${preview.secretCount} unlocked)`
                        : "— locked"}
                    </label>
                    {!preview.secretsUnlocked && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="password"
                          className={inputClass}
                          value={importPassphrase}
                          placeholder="passphrase used at export"
                          disabled={busy}
                          onChange={(e) => setImportPassphrase(e.target.value)}
                        />
                        <button
                          onClick={() => reloadPreview(importPassphrase)}
                          disabled={busy || !importPassphrase}
                          className={ghostButton}
                        >
                          Unlock
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {!preview.hasSecrets && (
                  <p className="text-[11px] text-muted">
                    This file contains no secrets — you will need to re-enter passwords and
                    key passphrases for imported tunnels.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button onClick={doImport} disabled={busy} className={primaryButton}>
                  Import
                </button>
                <button
                  onClick={() => {
                    setPreview(null);
                    setImportPath(null);
                  }}
                  disabled={busy}
                  className={ghostButton}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
