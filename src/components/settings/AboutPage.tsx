import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdates, downloadUpdate } from "../../api";
import type { UpdateSnapshot } from "../../types";
import { REPO_URL } from "../../updates";
import { ReleaseNotes } from "../ReleaseNotes";
import logo from "../../assets/logo.png";
import { Group, Row, Switch, timeAgo, type PageProps } from "./parts";

const primaryButton =
  "shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
const secondaryButton =
  "shrink-0 rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-50";

export function AboutPage({
  settings,
  save,
  busy,
  version,
  updates,
  restarting,
  onRestartToUpdate,
  upToDate,
  onUpToDate,
  onError,
  onShowTour,
  onShowTerminalTour,
}: PageProps & {
  version: string | null;
  updates: UpdateSnapshot | null;
  restarting: boolean;
  onRestartToUpdate: () => void;
  /** The last manual check found nothing (a background one stays quiet). */
  upToDate: boolean;
  onUpToDate: (upToDate: boolean) => void;
  onError: (message: string) => void;
  onShowTour?: () => void;
  onShowTerminalTour?: () => void;
}) {
  const { t, i18n } = useTranslation("settingsPanel");
  const simple = settings.uiMode === "simple";

  const checkNow = async () => {
    onUpToDate(false);
    try {
      const snapshot = await checkForUpdates();
      onUpToDate(snapshot.phase === "idle");
    } catch (err) {
      onError(String(err));
    }
  };

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
}
