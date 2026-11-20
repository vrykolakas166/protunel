// Watches one xterm for shell commands: what was typed at the prompt, when it
// finished, what it printed. Without shell integration this is read off the
// screen — the line at Enter from where typing began, and the prompt coming
// back once output goes quiet. A shell that emits OSC 133 (iTerm2/VS Code
// shell integration) gives exact prompt and exit-code marks, used when seen.

import type { IDisposable, Terminal } from "@xterm/xterm";
import { matchesPrompt, promptShape, type PromptShape } from "./smart";

export interface CommandResult {
  command: string;
  durationMs: number;
  /** Known only with shell integration (OSC 133;D). */
  exitCode: number | null;
  /** Lines between the command and the next prompt (the last 60). */
  output: string[];
}

export interface WatchHandlers {
  /** The first prompt of a shell is on screen and nothing has been typed. */
  onFirstPrompt: () => void;
  onCommandStart: (command: string) => void;
  onCommandEnd: (result: CommandResult) => void;
}

/** Output quiet this long with a prompt-looking line under the cursor: done. */
const QUIET_MS = 250;
const OUTPUT_LINES = 60;
// Bracketed paste markers around pasted text.
const PASTE_MARKS = /\x1b\[20[01]~/g;
/**
 * Any shell's prompt, for when the learned shape stops matching (`sudo -i`,
 * `su`, another ssh hop). No `>`: REPLs (`>>>`, `mysql>`) end with it, and
 * psql's `db=#` is excluded too.
 */
const ANY_SHELL_PROMPT = /[$#%❯]\s*$/;
const NOT_A_SHELL = /=[#>]\s*$/;

/**
 * Replies xterm sends on its own (device attributes, cursor position, focus
 * and mouse reports) arrive through `onData` like typing; they are not the
 * user typing and must not count as such.
 */
export function isTerminalReport(data: string): boolean {
  return /^\x1b\[[?>]?[\d;]*[cRnIOt]$|^\x1b\[<[\d;]+[mM]$|^\x1b\[M[\s\S]{3}$|^\x1b\][\s\S]*(\x07|\x1b\\)$|^\x1bP[\s\S]*\x1b\\$/.test(data);
}

export class ShellWatcher {
  private shape: PromptShape | null = null;
  /** Where typing at the current prompt began (absolute buffer line). */
  private inputStart: { y: number; x: number } | null = null;
  private running: { command: string; startedAt: number; y: number } | null = null;
  private quietTimer = 0;
  private lastOutputAt = 0;
  private promptSeen = false;
  private typed = false;
  private integrated = false;
  private exitCode: number | null = null;
  /** Commands of a sequence still to run, each after the previous one ends. */
  private queue: string[] = [];
  /** With shell integration, the next step waits for the prompt (OSC 133;B). */
  private nextOnPrompt: string | null = null;

  constructor(
    private term: Terminal,
    private handlers: WatchHandlers,
    /** Sends input to this pane's shell only (never broadcast). */
    private write: (data: string) => void,
  ) {}

  attach(): IDisposable[] {
    return [
      this.term.parser.registerOscHandler(133, (data) => {
        this.integrated = true;
        const [mark, code] = data.split(";");
        if (mark === "B") {
          // Prompt drawn; typing starts here.
          this.inputStart = this.cursor();
          if (!this.promptSeen) this.firstPrompt();
          const next = this.nextOnPrompt;
          this.nextOnPrompt = null;
          if (next !== null) queueMicrotask(() => this.inject(next));
        } else if (mark === "D") {
          this.exitCode = code !== undefined && /^\d+$/.test(code) ? Number(code) : null;
          if (this.running) this.finish(this.cursor().y + 1);
        }
        return false; // other handlers may want it too
      }),
    ];
  }

  /** A new shell on this pane: forget the old one's state. */
  reset() {
    window.clearTimeout(this.quietTimer);
    this.inputStart = null;
    this.running = null;
    this.promptSeen = false;
    this.typed = false;
    this.queue = [];
    this.nextOnPrompt = null;
    this.exitCode = null;
  }

  dispose() {
    window.clearTimeout(this.quietTimer);
  }

  /** Something was typed (or injected) into this pane. */
  onInput(data: string) {
    this.typed = true;
    if (this.term.buffer.active.type === "alternate") {
      this.inputStart = null;
      return;
    }
    if (data.includes("\x03")) {
      // Ctrl+C: the line is abandoned; a running sequence stops.
      this.inputStart = null;
      this.queue = [];
      this.nextOnPrompt = null;
      return;
    }
    const clean = data.replace(PASTE_MARKS, "");
    const enter = clean.search(/[\r\n]/);
    if (!this.inputStart) this.inputStart = this.cursor();
    if (enter < 0) return;
    if (this.running && !this.shellChanged()) {
      this.inputStart = null; // Enter typed to a program, not the shell
      return;
    }
    // A chunk ending in Enter (a paste, an injected command) is not on screen
    // yet: what it adds comes from the chunk itself.
    const typedHere = clean.slice(0, enter).replace(/[\x00-\x1f\x7f]/g, "");
    this.submit(typedHere);
  }

  /** Output has been written to the terminal. */
  onOutput() {
    this.lastOutputAt = performance.now();
    window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => this.onQuiet(), QUIET_MS);
  }

  /**
   * What is typed at the shell prompt right now ("" on a fresh prompt), for
   * autocomplete — or null when the cursor isn't at the end of a line typed
   * at the shell's prompt: a program is running, the alternate screen is up,
   * the cursor is mid-line, or something follows it (zsh-autosuggestions and
   * fish draw their own suggestion there; theirs wins).
   */
  promptInput(): { text: string } | null {
    if (this.running || !this.promptSeen || this.term.buffer.active.type === "alternate") return null;
    const { x, y } = this.cursor();
    const line = this.logicalLine(y);
    const at = (y - line.start) * this.term.cols + x;
    // translateToString trims the right, which would eat a typed trailing space.
    const text = line.text.padEnd(at);
    if (text.slice(at).trim()) return null;
    if (this.inputStart) {
      if (this.inputStart.y < line.start || this.inputStart.y > y) return null;
      const from = (this.inputStart.y - line.start) * this.term.cols + this.inputStart.x;
      return from <= at ? { text: text.slice(from, at) } : null;
    }
    const before = text.slice(0, at);
    if (!this.integrated && (!this.shape || !matchesPrompt(before, this.shape))) return null;
    return { text: "" };
  }

  /** Runs commands one after another, each once the previous one is done. */
  run(commands: string[]) {
    if (commands.length === 0 || this.running) return;
    this.queue = commands.slice(1);
    this.inject(commands[0]);
  }

  private inject(command: string) {
    const data = `${command}\r`;
    this.onInput(data);
    this.write(data);
  }

  private cursor() {
    const buf = this.term.buffer.active;
    return { y: buf.baseY + buf.cursorY, x: buf.cursorX };
  }

  /** The logical (unwrapped) line holding absolute line `y`, and where it starts. */
  private logicalLine(y: number): { start: number; text: string } {
    const buf = this.term.buffer.active;
    let start = y;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let end = y;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    let text = "";
    for (let i = start; i <= end; i++) text += buf.getLine(i)?.translateToString(i === end) ?? "";
    return { start, text };
  }

  /**
   * While a command seems to be running, Enter at what looks like a new shell
   * prompt means the prompt came back looking different (`sudo -i` turned
   * `$` into `#`): the old command is over and the new prompt is learned.
   */
  private shellChanged(): boolean {
    if (this.integrated || !this.running || !this.inputStart) return false;
    const line = this.logicalLine(this.inputStart.y);
    const prompt = line.text.slice(0, (this.inputStart.y - line.start) * this.term.cols + this.inputStart.x);
    if (!ANY_SHELL_PROMPT.test(prompt) || NOT_A_SHELL.test(prompt)) return false;
    this.shape = promptShape(prompt);
    this.queue = [];
    this.finish(line.start);
    return true;
  }

  private submit(typedHere: string) {
    const start = this.inputStart ?? this.cursor();
    this.inputStart = null;
    const line = this.logicalLine(start.y);
    const offset = (start.y - line.start) * this.term.cols + start.x;
    const prompt = line.text.slice(0, offset);
    const command = (line.text.slice(offset) + typedHere).trim();
    if (!command) return;
    if (!this.shape) this.shape = promptShape(prompt);
    // Not the shell's prompt (a REPL, a password prompt): not a command.
    const atShell = this.integrated || (this.shape !== null && matchesPrompt(prompt, this.shape));
    this.exitCode = null;
    this.running = { command, startedAt: performance.now(), y: this.cursor().y };
    if (atShell) this.handlers.onCommandStart(command);
    else this.running.command = "";
  }

  private onQuiet() {
    if (this.term.buffer.active.type === "alternate") return;
    const { x, y } = this.cursor();
    if (x === 0) return;
    const line = this.logicalLine(y);
    const beforeCursor = line.text.slice(0, (y - line.start) * this.term.cols + x);
    if (!beforeCursor.trim() || line.text.slice(beforeCursor.length).trim()) return;

    if (!this.promptSeen && !this.running) {
      if (!this.shape) this.shape = promptShape(beforeCursor);
      this.firstPrompt();
      return;
    }
    if (this.integrated || !this.running || !this.shape) return;
    if (y === this.running.y || !matchesPrompt(beforeCursor, this.shape)) return;
    this.finish(line.start);
  }

  private firstPrompt() {
    this.promptSeen = true;
    if (!this.typed) this.handlers.onFirstPrompt();
  }

  /** The running command ended; its output is the lines up to `endY`. */
  private finish(endY: number) {
    const run = this.running;
    if (!run) return;
    this.running = null;
    const buf = this.term.buffer.active;
    const output: string[] = [];
    for (let i = Math.max(run.y + 1, endY - OUTPUT_LINES); i < endY; i++) {
      output.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    const endedAt = this.integrated ? performance.now() : Math.min(performance.now(), this.lastOutputAt);
    const exitCode = this.exitCode;
    if (run.command) {
      this.handlers.onCommandEnd({
        command: run.command,
        durationMs: Math.max(0, endedAt - run.startedAt),
        exitCode,
        output,
      });
    }
    const next = this.queue.shift();
    if (next === undefined) return;
    if (exitCode !== null && exitCode !== 0) {
      this.queue = []; // a failed step stops the sequence
      return;
    }
    if (this.integrated) this.nextOnPrompt = next;
    else this.inject(next);
  }
}
