import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * DECSET modes that turn mouse reporting on. 1005/1006/1015 only pick how
 * reports are encoded and 1004 is focus reporting; those pass through.
 */
const TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003]);

const MODE_PARAM: Record<Terminal["modes"]["mouseTrackingMode"], number | null> = {
  none: null,
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003,
};

/** Splits a `CSI ? … h/l` parameter list into tracking modes and the rest. */
export function splitTrackingModes(params: (number | number[])[]): { tracking: number[]; other: number[] } {
  const tracking: number[] = [];
  const other: number[] = [];
  for (const param of params) {
    const value = Array.isArray(param) ? param[0] : param;
    if (TRACKING_MODES.has(value)) tracking.push(value);
    else other.push(value);
  }
  return { tracking, other };
}

/**
 * Decides whether programs on the server (tmux with `mouse on`, vim, htop,
 * mc…) may take over the mouse. While they may not, a plain drag always
 * selects and copies, the way most people expect a terminal to behave; the
 * program never learns the mouse exists (wheel scrolling in full-screen apps
 * still works: xterm sends arrow keys for it).
 *
 * The modes a program asks for while blocked are remembered, so allowing the
 * mouse later hands it over at once instead of waiting for the program to ask
 * again; blocking takes it back the same way.
 */
export class MouseGate {
  /** Tracking modes the program asked for that are being withheld. */
  private held = new Set<number>();
  /** Set while we write our own `CSI ? … l`, so it isn't taken for the program's. */
  private injecting = false;
  private allowed: boolean;

  constructor(
    private readonly term: Terminal,
    allowed: boolean,
    /** Called when `wanted` may have changed. */
    private readonly onChange: () => void,
  ) {
    this.allowed = allowed;
  }

  /** The program asked for the mouse and is not getting it. */
  get wanted(): boolean {
    return this.held.size > 0;
  }

  attach(): IDisposable[] {
    const { parser } = this.term;
    return [
      parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => this.onSet(params)),
      parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => this.onReset(params)),
    ];
  }

  setAllowed(allowed: boolean) {
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    if (allowed) {
      if (this.held.size === 0) return;
      const modes = [...this.held];
      this.held.clear();
      // Goes through onSet again, which now lets it reach xterm.
      this.term.write(`\x1b[?${modes.join(";")}h`);
    } else {
      const active = MODE_PARAM[this.term.modes.mouseTrackingMode];
      if (active === null) return;
      this.held.add(active);
      this.injecting = true;
      this.term.write(`\x1b[?${active}l`, () => {
        this.injecting = false;
      });
    }
    this.onChange();
  }

  private onSet(params: (number | number[])[]): boolean {
    if (this.allowed) return false;
    const { tracking, other } = splitTrackingModes(params);
    if (tracking.length === 0) return false;
    for (const mode of tracking) this.held.add(mode);
    // Rare in practice (programs set these one per sequence), but whatever
    // else rode along in the same sequence still has to take effect.
    if (other.length > 0) this.term.write(`\x1b[?${other.join(";")}h`);
    this.onChange();
    return true;
  }

  private onReset(params: (number | number[])[]): boolean {
    if (!this.injecting) {
      const { tracking } = splitTrackingModes(params);
      // filter, not some: every mode in the sequence must be dropped.
      if (tracking.filter((mode) => this.held.delete(mode)).length > 0) this.onChange();
    }
    return false; // xterm still applies the reset itself
  }
}
