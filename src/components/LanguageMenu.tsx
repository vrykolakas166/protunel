import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings } from "../api";
import { SUPPORTED_LANGUAGES } from "../i18n";
import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
}

/**
 * Language switcher on its own button. It used to share a pill with the theme
 * dot, which read as one control and sent people looking for the language in
 * the theme panel (and vice versa). Each option is labelled in its own language
 * so someone who cannot read the current one can still find theirs.
 */
export function LanguageMenu({ settings, onSettingsChange }: Props) {
  const { t } = useTranslation("app");
  const { t: ts } = useTranslation("settingsPanel");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (language: string) => {
    setOpen(false);
    if (language === settings.language) return;
    try {
      onSettingsChange(await updateSettings({ ...settings, language }));
    } catch {
      // The menu stays on the old language; nothing else to roll back.
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-tour="language"
        title={t("languageTooltip")}
        aria-label={t("languageTooltip")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold uppercase text-muted hover:bg-surface-hover hover:text-text"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M1.8 8H14.2M8 1.8C9.7 3.5 10.5 5.6 10.5 8S9.7 12.5 8 14.2C6.3 12.5 5.5 10.4 5.5 8S6.3 3.5 8 1.8Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        {settings.language}
      </button>
      {open && (
        <div
          role="menu"
          className="search-drop-in absolute right-0 top-full z-40 mt-1 min-w-36 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {SUPPORTED_LANGUAGES.map((value) => {
            const active = settings.language === value;
            return (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => void choose(value)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                  active ? "bg-accent/10 text-text" : "text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                <span className="w-5 font-mono text-[10px] uppercase text-muted">{value}</span>
                <span className="flex-1">{ts(`language.${value}`)}</span>
                {active && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-accent" aria-hidden="true">
                    <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
