// Watching panes you are not looking at: "new output" after a quiet spell,
// and the opt-in tmux-style watches (notify on output, notify on silence).
// Pure timing logic; the terminal feeds it timestamps.

/** Output after this long without any counts as something new happening. */
export const QUIET_MS = 5000;
/** Silence a "notify on silence" watch waits for. */
export const SILENCE_MS = 30_000;
/** At most one desktop notification per pane in this long. */
export const NOTIFY_COOLDOWN_MS = 60_000;

export type WatchMode = "output" | "silence";

/**
 * Output timing of one shell. `output` says whether a chunk starts a new
 * burst (the shell had been quiet ≥ `QUIET_MS`); a steady stream (`top`,
 * `tail -f`) is one burst. `silent` says, once per quiet spell, when the
 * shell has been quiet for `silenceMs` since its last output or since the
 * watch was armed, whichever is later.
 */
export class OutputClock {
  private lastOutput = -Infinity;
  private armedAt = -Infinity;
  private silenceFired = false;

  /** A chunk of output arrived. True when it starts a new burst. */
  output(now: number): boolean {
    const burst = now - this.lastOutput >= QUIET_MS;
    this.lastOutput = now;
    this.silenceFired = false;
    return burst;
  }

  /** Starts (or restarts) the silence count, e.g. a watch armed or a reconnect. */
  arm(now: number) {
    this.armedAt = now;
    this.silenceFired = false;
  }

  /** The next output starts a burst, however recent the last one was. */
  expectNews() {
    this.lastOutput = -Infinity;
  }

  /** True once per quiet spell, when it reaches `silenceMs`. */
  silent(now: number, silenceMs = SILENCE_MS): boolean {
    if (this.silenceFired) return false;
    const since = Math.max(this.lastOutput, this.armedAt);
    if (!Number.isFinite(since) || now - since < silenceMs) return false;
    this.silenceFired = true;
    return true;
  }
}

/** Whether a desktop notification may go out now, given the pane's last one. */
export function mayNotify(lastNotified: number | undefined, now: number): boolean {
  return lastNotified === undefined || now - lastNotified >= NOTIFY_COOLDOWN_MS;
}
