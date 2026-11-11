import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "../types";
import { DARK_DEFAULT, LIGHT_DEFAULT, THEMES, setThemePreview, themeById, type ThemeDef } from "../themes";

type Filter = "all" | "dark" | "light";
type Slot = "light" | "dark";

interface Props {
  settings: Settings;
  disabled: boolean;
  onChange: (next: Settings) => void;
}

function ThemeCard({
  theme,
  selected,
  onPick,
}: {
  theme: ThemeDef;
  selected: boolean;
  onPick: () => void;
}) {
  const { bg, main, sub, text } = theme.swatch;
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => setThemePreview(theme.id)}
      onFocus={() => setThemePreview(theme.id)}
      title={theme.name}
      aria-pressed={selected}
      className={`group flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-transform hover:-translate-y-px ${
        selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : "ring-1 ring-black/10"
      }`}
      style={{ background: bg, color: text }}
    >
      <span className="min-w-0 flex-1 truncate">{theme.name}</span>
      <span className="flex shrink-0 gap-1">
        {[main, sub, text].map((color, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        ))}
      </span>
    </button>
  );
}

/**
 * Theme catalogue, in the spirit of monkeytype's: every theme as a card in its
 * own colours, a search box, and hovering a card previews it on the whole
 * window. "Follow system" keeps one theme for a light Windows and one for a
 * dark one; the slot buttons choose which of the two a click sets.
 */
export function ThemePicker({ settings, disabled, onChange }: Props) {
  const { t } = useTranslation("settingsPanel");
  const followSystem = settings.theme === "system";
  const [slot, setSlot] = useState<Slot>("dark");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Leaving the picker (or closing Settings) always ends a preview.
  useEffect(() => () => setThemePreview(null), []);

  const fixedId = followSystem ? null : (themeById(settings.theme)?.id ?? null);
  const selectedId = followSystem
    ? slot === "dark"
      ? settings.themeDark
      : settings.themeLight
    : fixedId;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return THEMES.filter(
      (theme) =>
        (filter === "all" || (filter === "dark") === theme.dark) &&
        (!q || theme.name.includes(q)),
    );
  }, [query, filter]);

  // The hover preview already shows this theme; it stays until the pointer
  // leaves the grid, by which time the saved setting shows the same thing.
  const pick = (theme: ThemeDef) => {
    if (!followSystem) onChange({ ...settings, theme: theme.id });
    else if (slot === "dark") onChange({ ...settings, themeDark: theme.id });
    else onChange({ ...settings, themeLight: theme.id });
  };

  const setMode = (system: boolean) => {
    if (system === followSystem) return;
    if (system) {
      onChange({ ...settings, theme: "system" });
      setFilter(slot);
    } else {
      // Keep looking at whatever the system pair is showing right now.
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      onChange({ ...settings, theme: dark ? settings.themeDark : settings.themeLight });
      setFilter("all");
    }
  };

  const chooseSlot = (next: Slot) => {
    setSlot(next);
    setFilter(next);
  };

  const segment = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
      active ? "bg-accent text-on-accent" : "text-muted hover:bg-surface-hover hover:text-text"
    }`;

  const slotButton = (which: Slot) => {
    const id = which === "dark" ? settings.themeDark : settings.themeLight;
    const theme = themeById(id) ?? themeById(which === "dark" ? DARK_DEFAULT : LIGHT_DEFAULT)!;
    const active = slot === which;
    return (
      <button
        type="button"
        onClick={() => chooseSlot(which)}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left ${
          active ? "border-accent bg-accent/10" : "border-border hover:bg-surface-hover"
        }`}
      >
        <span
          className="h-5 w-5 shrink-0 rounded border border-black/10"
          style={{ background: theme.swatch.bg, boxShadow: `inset -8px 0 0 ${theme.swatch.main}` }}
        />
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-muted">
            {which === "dark" ? t("themeSlotDark") : t("themeSlotLight")}
          </span>
          <span className="block truncate text-xs text-text">{theme.name}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-text">{t("themeLabel")}</label>
        <div className="flex items-center gap-1 rounded border border-border p-0.5">
          <button type="button" disabled={disabled} onClick={() => setMode(false)} className={segment(!followSystem)}>
            {t("themeFixed")}
          </button>
          <button type="button" disabled={disabled} onClick={() => setMode(true)} className={segment(followSystem)}>
            {t("themeSystem")}
          </button>
        </div>
      </div>

      {followSystem && (
        <div className="flex gap-2">
          {slotButton("light")}
          {slotButton("dark")}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("themeSearch", { count: THEMES.length })}
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <div className="flex shrink-0 items-center gap-1 rounded border border-border p-0.5">
          {(["all", "dark", "light"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={segment(filter === value)}>
              {t(`themeFilter.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div
        onMouseLeave={() => setThemePreview(null)}
        className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto p-1 sm:grid-cols-3"
      >
        {shown.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            selected={theme.id === selectedId}
            onPick={() => !disabled && pick(theme)}
          />
        ))}
        {shown.length === 0 && (
          <p className="col-span-full py-4 text-center text-xs text-muted">{t("themeNoMatch")}</p>
        )}
      </div>
    </div>
  );
}
