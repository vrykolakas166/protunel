import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings } from "../api";
import logo from "../assets/logo.png";
import { SUPPORTED_LANGUAGES } from "../i18n";
import { isWindows } from "../platform";
import type { Settings, UiMode } from "../types";

interface Props {
  settings: Settings;
  /** The install already had tunnels: this is an update, not a first run. */
  afterUpdate: boolean;
  onChoose: (mode: UiMode) => void;
  onSettingsChange: (settings: Settings) => void;
}

/** Each language named in itself, so anyone can find theirs. */
const LANGUAGE_NAMES: Record<string, string> = { en: "English", vi: "Tiếng Việt" };

/** A small hover bubble: the card stays short, the detail is one hover away. */
function Info({ text, label }: { text: string; label: string }) {
  return (
    <span className="group/info relative" onClick={(e) => e.stopPropagation()}>
      <span
        tabIndex={0}
        aria-label={label}
        className="flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.3V11M8 5V5.1" />
        </svg>
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-6 z-10 w-56 rounded-lg border border-border bg-surface p-2.5 text-[11px] leading-snug text-text opacity-0 shadow-lg transition-opacity group-hover/info:opacity-100 group-focus-within/info:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** Miniature of what each mode's window looks like. */
function Preview({ mode }: { mode: UiMode }) {
  if (mode === "simple") {
    return (
      <div className="flex h-full items-center gap-2.5 px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-on-accent">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
          </svg>
        </span>
        <span className="flex-1 space-y-1">
          <span className="block h-1.5 w-16 rounded-full bg-text/50" />
          <span className="block h-1.5 w-24 rounded-full bg-muted/30" />
        </span>
        <span className="relative h-4 w-7 rounded-full bg-accent">
          <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-surface" />
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3">
      {[0, 1, 2].map((row) => (
        <span key={row} className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${row === 2 ? "bg-slate" : "bg-accent"}`} />
          <span className="h-1.5 flex-1 rounded-full bg-muted/30" />
          <span className={`h-2.5 w-4 rounded-full ${row === 2 ? "bg-slate/40" : "bg-accent/70"}`} />
        </span>
      ))}
    </div>
  );
}

/**
 * Welcome screen, shown in place of the whole window while `settings.uiMode`
 * is unset: a fresh install, or the first launch after updating from a
 * version without modes — otherwise a tester's familiar window would suddenly
 * fill with developer features. Nothing behind it: the choice decides what
 * the window is. The language switch is here because this is the first thing
 * anyone reads.
 */
export function ModeChooser({ settings, afterUpdate, onChoose, onSettingsChange }: Props) {
  const { t } = useTranslation("simple");

  const setLanguage = async (language: string) => {
    if (language === settings.language) return;
    try {
      onSettingsChange(await updateSettings({ language }));
    } catch {
      // Stays on the current language.
    }
  };

  const card = (mode: UiMode, roles: string[], delay: number): ReactNode => (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onChoose(mode)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onChoose(mode))}
      style={{ "--delay": `${delay}ms` } as CSSProperties}
      className="rise-in group flex cursor-pointer flex-col overflow-visible rounded-xl border border-border bg-surface p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <div className="h-16 overflow-hidden rounded-lg border border-border bg-bg transition-colors group-hover:border-accent/40">
        <Preview mode={mode} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="font-display text-base font-semibold text-text">{t(`chooser.${mode}Title`)}</span>
        <span className="ml-auto">
          <Info text={t(mode === "simple" && !isWindows ? "chooser.simpleDetailLinux" : `chooser.${mode}Detail`)} label={t("chooser.details")} />
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{t(`chooser.${mode}Tagline`)}</p>
      <div className="mt-3 flex flex-wrap gap-1">
        {roles.map((role) => (
          <span
            key={role}
            className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] font-medium text-muted group-hover:border-accent/40 group-hover:text-accent"
          >
            {t(`chooser.roles.${role}`)}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Soft accent glow behind the logo; decoration only. */}
      <div className="pointer-events-none absolute left-1/2 top-6 h-56 w-56 -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />

      <div className="relative flex justify-end p-3">
        <div role="radiogroup" aria-label={t("chooser.language")} className="flex rounded-full border border-border bg-surface p-0.5 shadow-sm">
          {SUPPORTED_LANGUAGES.map((language) => {
            const active = settings.language === language;
            return (
              <button
                key={language}
                role="radio"
                aria-checked={active}
                onClick={() => void setLanguage(language)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active ? "bg-accent text-on-accent" : "text-muted hover:text-text"
                }`}
              >
                {LANGUAGE_NAMES[language] ?? language}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 pb-8">
        <div className="rise-in flex flex-col items-center text-center">
          <img src={logo} alt="" width={64} height={64} className="drop-shadow-lg" />
          <h1 className="mt-3 font-display text-xl font-semibold text-text">
            {afterUpdate ? t("chooser.afterUpdate") : t("chooser.welcome")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("chooser.subtitle")}</p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {card("simple", ["qa", "tester", "po"], 80)}
          {card("full", ["dev"], 140)}
        </div>

        <p className="rise-in mt-5 text-center text-[11px] text-muted" style={{ "--delay": "200ms" } as CSSProperties}>
          {t("chooser.footer")}
        </p>
      </div>
    </div>
  );
}
