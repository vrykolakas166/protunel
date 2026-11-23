import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdates, clearTerminalCommands, downloadUpdate, getSettings, updateSettings } from "../api";
import type { Settings, Tunnel, UiMode, UpdateSnapshot } from "../types";
import { REPO_URL } from "../updates";
import { ReleaseNotes } from "./ReleaseNotes";
import { Modal } from "./Modal";
import { CopyLine } from "./CopyLine";
import { ConfigFlow } from "./ConfigFlow";
import logo from "../assets/logo.png";
import { getPlatformStatus, isWindows } from "../platform";

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

const numberInputClass =
  "w-24 rounded border border-border bg-bg px-2 py-1 text-right font-mono text-sm text-text focus:border-accent focus:outline-none disabled:opacity-50";

// ── Icons ───────────────────────────────────────────────────────────────────

/** 16-unit stroke icons for the pages, and the gear for the panel itself. */
const ICON_PATHS: Record<SettingsPage | "settings", ReactNode> = {
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M6.9 1.6h2.2l.4 1.7 1.2.7 1.7-.5 1.1 1.9-1.3 1.2v1.4l1.3 1.2-1.1 1.9-1.7-.5-1.2.7-.4 1.7H6.9l-.4-1.7-1.2-.7-1.7.5-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.7.5 1.2-.7z" />
    </>
  ),
  general: (
    <>
      <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
      <circle cx="11" cy="4.5" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </>
  ),
  tunnels: (
    <>
      <path d="M2 13.5V8a6 6 0 0 1 12 0v5.5" />
      <path d="M5.2 13.5V8.6a2.8 2.8 0 0 1 5.6 0v4.9" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6.5L6.5 8.5L4.5 10.5M8.5 10.5H11.5" />
    </>
  ),
  backup: (
    <>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.8-.5 3 3 0 0 1 .1 6.5" />
      <path d="M6 10L8 8L10 10M8 8V14" />
    </>
  ),
  about: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.3V11M8 5V5.1" />
    </>
  ),
  devtools: (
    <>
      <path d="M6 1.8h4M6.6 1.8v4.4L2.8 12.6a1 1 0 0 0 .9 1.6h8.6a1 1 0 0 0 .9-1.6L9.4 6.2V1.8" />
      <path d="M4.6 9.6h6.8" />
    </>
  ),
};

export function SettingsIcon({ name, size = 15 }: { name: SettingsPage | "settings"; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ── Building blocks (Windows 11 settings style: grouped cards of rows) ─────

export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
        checked ? "border-accent bg-accent" : "border-muted/60 bg-transparent hover:bg-surface-hover"
      }`}
    >
      <span
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ${
          checked ? "left-[18px] bg-on-accent" : "left-[3px] bg-muted"
        }`}
      />
    </button>
  );
}

/** A titled group of rows on one card. */
export function Group({ title, children, tour }: { title?: string; children: ReactNode; tour?: string }) {
  return (
    <section data-tour={tour} className="space-y-1.5">
      {title && <h4 className="px-1 text-xs font-semibold text-text">{title}</h4>}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg/50">
        {children}
      </div>
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function Row({
  title,
  description,
  control,
  indent = false,
  disabled = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  indent?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`px-3.5 py-3 ${indent ? "pl-8" : ""}`}>
      <div className={`flex items-center gap-4 ${disabled ? "opacity-50" : ""}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text">{title}</p>
          {description && <p className="mt-0.5 text-[11px] leading-snug text-muted">{description}</p>}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function timeAgo(at: number, language: string): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

/**
 * Settings, one page per subject (General, Tunnels, Terminal, Backup, About)
 * picked from a side list — the layout of Windows Terminal or Docker Desktop.
 * New options go on the page of the thing they change, so no page turns into
 * a grab bag. Theme and language are not here: they have their own header
 * buttons, and the theme drawer needs the window visible behind it.
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
  const { t, i18n } = useTranslation("settingsPanel");
  const { t: tc } = useTranslation("common");
  const [page, setPage] = useState<SettingsPage>(requestedPage);
  const [settings, setSettings] = useState<Settings | null>(null);
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
    // An import on the Backup page can replace settings while this is open;
    // without this, the next toggle would save the stale copy over them.
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

  const save = async (next: Settings) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      onSettingsChange(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setUpToDate(false);
    try {
      const snapshot = await checkForUpdates();
      setUpToDate(snapshot.phase === "idle");
    } catch (err) {
      setError(String(err));
    }
  };

  if (!settings) return null;

  const commit = () => void save(settings);
  const simple = settings.uiMode === "simple";
  const pages = [...(simple ? SIMPLE_PAGES : PAGES), ...(devTools ? (["devtools"] as const) : [])];
  // Switching to Simple while on a page it hides lands on General.
  const shownPage = pages.includes(page) ? page : "general";

  const updateTitle = (u: UpdateSnapshot): string => {
    switch (u.phase) {
      case "checking":
        return t("checking");
      case "available":
        return t("updateAvailable", { version: u.version });
      case "downloading":
        return t("updateDownloading", { version: u.version, percent: Math.round((u.progress ?? 0) * 100) });
      case "ready":
        return t("updateReady", { version: u.version });
      default:
        return upToDate ? t("upToDate") : t("updatesTitle");
    }
  };

  const primaryButton =
    "shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
  const secondaryButton =
    "shrink-0 rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-50";

  const updateControl = (u: UpdateSnapshot): ReactNode => {
    if (u.phase === "ready") {
      return (
        <button onClick={onRestartToUpdate} disabled={restarting} className={primaryButton}>
          {restarting ? t("installingUpdate") : t("restartToUpdate")}
        </button>
      );
    }
    if (u.phase === "available") {
      return (
        <button onClick={() => void downloadUpdate()} className={primaryButton}>
          {t("download")}
        </button>
      );
    }
    return (
      <button
        onClick={() => void checkNow()}
        disabled={u.phase === "checking" || u.phase === "downloading"}
        className={secondaryButton}
      >
        {t("checkForUpdates")}
      </button>
    );
  };
  const numberControl = (value: number, set: (value: number) => void, tooltip: string) => (
    <input
      type="number"
      title={tooltip}
      className={numberInputClass}
      value={value}
      disabled={busy}
      onChange={(e) => set(Number(e.target.value))}
      onBlur={commit}
    />
  );

  const pageBody = (): ReactNode => {
    switch (shownPage) {
      case "general":
        return (
          <>
            <Group title={t("groups.mode")} tour="settings-mode">
              <Row
                title={t("mode.title")}
                description={simple ? t("mode.simpleHint") : t("mode.fullHint")}
                control={
                  <div role="radiogroup" aria-label={t("mode.title")} className="flex shrink-0 rounded-md border border-border bg-surface p-0.5">
                    {(["simple", "full"] as UiMode[]).map((mode) => {
                      const active = (settings.uiMode ?? "full") === mode;
                      return (
                        <button
                          key={mode}
                          role="radio"
                          aria-checked={active}
                          disabled={busy}
                          onClick={() => !active && save({ ...settings, uiMode: mode })}
                          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                            active ? "bg-accent text-on-accent" : "text-muted hover:text-text"
                          }`}
                        >
                          {t(`mode.${mode}`)}
                        </button>
                      );
                    })}
                  </div>
                }
              />
            </Group>
            <Group title={t("groups.startup")} tour="settings-startup">
              <Row
                title={t("runAtStartup")}
                description={t("runAtStartupHint")}
                control={
                  <Switch
                    label={t("runAtStartup")}
                    checked={settings.autostartEnabled}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, autostartEnabled: on })}
                  />
                }
              >
                {settings.autostartEnabled && hyprlandLaunch && (
                  <div className="mt-2 space-y-1 text-[11px] text-muted">
                    <p>{t("hyprlandAutostart")}</p>
                    <CopyLine text={`exec-once = ${hyprlandLaunch} --autostart`} />
                  </div>
                )}
              </Row>
              <Row
                indent
                disabled={!settings.autostartEnabled}
                title={t("startMinimized")}
                description={t("startMinimizedHint")}
                control={
                  <Switch
                    label={t("startMinimized")}
                    checked={settings.startMinimized}
                    disabled={busy || !settings.autostartEnabled}
                    onChange={(on) => save({ ...settings, startMinimized: on })}
                  />
                }
              />
            </Group>
            <Group title={t("groups.notifications")}>
              <Row
                title={t("showNotifications")}
                description={t("showNotificationsHint")}
                control={
                  <Switch
                    label={t("showNotifications")}
                    checked={settings.notificationsEnabled}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, notificationsEnabled: on })}
                  />
                }
              />
            </Group>
          </>
        );

      case "tunnels":
        return (
          <>
            <Group title={t("groups.reconnect")} tour="settings-reconnect">
              <Row
                title={t("autoReconnect")}
                description={t("autoReconnectHint")}
                control={
                  <Switch
                    label={t("autoReconnect")}
                    checked={settings.autoReconnectEnabled}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, autoReconnectEnabled: on })}
                  />
                }
              />
              <Row
                title={t("keepaliveLabel")}
                description={t("keepaliveTooltip")}
                control={numberControl(
                  settings.keepaliveIntervalSecs,
                  (v) => setSettings({ ...settings, keepaliveIntervalSecs: v }),
                  t("keepaliveTooltip"),
                )}
              />
              <Row
                title={t("retriesLabel")}
                description={t("retriesTooltip")}
                control={numberControl(
                  settings.reconnectMaxAttempts,
                  (v) => setSettings({ ...settings, reconnectMaxAttempts: v }),
                  t("retriesTooltip"),
                )}
              />
            </Group>
            <Group title={t("groups.newTunnels")}>
              <Row
                title={t("portRange")}
                description={t("portRangeHint")}
                control={
                  <div className="flex items-center gap-1.5">
                    {numberControl(
                      settings.portRangeMin,
                      (v) => setSettings({ ...settings, portRangeMin: v }),
                      t("portMinTooltip"),
                    )}
                    <span className="text-muted">–</span>
                    {numberControl(
                      settings.portRangeMax,
                      (v) => setSettings({ ...settings, portRangeMax: v }),
                      t("portMaxTooltip"),
                    )}
                  </div>
                }
              />
            </Group>
          </>
        );

      case "terminal":
        return (
          <>
            <Group title={t("groups.mouse")}>
              <Row
                title={t("terminalAppMouse")}
                description={t("terminalAppMouseHint")}
                control={
                  <Switch
                    label={t("terminalAppMouse")}
                    checked={settings.terminalAppMouse}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, terminalAppMouse: on })}
                  />
                }
              />
            </Group>
            <Group title={t("groups.rendering")}>
              <Row
                title={t("terminalWebgl")}
                description={t("terminalWebglHint")}
                control={
                  <Switch
                    label={t("terminalWebgl")}
                    checked={settings.terminalWebgl}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, terminalWebgl: on })}
                  />
                }
              />
              <Row
                title={t("terminalDimInactive")}
                description={t("terminalDimInactiveHint")}
                control={
                  <Switch
                    label={t("terminalDimInactive")}
                    checked={settings.terminalDimInactive}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, terminalDimInactive: on })}
                  />
                }
              />
            </Group>
            <Group title={t("groups.smart")} tour="settings-smart">
              <Row
                title={t("terminalSuggestions")}
                description={t("terminalSuggestionsHint")}
                control={
                  <Switch
                    label={t("terminalSuggestions")}
                    checked={settings.terminalSuggestions}
                    disabled={busy}
                    onChange={(on) => save({ ...settings, terminalSuggestions: on })}
                  />
                }
              />
              <Row
                title={t("terminalLongCommand")}
                description={t("terminalLongCommandHint")}
                control={numberControl(
                  settings.terminalLongCommandSecs,
                  (v) => setSettings({ ...settings, terminalLongCommandSecs: Math.max(0, Math.round(v)) }),
                  t("terminalLongCommandHint"),
                )}
              />
              <Row
                title={t("terminalForget")}
                description={t("terminalForgetHint")}
                control={
                  <button
                    onClick={() => void clearTerminalCommands().then(() => setForgotten(true))}
                    disabled={forgotten}
                    className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text hover:border-coral hover:text-coral disabled:pointer-events-none disabled:opacity-50"
                  >
                    {forgotten ? t("terminalForgotten") : t("terminalForgetButton")}
                  </button>
                }
              />
            </Group>
          </>
        );

      case "backup":
        return (
          <>
            <div data-tour="settings-config">
              <ConfigFlow tunnels={tunnels} onImported={onImported} onBusyChange={onBackupFlow} />
            </div>
            {!inBackupFlow && !simple && (
              <Group title={t("groups.security")} tour="settings-hosts">
                <Row
                  title={t("knownHostsTitle")}
                  description={t("knownHostsHint")}
                  control={
                    <button
                      onClick={onOpenHosts}
                      className="shrink-0 rounded border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:bg-surface-hover"
                    >
                      {t("manageKnownHosts")}
                    </button>
                  }
                />
              </Group>
            )}
          </>
        );

      case "about":
        return (
          <>
            {/* Identity card. */}
            <div className="relative overflow-hidden rounded-xl border border-border bg-bg/50 p-4">
              <div
                className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-accent/15 blur-2xl"
                aria-hidden="true"
              />
              <div className="relative flex items-center gap-3.5">
                <img src={logo} alt="" width={52} height={52} className="shrink-0 drop-shadow-md" />
                <div className="min-w-0 flex-1">
                  <p className="font-display text-lg font-semibold text-text">protunel</p>
                  <p className="text-[11px] text-muted">{t("tagline")}</p>
                </div>
                <span className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-text">
                  {version ? `v${version}` : "…"}
                </span>
              </div>
            </div>

            <Group title={t("groups.updates")} tour="settings-updates">
              {!updates?.supported ? (
                <Row title={t("updatesTitle")} description={t("updatedByPackageManager")} />
              ) : (
                <>
                  <Row
                    title={updateTitle(updates)}
                    description={
                      updates.error
                        ? t("checkFailed", { error: updates.error })
                        : updates.lastChecked
                          ? t("lastChecked", { when: timeAgo(updates.lastChecked * 1000, i18n.language) })
                          : t("neverChecked")
                    }
                    control={updateControl(updates)}
                  >
                    {updates.phase === "downloading" && (
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full rounded-full bg-accent transition-[width]"
                          style={{ width: `${Math.round((updates.progress ?? 0) * 100)}%` }}
                        />
                      </div>
                    )}
                    {updates.notes && ["available", "downloading", "ready"].includes(updates.phase) && (
                      <div className="mt-2.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface p-3">
                        <ReleaseNotes markdown={updates.notes} />
                      </div>
                    )}
                  </Row>
                  <Row
                    title={t("autoUpdate")}
                    description={updates.installsOnExit ? t("autoUpdateHintExit") : t("autoUpdateHint")}
                    control={
                      <Switch
                        label={t("autoUpdate")}
                        checked={settings.autoUpdate}
                        disabled={busy}
                        onChange={(on) => save({ ...settings, autoUpdate: on })}
                      />
                    }
                  />
                </>
              )}
            </Group>

            {!simple && (onShowTour || onShowTerminalTour) && (
              // Rarely needed after the first run, so it lives here rather
              // than as a toolbar button (F1 also replays the main tour).
              <Group title={t("groups.tours")} tour="settings-tours">
                {(
                  [
                    ["tourMain", onShowTour],
                    ["tourTerminal", onShowTerminalTour],
                  ] as const
                ).map(([key, action]) =>
                  action ? (
                    <button
                      key={key}
                      onClick={action}
                      className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm text-text hover:bg-surface-hover"
                    >
                      {t(key)}
                      {key === "tourMain" && (
                        <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10px] text-muted">F1</kbd>
                      )}
                    </button>
                  ) : null,
                )}
              </Group>
            )}

            <Group title={t("groups.links")}>
              {(
                [
                  ["releaseNotes", `${REPO_URL}/releases`],
                  ["sourceCode", REPO_URL],
                  ["reportIssue", `${REPO_URL}/issues/new`],
                ] as const
              ).map(([key, url]) => (
                <button
                  key={key}
                  onClick={() => void openUrl(url)}
                  className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm text-text hover:bg-surface-hover"
                >
                  {t(`links.${key}`)}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-muted">
                    <path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ))}
            </Group>
            <p className="px-1 text-[11px] text-muted">{t("license")}</p>
          </>
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
