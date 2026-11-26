import { useTranslation } from "react-i18next";
import type { UiMode } from "../../types";
import { CopyLine } from "../CopyLine";
import { Group, Row, Switch, type PageProps } from "./parts";

export function GeneralPage({
  settings,
  save,
  busy,
  hyprlandLaunch,
}: PageProps & {
  /** Set only on Hyprland, which ignores XDG autostart entries. */
  hyprlandLaunch: string | null;
}) {
  const { t } = useTranslation("settingsPanel");
  const simple = settings.uiMode === "simple";
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
        <Row
          title={t("closeToTray")}
          description={t("closeToTrayHint")}
          control={
            <Switch
              label={t("closeToTray")}
              checked={settings.closeToTray}
              disabled={busy}
              onChange={(on) => save({ ...settings, closeToTray: on })}
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
}
