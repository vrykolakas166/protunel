import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getSettings, updateSettings } from "../api";
import type { Settings } from "../types";
import { SUPPORTED_LANGUAGES } from "../i18n";
import { Modal } from "./Modal";
import { ThemePicker } from "./ThemePicker";
import { CopyLine } from "./CopyLine";
import { getPlatformStatus, isWindows } from "../platform";

interface Props {
  onClose: () => void;
  onSettingsChange: (settings: Settings) => void;
  onOpenConfig: () => void;
  onOpenHosts: () => void;
}

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const sectionLabelClass = "text-[10px] font-semibold uppercase tracking-wide text-muted";
const checkboxRowClass = "flex items-center gap-2 text-sm text-text";

export function SettingsPanel({ onClose, onSettingsChange, onOpenConfig, onOpenHosts }: Props) {
  const { t } = useTranslation("settingsPanel");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** Set only on Hyprland, which ignores XDG autostart entries. */
  const [hyprlandLaunch, setHyprlandLaunch] = useState<string | null>(null);
  const [selfUpdate, setSelfUpdate] = useState(true);

  useEffect(() => {
    if (isWindows) return;
    getPlatformStatus()
      .then((s) => {
        setHyprlandLaunch(s.desktop.includes("hyprland") ? s.launchCommand : null);
        setSelfUpdate(s.selfUpdate);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getSettings().then(setSettings);
    getVersion().then(setVersion);
  }, []);

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

  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateStatus(null);
    setPendingUpdate(null);
    try {
      const update = await check();
      if (update) {
        setPendingUpdate(update);
        setUpdateStatus(t("updateAvailable", { version: update.version }));
      } else {
        setUpdateStatus(t("upToDate"));
      }
    } catch (err) {
      setUpdateStatus(t("checkFailed", { error: String(err) }));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate) return;
    setInstalling(true);
    setUpdateStatus(t("downloading"));
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          setUpdateStatus(t("downloading"));
        } else if (event.event === "Finished") {
          setUpdateStatus(t("installingUpdate"));
        }
      });
      setUpdateStatus(t("installedRestarting"));
      await relaunch();
    } catch (err) {
      setUpdateStatus(t("installFailed", { error: String(err) }));
      setInstalling(false);
    }
  };

  if (!settings) return null;

  return (
    <Modal
      title={<h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        {error && <p className="text-sm text-coral">{error}</p>}

        <section data-tour="settings-theme" className="space-y-2">
          <p className={sectionLabelClass}>{t("sections.appearance")}</p>
          <ThemePicker settings={settings} disabled={busy} onChange={(next) => void save(next)} />

          <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-text">{t("languageLabel")}</label>
            <div className="flex items-center gap-1 rounded border border-border p-0.5">
              {SUPPORTED_LANGUAGES.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => save({ ...settings, language: value })}
                  className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                    settings.language === value
                      ? "bg-accent text-on-accent"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {t(`language.${value}`)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-1.5 border-t border-border pt-3">
          <p className={sectionLabelClass}>{t("sections.startupAndNotifications")}</p>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.autostartEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, autostartEnabled: e.target.checked })}
            />
            {t("launchOnStartup")}
          </label>
          {settings.autostartEnabled && hyprlandLaunch && (
            <div className="space-y-1 pl-6 text-[11px] text-muted">
              <p>{t("hyprlandAutostart")}</p>
              <CopyLine text={`exec-once = ${hyprlandLaunch}`} />
            </div>
          )}
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.notificationsEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, notificationsEnabled: e.target.checked })}
            />
            {t("showNotifications")}
          </label>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <p className={sectionLabelClass}>{t("sections.connections")}</p>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.autoReconnectEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, autoReconnectEnabled: e.target.checked })}
            />
            {t("autoReconnect")}
          </label>

          <div data-tour="settings-reconnect" className="grid grid-cols-4 gap-2">
            <div>
              <label className={labelClass} title={t("keepaliveTooltip")}>
                {t("keepaliveLabel")}
              </label>
              <input
                type="number"
                className={inputClass}
                value={settings.keepaliveIntervalSecs}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, keepaliveIntervalSecs: Number(e.target.value) })
                }
                onBlur={() => settings && save(settings)}
              />
            </div>
            <div>
              <label className={labelClass} title={t("retriesTooltip")}>
                {t("retriesLabel")}
              </label>
              <input
                type="number"
                className={inputClass}
                value={settings.reconnectMaxAttempts}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, reconnectMaxAttempts: Number(e.target.value) })
                }
                onBlur={() => settings && save(settings)}
              />
            </div>
            <div>
              <label className={labelClass} title={t("portMinTooltip")}>
                {t("portMinLabel")}
              </label>
              <input
                type="number"
                className={inputClass}
                value={settings.portRangeMin}
                disabled={busy}
                onChange={(e) => setSettings({ ...settings, portRangeMin: Number(e.target.value) })}
                onBlur={() => settings && save(settings)}
              />
            </div>
            <div>
              <label className={labelClass} title={t("portMaxTooltip")}>
                {t("portMaxLabel")}
              </label>
              <input
                type="number"
                className={inputClass}
                value={settings.portRangeMax}
                disabled={busy}
                onChange={(e) => setSettings({ ...settings, portRangeMax: Number(e.target.value) })}
                onBlur={() => settings && save(settings)}
              />
            </div>
          </div>
        </section>

        <section data-tour="settings-config" className="space-y-2 border-t border-border pt-3">
          <p className={sectionLabelClass}>{t("sections.dataAndSecurity")}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenConfig}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
            >
              {t("exportImportConfig")}
            </button>
            <button
              onClick={onOpenHosts}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
            >
              {t("knownHosts")}
            </button>
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <p className={sectionLabelClass}>{t("sections.about")}</p>
          <div className="flex items-center justify-between">
            <p className="font-mono text-xs text-muted">
              {version ? `v${version}` : "…"}
            </p>
            {selfUpdate ? (
              <button
                onClick={checkForUpdates}
                disabled={checkingUpdate || installing}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {checkingUpdate ? t("checking") : t("checkForUpdates")}
              </button>
            ) : (
              <p className="text-xs text-muted">{t("updatedByPackageManager")}</p>
            )}
          </div>

          {updateStatus && <p className="text-xs text-muted">{updateStatus}</p>}

          {pendingUpdate && !installing && (
            <button
              onClick={installUpdate}
              className="w-full rounded bg-amber px-3 py-1.5 text-sm font-medium text-on-amber hover:opacity-90"
            >
              {t("installAndRestart", { version: pendingUpdate.version })}
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}
