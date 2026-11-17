import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings } from "../api";
import { SUPPORTED_LANGUAGES } from "../i18n";
import type { Settings } from "../types";
import { Drawer } from "./Drawer";
import { ThemePicker } from "./ThemePicker";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSettingsChange: (settings: Settings) => void;
}

const sectionLabelClass = "text-[10px] font-semibold uppercase tracking-wide text-muted";

/** Theme and language: the look-and-feel half of settings, in a side drawer. */
export function PreferencesPanel({ settings, onClose, onSettingsChange }: Props) {
  const { t } = useTranslation("settingsPanel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Settings) => {
    setBusy(true);
    setError(null);
    try {
      onSettingsChange(await updateSettings(next));
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

        <section className="space-y-2">
          <p className={sectionLabelClass}>{t("languageLabel")}</p>
          <div className="flex items-center gap-1 rounded border border-border p-0.5">
            {SUPPORTED_LANGUAGES.map((value) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => save({ ...settings, language: value })}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                  settings.language === value
                    ? "bg-accent text-on-accent"
                    : "text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {t(`language.${value}`)}
              </button>
            ))}
          </div>
        </section>

        <section data-tour="settings-theme" className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border pt-3">
          <ThemePicker settings={settings} disabled={busy} onChange={(next) => void save(next)} fill />
        </section>
      </div>
    </Drawer>
  );
}
