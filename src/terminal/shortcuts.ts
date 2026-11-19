import type { Direction } from "./layout";

export type AppShortcut =
  | { kind: "searchHosts" }
  | { kind: "toggleSidebar" }
  | { kind: "closePane" }
  | { kind: "cycleTab"; delta: 1 | -1 }
  | { kind: "gotoTab"; index: number }
  | { kind: "split"; dir: "row" | "col" }
  | { kind: "zoom" }
  | { kind: "broadcast" }
  | { kind: "focusPane"; dir: Direction };

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Window-level shortcuts. Matched here once so the terminal can tell xterm to
 * leave these keys alone (otherwise they would also reach the shell) and the
 * window can act on them. Plain Ctrl+letters stay with the shell — Ctrl+K is
 * readline's kill-line, Ctrl+B is tmux's prefix — so window actions use
 * Ctrl+Shift, Ctrl+Tab, Ctrl+digit and Alt+arrows (Windows Terminal's pane keys).
 */
export function matchShortcut(e: KeyboardEvent): AppShortcut | null {
  if (e.metaKey) return null;
  if (e.altKey && !e.ctrlKey && !e.shiftKey && ARROWS[e.key]) {
    return { kind: "focusPane", dir: ARROWS[e.key] };
  }
  if (!e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    switch (key) {
      case "k":
      case "t":
        return { kind: "searchHosts" };
      case "s":
        return { kind: "toggleSidebar" };
      case "w":
        return { kind: "closePane" };
      case "d":
        return { kind: "split", dir: "row" };
      case "e":
        return { kind: "split", dir: "col" };
      case "z":
        return { kind: "zoom" };
      case "b":
        return { kind: "broadcast" };
    }
  }
  if (key === "tab") return { kind: "cycleTab", delta: e.shiftKey ? -1 : 1 };
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    return { kind: "gotoTab", index: Number(e.code.slice(5)) - 1 };
  }
  return null;
}

/** Ctrl/Cmd keys an ordinary text field needs; every other combo is a browser command. */
const EDITING_KEYS = new Set([
  "a", "c", "v", "x", "z", "y",
  "arrowleft", "arrowright", "arrowup", "arrowdown",
  "backspace", "delete", "home", "end",
]);

export type KeyPlace = "textField" | "terminal" | "other";
export type StrayKeyAction = "pass" | "cancel" | "refocus";

/**
 * What the terminal window does with a keydown nobody handled (seen in the
 * bubble phase, after xterm cancelled every key it turned into shell input).
 * Without this the webview acts on it: F5 reloads and drops every shell,
 * Ctrl+F/P open find/print, Ctrl+= zooms, Space scrolls the page.
 *
 * - textField (search box, dialog inputs): keep typing and editing keys,
 *   cancel F-keys and other Ctrl/Cmd combos.
 * - terminal: cancel F-keys and Ctrl/Cmd combos. Printable keys pass, since
 *   cancelling their keydown would also cancel the text they type.
 * - other (page body, a button): cancel and hand focus back to the shell.
 *
 * Ctrl+Alt is never treated as a combo: it is AltGr on many layouts and types
 * characters (@, €, {…).
 */
export function strayKeyAction(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  place: KeyPlace,
): StrayKeyAction {
  const fKey = /^F\d{1,2}$/.test(e.key);
  const combo = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (place === "textField") {
    return fKey || (combo && !EDITING_KEYS.has(e.key.toLowerCase())) ? "cancel" : "pass";
  }
  if (place === "terminal") return fKey || combo ? "cancel" : "pass";
  return "refocus";
}
