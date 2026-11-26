import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickImportFile, previewImport, winscpCancel, winscpPreview } from "../api";
import type { ImportPreview, ImportResult, Tunnel, WinscpOutcome, WinscpPreview } from "../types";
import { WinscpDoneView, WinscpView } from "./config/WinscpView";
import { ExportView } from "./config/ExportView";
import { ImportedView } from "./config/ImportedView";
import { ImportView } from "./config/ImportView";
import { AlertIcon, DownloadIcon, HubTile, Icon, UploadIcon } from "./config/parts";

type View = "hub" | "export" | "import" | "imported" | "winscp" | "winscpDone";

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
    onBusyChange?.(view === "export" || view === "import" || view === "winscp");
  }, [view, onBusyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The file being imported and what it would change. */
  const [chosen, setChosen] = useState<{ path: string; preview: ImportPreview; pick: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [winscp, setWinscp] = useState<WinscpPreview | null>(null);
  const [winscpDone, setWinscpDone] = useState<WinscpOutcome | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      const text = String(err);
      setError(text === "not-a-config" ? t("import.notConfig") : text);
    } finally {
      setBusy(false);
    }
  };

  const goHub = () => {
    // The parse Rust kept for the preview is dropped with it.
    if (winscp) void winscpCancel(winscp.token).catch(() => {});
    setWinscp(null);
    setView("hub");
    setError(null);
  };

  const chooseWinscpFile = () =>
    run(async () => {
      try {
        const preview = await winscpPreview();
        if (!preview) return;
        setWinscp(preview);
        setView("winscp");
      } catch (err) {
        const text = String(err);
        // `run` shows what is thrown as is: a plain string, no "Error:" prefix.
        throw text === "master-password"
          ? t("winscp.masterPassword")
          : text === "no-sessions"
            ? t("winscp.noSessions")
            : text;
      }
    });

  // The Import tile goes straight to the file dialog: picking a file is the
  // only thing that screen could ask for first.
  const chooseImportFile = () =>
    run(async () => {
      const path = await pickImportFile();
      if (!path) return;
      const preview = await previewImport(path);
      setChosen((prev) => ({ path, preview, pick: (prev?.pick ?? 0) + 1 }));
      setView("import");
    });

  const titleText =
    view === "export"
      ? t("export.heading")
      : view === "import"
        ? t("import.heading")
        : view === "imported"
          ? t("result.heading")
          : view === "winscp"
            ? t("winscp.heading")
            : view === "winscpDone"
              ? t("winscp.doneHeading")
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
          <button
            data-tour="settings-winscp"
            onClick={chooseWinscpFile}
            disabled={busy}
            className="col-span-2 flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors hover:border-accent hover:bg-surface-hover disabled:opacity-50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <DownloadIcon size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">{t("hub.winscpTitle")}</span>
              <span className="block text-[11px] text-muted">{t("hub.winscpDescription")}</span>
            </span>
          </button>
        </div>
      )}

      {view === "export" && <ExportView tunnels={tunnels} busy={busy} run={run} />}

      {view === "import" && chosen && (
        <ImportView
          // Every pick (even the same file again) starts the choices over.
          key={chosen.pick}
          importPath={chosen.path}
          preview={chosen.preview}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onImported={(outcome) => {
            setResult(outcome);
            setView("imported");
            onImported();
          }}
          onChangeFile={chooseImportFile}
          onCancel={goHub}
        />
      )}

      {view === "imported" && result && <ImportedView result={result} onClose={goHub} />}

      {view === "winscp" && winscp && (
        <WinscpView
          key={winscp.token}
          preview={winscp}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onDone={(outcome) => {
            setWinscp(null);
            setWinscpDone(outcome);
            setView("winscpDone");
            onImported();
          }}
          onCancel={goHub}
        />
      )}

      {view === "winscpDone" && winscpDone && <WinscpDoneView outcome={winscpDone} onClose={goHub} />}
    </div>
  );
}
