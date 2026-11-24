import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getSettings, updateSettings } from "../api";
import { settingsPatch } from "../settingsPatch";
import type { Settings, Tunnel, UpdateSnapshot } from "../types";
import { Modal } from "./Modal";
import { getPlatformStatus, isWindows } from "../platform";
import { SettingsIcon } from "./settings/icons";
import { NumberControl, type NumberDraft } from "./settings/parts";
import { GeneralPage } from "./settings/GeneralPage";
import { TunnelsPage } from "./settings/TunnelsPage";
import { TerminalPage } from "./settings/TerminalPage";
import { BackupPage } from "./settings/BackupPage";
import { AboutPage } from "./settings/AboutPage";

// Other panels build on the same cards and the icon set.
export { Group, Row, Switch } from "./settings/parts";
export { SettingsIcon };

export type SettingsPage = "general" | "tunnels" | "terminal" | "backup" | "about" | "devtools";

const PAGES: SettingsPage[] = ["general", "tunnels", "terminal", "backup", "about"];
/** Simple mode has no tunnels to tune and no terminal. */
const SIMPLE_PAGES: SettingsPage[] = ["general", "backup", "about"];

interface Props {
  /** Page to show; changing it while open (the tour does) switches page. */
  page?: SettingsPage;
  tunnels: Tunnel[];
  onClose: () => void;
  onSettingsChange: (settings: Settings) => void;
  /** An import changed tunnels, rules or settings. */
  onImported: () => void;
  onOpenHosts: () => void;
  /** Backend updater state (`useUpdates`). */
  updates: UpdateSnapshot | null;
  restarting: boolean;
  /** Asks first when tunnels are up; see App. */
  onRestartToUpdate: () => void;
  /** The "Developer tools" page body, in builds that have it. */
  devTools?: ReactNode;
  /** Replays the main window's guided tour (Full mode). */
  onShowTour?: () => void;
  /** Opens the terminal window with its tour. */
  onShowTerminalTour?: () => void;
}

/**
 * Settings, one page per subject (General, Tunnels, Terminal, Backup, About)
 * picked from a side list — the layout of Windows Terminal or Docker Desktop.
 * New options go on the page of the thing they change, so no page turns into
 * a grab bag. Theme and language are not here: they have their own header
 * buttons, and the theme drawer needs the window visible behind it.
 * The pages live in `settings/`; this shell owns the settings copy, saving,
 * the number-field draft and the cross-page state.
 */
export function SettingsPanel({
  page: requestedPage = "general",
  tunnels,
  onClose,
  onSettingsChange,
  onImported,
  onOpenHosts,
  updates,
  restarting,
  onRestartToUpdate,
  devTools,
  onShowTour,
  onShowTerminalTour,
}: Props) {
  const { t } = useTranslation("settingsPanel");
  const { t: tc } = useTranslation("common");
  const [page, setPage] = useState<SettingsPage>(requestedPage);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [numberDraft, setNumberDraft] = useState<NumberDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  /** The last manual check found nothing (a background one stays quiet). */
  const [upToDate, setUpToDate] = useState(false);
  /** Set only on Hyprland, which ignores XDG autostart entries. */
  const [hyprlandLaunch, setHyprlandLaunch] = useState<string | null>(null);
  /** An export or import is mid-way: a stray backdrop click must not lose it. */
  const [inBackupFlow, setInBackupFlow] = useState(false);
  const onBackupFlow = useCallback((inFlow: boolean) => setInBackupFlow(inFlow), []);

  useEffect(() => setPage(requestedPage), [requestedPage]);

  useEffect(() => {
    if (isWindows) return;
    getPlatformStatus()
      .then((s) => {
        setHyprlandLaunch(s.desktop.includes("hyprland") ? s.launchCommand : null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getSettings().then(setSettings);
    getVersion().then(setVersion);
    // Keep the controls in sync with imports and saves from other windows.
    const unlisten = listen<Settings>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inBackupFlow) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, inBackupFlow]);

  if (!settings) return null;

  const save = async (next: Settings, base = settings) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateSettings(settingsPatch(base, next));
      setSettings(saved);
      onSettingsChange(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const simple = settings.uiMode === "simple";
  const pages = [...(simple ? SIMPLE_PAGES : PAGES), ...(devTools ? (["devtools"] as const) : [])];
  // Switching to Simple while on a page it hides lands on General.
  const shownPage = pages.includes(page) ? page : "general";

  const common = { settings, save, busy };
  const numberControl = (key: Parameters<typeof NumberControl>[0]["field"], tooltip: string) => (
    <NumberControl
      field={key}
      tooltip={tooltip}
      settings={settings}
      busy={busy}
      numberDraft={numberDraft}
      setNumberDraft={setNumberDraft}
      save={save}
    />
  );

  const pageBody = (): ReactNode => {
    switch (shownPage) {
      case "general":
        return <GeneralPage {...common} hyprlandLaunch={hyprlandLaunch} />;
      case "tunnels":
        return <TunnelsPage {...common} numberControl={numberControl} />;
      case "terminal":
        return (
          <TerminalPage
            {...common}
            numberControl={numberControl}
            forgotten={forgotten}
            onForgotten={() => setForgotten(true)}
          />
        );
      case "backup":
        return (
          <BackupPage
            tunnels={tunnels}
            simple={simple}
            inBackupFlow={inBackupFlow}
            onBackupFlow={onBackupFlow}
            onImported={onImported}
            onOpenHosts={onOpenHosts}
          />
        );
      case "about":
        return (
          <AboutPage
            {...common}
            version={version}
            updates={updates}
            restarting={restarting}
            onRestartToUpdate={onRestartToUpdate}
            upToDate={upToDate}
            onUpToDate={setUpToDate}
            onError={setError}
            onShowTour={onShowTour}
            onShowTerminalTour={onShowTerminalTour}
          />
        );
      case "devtools":
        return devTools;
    }
  };

  return (
    <Modal title={t("title")} onClose={onClose} size="xl" dismissible={!inBackupFlow} bare>
      <div className="flex min-h-[480px] flex-col sm:flex-row">
        {/* Side list on its own tinted pane; a row of tabs when narrow. */}
        <aside className="shrink-0 border-b border-border bg-bg/70 sm:w-48 sm:border-b-0 sm:border-r">
          <div className="sm:sticky sm:top-0">
            <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-on-accent shadow-sm">
                <SettingsIcon name="settings" size={17} />
              </span>
              <h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>
            </div>
            <nav className="flex gap-1 overflow-x-auto px-2 pb-2 sm:flex-col sm:overflow-visible sm:pb-4">
              {pages.map((id) => {
                const active = id === shownPage;
                return (
                  <button
                    key={id}
                    onClick={() => setPage(id)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      active
                        ? "bg-surface font-medium text-text shadow-sm ring-1 ring-border"
                        : "text-muted hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-2 left-0 hidden w-[3px] rounded-full bg-accent sm:block" />
                    )}
                    <span className={active ? "text-accent" : ""}>
                      <SettingsIcon name={id} />
                    </span>
                    {t(`pages.${id}.title`)}
                  </button>
                );
              })}
            </nav>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent ring-1 ring-accent/20">
              <SettingsIcon name={shownPage} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-base font-semibold text-text">{t(`pages.${shownPage}.title`)}</h3>
              <p className="text-[11px] text-muted">{t(`pages.${shownPage}.description`)}</p>
            </div>
            <button
              onClick={onClose}
              aria-label={tc("close")}
              className="shrink-0 rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <div className="flex-1 space-y-5 px-5 py-4">
            {error && <p className="text-sm text-coral">{error}</p>}
            {pageBody()}
          </div>
        </section>
      </div>
    </Modal>
  );
}
