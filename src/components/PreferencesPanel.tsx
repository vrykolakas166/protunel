import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings } from "../api";
import { settingsPatch } from "../settingsPatch";
import type { Settings } from "../types";
import { Drawer } from "./Drawer";
import { ThemePicker } from "./ThemePicker";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSettingsChange: (settings: Settings) => void;
}

/** Theme picker in a side drawer; the language has its own header menu. */
export function PreferencesPanel({ settings, onClose, onSettingsChange }: Props) {
  const { t } = useTranslation("settingsPanel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Settings) => {
    setBusy(true);
    setError(null);
    try {
      onSettingsChange(await updateSettings(settingsPatch(settings, next)));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={
        <div>
          <h2 className="font-display text-base font-semibold text-text">{t("preferences.title")}</h2>
          <p className="text-[11px] text-muted">{t("preferences.hint")}</p>
        </div>
      }
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {error && <p className="text-sm text-coral">{error}</p>}

        <section data-tour="settings-theme" className="flex min-h-0 flex-1 flex-col gap-2">
          <ThemePicker settings={settings} disabled={busy} onChange={(next) => void save(next)} fill />
        </section>
      </div>
    </Drawer>
  );
}
