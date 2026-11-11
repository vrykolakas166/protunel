import { useEffect, useState, useSyncExternalStore } from "react";
import type { ITheme } from "@xterm/xterm";
import {
  bestOn,
  ensureContrast,
  hsl,
  luminance,
  mix,
  rgbTriplet,
  withAlpha,
} from "./color";
import { PALETTES, type PaletteRow } from "./palettes";

/** Every colour token the UI uses (`--color-*` in index.css). */
export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceHover: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  amber: string;
  onAmber: string;
  coral: string;
  onCoral: string;
  slate: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  colors: ThemeColors;
  terminal: ITheme;
  /** Picker preview: background, then the colours drawn on it. */
  swatch: { bg: string; main: string; sub: string; text: string };
}

export const LIGHT_DEFAULT = "protunel_light";
export const DARK_DEFAULT = "protunel_dark";

// ── The app's own two themes, hand-tuned. ──────────────────────────────────

const PROTUNEL_LIGHT: ThemeDef = {
  id: LIGHT_DEFAULT,
  name: "protunel light",
  dark: false,
  colors: {
    bg: "#f5f4f0",
    surface: "#ffffff",
    surfaceHover: "#f0efea",
    border: "#e1dfd8",
    text: "#1b1f29",
    muted: "#6b7280",
    accent: "#0f9b8e",
    accentHover: "#0c8177",
    onAccent: "#ffffff",
    amber: "#c97a12",
    onAmber: "#ffffff",
    coral: "#c7373d",
    onCoral: "#ffffff",
    slate: "#9ca3af",
  },
  terminal: {
    background: "#fdfcf9",
    foreground: "#1b1f29",
    cursor: "#0f9b8e",
    cursorAccent: "#fdfcf9",
    selectionBackground: "rgba(15, 155, 142, 0.22)",
    black: "#1b1f29",
    red: "#c7373d",
    green: "#2f8f46",
    yellow: "#b06d0f",
    blue: "#2f62c9",
    magenta: "#8e44ad",
    cyan: "#0f9b8e",
    white: "#6b7280",
    brightBlack: "#4b5262",
    brightRed: "#e04a50",
    brightGreen: "#3aa857",
    brightYellow: "#c97a12",
    brightBlue: "#4378e0",
    brightMagenta: "#a35bc2",
    brightCyan: "#12b3a4",
    brightWhite: "#9ca3af",
  },
  swatch: { bg: "#f5f4f0", main: "#0f9b8e", sub: "#6b7280", text: "#1b1f29" },
};

const PROTUNEL_DARK: ThemeDef = {
  id: DARK_DEFAULT,
  name: "protunel dark",
  dark: true,
  colors: {
    bg: "#12151c",
    surface: "#1b1f29",
    surfaceHover: "#232837",
    border: "#2a2f3b",
    text: "#e8eaf0",
    muted: "#8b93a7",
    accent: "#4fd1c5",
    accentHover: "#3fbfb3",
    // The teal is light enough that white text on it barely reads.
    onAccent: "#12151c",
    amber: "#e8a33d",
    onAmber: "#ffffff",
    coral: "#e8595f",
    onCoral: "#ffffff",
    slate: "#4b5262",
  },
  terminal: {
    background: "#12151c",
    foreground: "#e8eaf0",
    cursor: "#4fd1c5",
    cursorAccent: "#12151c",
    selectionBackground: "rgba(79, 209, 197, 0.28)",
    black: "#1b1f29",
    red: "#e8595f",
    green: "#7fd18b",
    yellow: "#e8a33d",
    blue: "#6ea8fe",
    magenta: "#c792ea",
    cyan: "#4fd1c5",
    white: "#c9cdd8",
    brightBlack: "#5b6274",
    brightRed: "#ff7a80",
    brightGreen: "#9be3a5",
    brightYellow: "#ffc266",
    brightBlue: "#91bdff",
    brightMagenta: "#dcb1f5",
    brightCyan: "#7fe6dc",
    brightWhite: "#ffffff",
  },
  swatch: { bg: "#12151c", main: "#4fd1c5", sub: "#8b93a7", text: "#e8eaf0" },
};

// ── Everything else is derived from a 10-colour palette. ───────────────────

function fromPalette(row: PaletteRow): ThemeDef {
  const [id, bg, main, caret, sub, subAlt, rawText, error] = row;
  const dark = luminance(bg) < luminance(rawText);
  // Black or white, whichever this background is furthest from.
  const ink = bestOn(bg, ["#000000", "#ffffff"]);

  // Panels sit on `subAlt`, unless it is indistinguishable from the page.
  const surface =
    Math.abs(luminance(subAlt) - luminance(bg)) < 0.004 ? mix(bg, rawText, 0.05) : subAlt;
  // Some palettes lean on a background image on the website and are not
  // readable from colours alone; their text is pushed toward black or white
  // until it reads on both the page and the panels.
  const text = ensureContrast(ensureContrast(rawText, bg, 4.5, ink), surface, 4.5, ink);
  const muted = ensureContrast(sub, surface, 3, text);
  const accent = ensureContrast(main, surface, 1.8, text);
  const coral = ensureContrast(error, surface, 3, ink);
  // No warning colour in these palettes: a warm amber at this theme's
  // brightness, nudged toward its accent so it belongs.
  const amber = mix(hsl(38, 0.8, dark ? 0.6 : 0.42), main, 0.15);
  const onBest = (c: string) => bestOn(c, [bg, text, "#ffffff", "#111111"]);

  // ANSI: fixed hues so `ls` colours stay recognisable, lit for this
  // background and tinted toward the accent.
  const tone = (hue: number, bright = false) =>
    mix(hsl(hue, dark ? 0.6 : 0.65, (dark ? 0.66 : 0.4) + (bright ? (dark ? 0.08 : -0.06) : 0)), main, 0.12);

  return {
    id,
    name: id.replace(/_/g, " "),
    dark,
    colors: {
      bg,
      surface,
      surfaceHover: mix(surface, text, 0.07),
      border: mix(surface, sub, 0.35),
      text,
      muted,
      accent,
      accentHover: mix(accent, ink, 0.12),
      onAccent: onBest(accent),
      amber,
      onAmber: onBest(amber),
      coral,
      onCoral: onBest(coral),
      slate: mix(sub, bg, 0.45),
    },
    terminal: {
      background: bg,
      foreground: text,
      cursor: caret,
      cursorAccent: bg,
      selectionBackground: withAlpha(main, 0.3),
      scrollbarSliderBackground: withAlpha(sub, 0.2),
      scrollbarSliderHoverBackground: withAlpha(sub, 0.35),
      scrollbarSliderActiveBackground: withAlpha(sub, 0.5),
      black: dark ? mix(bg, text, 0.15) : mix(text, bg, 0.1),
      red: error,
      green: tone(120),
      yellow: tone(45),
      blue: tone(215),
      magenta: tone(300),
      cyan: tone(180),
      white: dark ? mix(text, bg, 0.15) : sub,
      brightBlack: sub,
      brightRed: mix(error, ink, 0.15),
      brightGreen: tone(120, true),
      brightYellow: tone(45, true),
      brightBlue: tone(215, true),
      brightMagenta: tone(300, true),
      brightCyan: tone(180, true),
      brightWhite: dark ? text : mix(text, bg, 0.25),
    },
    swatch: { bg, main, sub, text },
  };
}

export const THEMES: ThemeDef[] = [
  PROTUNEL_LIGHT,
  PROTUNEL_DARK,
  ...PALETTES.map(fromPalette).sort((a, b) => a.name.localeCompare(b.name)),
];

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export function themeById(id: string | undefined): ThemeDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

// ── Choosing and applying. ─────────────────────────────────────────────────

export interface ThemeSettings {
  /** A theme id, or "system" to follow Windows between `themeLight` and `themeDark`. */
  theme: string;
  themeLight: string;
  themeDark: string;
}

/** Settings from before the theme catalogue stored "light" / "dark". */
const LEGACY: Record<string, string> = { light: LIGHT_DEFAULT, dark: DARK_DEFAULT };

export function resolveTheme(settings: ThemeSettings | null, systemDark: boolean): ThemeDef {
  const choice = settings?.theme ?? "system";
  const id =
    choice === "system"
      ? systemDark
        ? settings?.themeDark
        : settings?.themeLight
      : (LEGACY[choice] ?? choice);
  return themeById(id) ?? (systemDark ? PROTUNEL_DARK : PROTUNEL_LIGHT);
}

export function applyTheme(theme: ThemeDef) {
  const root = document.documentElement;
  const c = theme.colors;
  const vars: Record<string, string> = {
    "--color-bg": c.bg,
    "--color-surface": c.surface,
    "--color-surface-hover": c.surfaceHover,
    "--color-border": c.border,
    "--color-text": c.text,
    "--color-muted": c.muted,
    "--color-accent": c.accent,
    "--color-accent-hover": c.accentHover,
    "--color-on-accent": c.onAccent,
    "--color-amber": c.amber,
    "--color-on-amber": c.onAmber,
    "--color-coral": c.coral,
    "--color-on-coral": c.onCoral,
    "--color-slate": c.slate,
    "--color-surface-rgb": rgbTriplet(c.surface),
    "--color-accent-rgb": rgbTriplet(c.accent),
    "--color-coral-rgb": rgbTriplet(c.coral),
    "--color-slate-rgb": rgbTriplet(c.slate),
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.classList.toggle("dark", theme.dark);
  root.style.colorScheme = theme.dark ? "dark" : "light";
}

// Hover preview from the picker: shown instead of the saved theme until cleared.
let previewId: string | null = null;
const listeners = new Set<() => void>();

export function setThemePreview(id: string | null) {
  if (id === previewId) return;
  previewId = id;
  listeners.forEach((notify) => notify());
}

const subscribePreview = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

function useSystemDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** Applies the chosen (or previewed) theme to this window and returns it. */
export function useTheme(settings: ThemeSettings | null): ThemeDef {
  const systemDark = useSystemDark();
  const preview = useSyncExternalStore(subscribePreview, () => previewId);
  const theme = themeById(preview ?? undefined) ?? resolveTheme(settings, systemDark);
  useEffect(() => applyTheme(theme), [theme]);
  return theme;
}
