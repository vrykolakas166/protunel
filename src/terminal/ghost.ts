// Autocomplete ghost text: the rest of a remembered command drawn dim after
// the cursor, as an xterm decoration (nothing is written to the shell until
// it is accepted). → takes it all, Ctrl+→ one word.

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { nextWord } from "./smart";

/**
 * Tab is the shell's completion, but people reach for it to take the ghost.
 * Two Tabs in a row over one earn a reminder — rarely (once per 10 min per
 * window) and never again once → has been used to accept a few times.
 */
const LEARNED_KEY = "protunel.terminal.ghostAccepted";
const LEARNED_AFTER = 3;
const HINT_EVERY_MS = 10 * 60 * 1000;
const TAB_STREAK_MS = 1500;
let lastHintAt = -Infinity;

function acceptedCount(): number {
  try {
    return Number(localStorage.getItem(LEARNED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function noteAccepted() {
  try {
    localStorage.setItem(LEARNED_KEY, String(acceptedCount() + 1));
  } catch {
    // Blocked storage: the reminder just keeps coming now and then.
  }
}

export interface GhostStyle {
  fontFamily: string;
  fontSize: number;
  /** Read at each render, so a theme change applies. */
  color: () => string;
}

export class GhostSuggest {
  private ghost: { rest: string; x: number; y: number; marker: IMarker; decoration: IDecoration } | null = null;
  private timer = 0;
  private tabStreak = 0;
  private tabAt = 0;

  constructor(
    private term: Terminal,
    private style: GhostStyle,
    /** What to suggest now: typed text and the full command, or null. */
    private suggest: () => { typed: string; command: string } | null,
    private onTabHint: () => void,
  ) {}

  get visible() {
    return this.ghost !== null;
  }

  /** Looks again shortly, once the echo of a keystroke has landed. */
  schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.show(), 30);
  }

  clear() {
    window.clearTimeout(this.timer);
    if (!this.ghost) return;
    this.ghost.decoration.dispose();
    this.ghost.marker.dispose();
    this.ghost = null;
  }

  dispose() {
    this.clear();
  }

  /**
   * Typing the ghost's next character keeps it up until the echo moves it
   * along (no blink); anything else hides it. Also watches for Tab.
   */
  onInput(data: string) {
    this.watchTab(data);
    if (!this.ghost || data !== this.ghost.rest[0]) this.clear();
  }

  /** → (all) or Ctrl+→ (one word). False when there is nothing to take. */
  accept(wordOnly: boolean): boolean {
    if (!this.ghost) return false;
    noteAccepted();
    const text = wordOnly ? nextWord(this.ghost.rest) : this.ghost.rest;
    this.clear();
    this.term.input(text, true); // as if typed: same path, same targets
    return true;
  }

  /** Redrawn only when it changes; clearing and redrawing per keystroke blinked. */
  private show() {
    window.clearTimeout(this.timer);
    const next = this.suggest();
    if (!next) {
      this.clear();
      return;
    }
    const rest = next.command.slice(next.typed.length);
    const buf = this.term.buffer.active;
    const x = buf.cursorX;
    const y = buf.baseY + buf.cursorY;
    const current = this.ghost;
    if (current && current.rest === rest && current.x === x && current.y === y) return;
    this.clear();
    const width = Math.min(rest.length, this.term.cols - x);
    if (width <= 0) return;
    const marker = this.term.registerMarker(0);
    const decoration = marker && this.term.registerDecoration({ marker, x, width, layer: "top" });
    if (!marker || !decoration) {
      marker?.dispose();
      return;
    }
    decoration.onRender((el) => {
      el.textContent = rest.slice(0, width);
      el.style.color = this.style.color();
      el.style.opacity = "0.4";
      el.style.fontFamily = this.style.fontFamily;
      el.style.fontSize = `${this.style.fontSize}px`;
      el.style.lineHeight = el.style.height;
      el.style.whiteSpace = "pre";
      el.style.overflow = "hidden";
      el.style.pointerEvents = "none";
    });
    this.ghost = { rest, x, y, marker, decoration };
  }

  private watchTab(data: string) {
    if (data !== "\t") {
      this.tabStreak = 0;
      return;
    }
    const now = performance.now();
    const recent = now - this.tabAt <= TAB_STREAK_MS;
    this.tabStreak = this.tabStreak > 0 && recent ? this.tabStreak + 1 : this.ghost ? 1 : 0;
    this.tabAt = now;
    if (this.tabStreak < 2) return;
    this.tabStreak = 0;
    if (now - lastHintAt < HINT_EVERY_MS || acceptedCount() >= LEARNED_AFTER) return;
    lastHintAt = now;
    this.onTabHint();
  }
}
