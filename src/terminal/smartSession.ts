// Everything "smart" about one terminal pane, kept out of `TerminalView`:
// reading commands off the screen (`ShellWatcher`), remembering them per host,
// the suggestion chip (usual sequence, fix after an error), ghost-text
// autocomplete, and spotting long commands. The view owns React state and
// wording; this owns the behaviour.

import type { IDisposable, Terminal } from "@xterm/xterm";
import { getHost, updateHost } from "./memory";
import { GhostSuggest, type GhostStyle } from "./ghost";
import { ShellWatcher, type CommandResult } from "./shellWatch";
import {
  commandFailed,
  forgetCommand,
  isTrivial,
  normalizeCommand,
  predictCommand,
  recordCommand,
  sequenceKey,
  startSession,
  suggestFix,
  suggestSequence,
  type Fix,
} from "./smart";

/** A suggestion over the bottom of the pane; typing anything dismisses it. */
export type Chip = { kind: "sequence"; commands: string[] } | { kind: "fix"; fix: Fix };

export interface SmartDeps {
  hostId: () => string;
  /** Current settings and whether the pane is on screen. */
  options: () => { suggestions: boolean; longCommandSecs: number; visible: boolean };
  /** The shell is open and takes input. */
  isOpen: () => boolean;
  /** Input to this pane's shell only — never broadcast. */
  writeOwn: (data: string) => void;
  getChip: () => Chip | null;
  setChip: (chip: Chip | null) => void;
  showTabHint: () => void;
  hideTabHint: () => void;
  /** A command at least `longCommandSecs` long ended out of sight. */
  onLongCommand: (result: CommandResult) => void;
  focus: () => void;
}

export class SmartSession {
  private watcher: ShellWatcher;
  private ghost: GhostSuggest;
  /** The last non-trivial command of this shell, for "what comes next". */
  private lastCommand: string | null = null;

  constructor(
    term: Terminal,
    style: GhostStyle,
    private deps: SmartDeps,
  ) {
    this.watcher = new ShellWatcher(
      term,
      {
        onFirstPrompt: () => this.onFirstPrompt(),
        onCommandStart: (line) => this.onCommandStart(line),
        onCommandEnd: (result) => this.onCommandEnd(result),
      },
      deps.writeOwn,
    );
    this.ghost = new GhostSuggest(term, style, () => this.suggestion(), () => deps.showTabHint());
  }

  attach(): IDisposable[] {
    return this.watcher.attach();
  }

  dispose() {
    this.watcher.dispose();
    this.ghost.dispose();
  }

  /** A shell is connecting on this pane: forget the previous one. */
  reset() {
    this.watcher.reset();
    this.ghost.clear();
    this.lastCommand = null;
    this.deps.setChip(null);
  }

  /** The shell is open: start its session record. */
  opened() {
    if (this.deps.options().suggestions) updateHost(this.deps.hostId(), startSession);
  }

  /** Typing (not xterm's own replies) while the shell is open. */
  onInput(data: string) {
    if (this.deps.getChip()) this.dismissChip();
    this.ghost.onInput(data);
    this.watcher.onInput(data);
  }

  onOutput() {
    this.watcher.onOutput();
    this.ghost.schedule();
  }

  /**
   * Keys this feature takes from the shell; true when consumed. Alt+Enter
   * puts the chip's command at the prompt (never runs it); → / Ctrl+→ take
   * the ghost and otherwise reach the shell as usual. Never Alt+arrows: the
   * window's pane keys.
   */
  handleKey(e: KeyboardEvent): boolean {
    const key = e.key.toLowerCase();
    if (this.deps.getChip() && e.altKey && !e.ctrlKey && !e.shiftKey && key === "enter") {
      this.insertChip();
      return true;
    }
    if (this.ghost.visible && key === "arrowright" && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (this.ghost.accept(e.ctrlKey)) {
        this.deps.hideTabHint();
        return true;
      }
    }
    return false;
  }

  /** Only from a click on the chip's button: running is never one keystroke away. */
  runChip() {
    const chip = this.deps.getChip();
    if (chip?.kind !== "sequence" || !this.deps.isOpen()) return;
    this.deps.setChip(null);
    this.noteDismissed(chip, true);
    this.watcher.run(chip.commands);
    this.deps.focus();
  }

  /** Puts the fix (or a sequence's first command) at the prompt; Enter stays the user's. */
  insertChip() {
    const chip = this.deps.getChip();
    if (!chip || !this.deps.isOpen()) return;
    const command = chip.kind === "fix" ? chip.fix.command : chip.commands[0];
    this.deps.setChip(null);
    this.noteDismissed(chip, true);
    this.watcher.onInput(command);
    this.deps.writeOwn(command);
    this.deps.focus();
  }

  dismissChip() {
    this.noteDismissed(this.deps.getChip(), false);
    this.deps.setChip(null);
    this.deps.focus();
    this.ghost.schedule();
  }

  private suggestion(): { typed: string; command: string } | null {
    if (!this.deps.options().suggestions || this.deps.getChip() || !this.deps.isOpen()) return null;
    const input = this.watcher.promptInput();
    if (!input) return null;
    const command = predictCommand(getHost(this.deps.hostId()), input.text, this.lastCommand);
    return command ? { typed: input.text, command } : null;
  }

  private onFirstPrompt() {
    if (!this.deps.options().suggestions) return;
    const host = getHost(this.deps.hostId());
    const commands = suggestSequence(host.sessions, host.dismissed);
    if (commands) this.deps.setChip({ kind: "sequence", commands });
    else this.ghost.schedule();
  }

  private onCommandStart(line: string) {
    this.ghost.clear();
    if (!this.deps.options().suggestions) return;
    const cmd = normalizeCommand(line);
    if (!cmd) return;
    updateHost(this.deps.hostId(), (host) => recordCommand(host, cmd));
    if (!isTrivial(cmd)) this.lastCommand = cmd;
  }

  private onCommandEnd(result: CommandResult) {
    // The prompt is back (detected after the echo's own look): offer the next step.
    this.ghost.schedule();
    const { longCommandSecs: secs, visible, suggestions } = this.deps.options();
    if (secs > 0 && result.durationMs >= secs * 1000 && (!visible || !document.hasFocus())) {
      this.deps.onLongCommand(result);
    }
    if (!suggestions || result.exitCode === 0) return;
    // A typo or a failed attempt is not a habit: take back what its start recorded.
    const cmd = normalizeCommand(result.command);
    if (cmd && commandFailed(result.exitCode, result.output)) {
      updateHost(this.deps.hostId(), (host) => forgetCommand(host, cmd));
      if (this.lastCommand === cmd) this.lastCommand = null;
    }
    const fix = suggestFix(result.command, result.output, getHost(this.deps.hostId()).commands);
    if (fix) this.deps.setChip({ kind: "fix", fix });
  }

  /** A sequence chip that goes unused counts towards never offering it again. */
  private noteDismissed(chip: Chip | null, used: boolean) {
    if (chip?.kind !== "sequence") return;
    const key = sequenceKey(chip.commands);
    updateHost(this.deps.hostId(), (host) => {
      const dismissed = { ...host.dismissed };
      if (used) delete dismissed[key];
      else dismissed[key] = (dismissed[key] ?? 0) + 1;
      return { ...host, dismissed };
    });
  }
}
