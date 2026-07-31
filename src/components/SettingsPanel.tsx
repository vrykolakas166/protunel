import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getSettings, updateSettings } from "../api";
import type { Settings, ThemePreference } from "../types";

interface Props {
  onClose: () => void;
  onSettingsChange: (settings: Settings) => void;
}

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const selectClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";

export function SettingsPanel({ onClose, onSettingsChange }: Props) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-text">Settings</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-muted hover:bg-surface-hover hover:text-text"
          >
            Close
          </button>
        </div>

        <div>
          <label className={labelClass}>Theme</label>
          <select
            className={selectClass}
            value={settings.theme}
            disabled={busy}
            onChange={(e) => save({ ...settings, theme: e.target.value as ThemePreference })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={settings.autostartEnabled}
            disabled={busy}
            onChange={(e) => save({ ...settings, autostartEnabled: e.target.checked })}
          />
          Launch ProdTunnel when Windows starts
        </label>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Default port range — min</label>
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
            <label className={labelClass}>max</label>
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

        {error && <p className="text-sm text-coral">{error}</p>}

        <div className="border-t border-border pt-3">
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

          {updateStatus && <p className="mt-2 text-xs text-muted">{updateStatus}</p>}

          {pendingUpdate && !installing && (
            <button
              onClick={installUpdate}
              className="mt-2 w-full rounded bg-amber px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Install v{pendingUpdate.version} &amp; restart
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
