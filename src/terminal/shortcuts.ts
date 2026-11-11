import type { Direction } from "./layout";

export type AppShortcut =
  | { kind: "searchHosts" }
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
