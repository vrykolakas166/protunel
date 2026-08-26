import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getSettings, updateSettings } from "../api";
import type { Settings, ThemePreference } from "../types";
import { Modal } from "./Modal";

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

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: "system",
    label: "Match system",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="13" rx="1.5" />
        <path d="M8 21h8M12 17v4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function SettingsPanel({ onClose, onSettingsChange, onOpenConfig, onOpenHosts }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installing, setInstalling] = useState(false);

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
        setUpdateStatus(`Update available: v${update.version}`);
      } else {
        setUpdateStatus("You're up to date.");
      }
    } catch (err) {
      setUpdateStatus(`Check failed: ${String(err)}`);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate) return;
    setInstalling(true);
    setUpdateStatus("Downloading…");
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          setUpdateStatus("Downloading…");
        } else if (event.event === "Finished") {
          setUpdateStatus("Installing…");
        }
      });
      setUpdateStatus("Installed. Restarting…");
      await relaunch();
    } catch (err) {
      setUpdateStatus(`Install failed: ${String(err)}`);
      setInstalling(false);
    }
  };

  if (!settings) return null;

  return (
    <Modal
      title={<h2 className="font-display text-base font-semibold text-text">Settings</h2>}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-4">
        {error && <p className="text-sm text-coral">{error}</p>}

        <section className="space-y-2">
          <p className={sectionLabelClass}>Appearance</p>
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-text">Theme</label>
            <div className="flex items-center gap-1 rounded border border-border p-0.5">
              {THEME_OPTIONS.map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  title={label}
                  aria-label={label}
                  disabled={busy}
                  onClick={() => save({ ...settings, theme: value })}
                  className={`flex h-7 w-7 items-center justify-center rounded disabled:opacity-50 ${
                    settings.theme === value
                      ? "bg-accent text-white"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-1.5 border-t border-border pt-3">
          <p className={sectionLabelClass}>Startup &amp; notifications</p>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.autostartEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, autostartEnabled: e.target.checked })}
            />
            Launch ProdTunnel when Windows starts
          </label>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.notificationsEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, notificationsEnabled: e.target.checked })}
            />
            Show Windows notifications
          </label>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <p className={sectionLabelClass}>Connections</p>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={settings.autoReconnectEnabled}
              disabled={busy}
              onChange={(e) => save({ ...settings, autoReconnectEnabled: e.target.checked })}
            />
            Reconnect automatically when a tunnel drops
          </label>

          <div data-tour="settings-reconnect" className="grid grid-cols-4 gap-2">
            <div>
              <label className={labelClass} title="Seconds between keepalive pings so a dead connection gets noticed. 0 disables keepalives.">
                Keepalive (s)
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
              <label className={labelClass} title="Give up reconnecting after this many consecutive failed attempts. 0 means never give up.">
                Retries
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
              <label className={labelClass} title="Lower bound of the local SOCKS port range suggested when adding a new tunnel.">
                Port min
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
              <label className={labelClass} title="Upper bound of the local SOCKS port range suggested when adding a new tunnel.">
                Port max
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
          <p className={sectionLabelClass}>Data &amp; security</p>
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenConfig}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
            >
              Export / import config
            </button>
            <button
              onClick={onOpenHosts}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
            >
              Known hosts
            </button>
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <p className={sectionLabelClass}>About</p>
          <div className="flex items-center justify-between">
            <p className="font-mono text-xs text-muted">
              {version ? `v${version}` : "…"}
            </p>
            <button
              onClick={checkForUpdates}
              disabled={checkingUpdate || installing}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {checkingUpdate ? "Checking…" : "Check for updates"}
            </button>
          </div>

          {updateStatus && <p className="text-xs text-muted">{updateStatus}</p>}

          {pendingUpdate && !installing && (
            <button
              onClick={installUpdate}
              className="w-full rounded bg-amber px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Install v{pendingUpdate.version} &amp; restart
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}
