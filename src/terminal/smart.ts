// Terminal suggestions, pure functions only (tested in tests/smart.test.ts):
// what counts as a command worth remembering, the usual opening sequence of a
// host, and a fix for the output of a failed command. `TerminalView` reads
// commands off the screen and feeds them here; nothing below touches xterm.

import type { HostMemory } from "../types";

/** Commands kept per shell (in order, for "what comes next"), shells kept per host. */
export const SESSION_LENGTH = 40;
/** The opening of a shell, where the usual sequence is looked for. */
const OPENING = 8;
export const SESSIONS_KEPT = 20;
const SEQUENCE_WINDOW = 10;
const SEQUENCE_MAX = 4;
/** Dismissed this many times in a row: never offered again. */
export const DISMISS_LIMIT = 3;
const COMMANDS_KEPT = 300;
const MAX_COMMAND_LENGTH = 300;

/**
 * Typed but not worth replaying: looking around, leaving. They are skipped in
 * sequences so `ls; cd app; ls; git pull` and `cd app; git pull` agree.
 */
const TRIVIAL = /^(clear|cls|reset|exit|logout|pwd|history|ls|ll|la|l|dir|cd|cd ~|cd -|whoami|date|w|id|uptime)$/;

/**
 * Lines that look like they carry a credential. A leading space is the shell
 * convention (`HISTCONTROL=ignorespace`) for "don't remember this".
 */
const SECRETISH =
  /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|authorization|bearer|credential)s?\s*[=:]|--password|\bsshpass\b|\bmysql\b.*\s-p\S|\bcurl\b.*\s(-u|--user)\s|\bexport\s+\w*(KEY|TOKEN|SECRET|PASS)\w*=/i;

export function isSecretish(line: string): boolean {
  return line.startsWith(" ") || SECRETISH.test(line);
}

/** The command to remember for a typed line, or null to remember nothing. */
export function normalizeCommand(line: string): string | null {
  if (isSecretish(line)) return null;
  const cmd = line.trim().replace(/\s+/g, " ");
  if (!cmd || cmd.length > MAX_COMMAND_LENGTH) return null;
  return cmd;
}

export function isTrivial(cmd: string): boolean {
  return TRIVIAL.test(cmd);
}

/**
 * The shell's prompt, learned from the first command of a shell: its first
 * and last visible characters. Prompts change (cwd, git branch) but rarely at
 * both ends at once, and a REPL started from the shell (`python`, `mysql`)
 * has a prompt matching neither, so its lines are not taken for commands.
 */
export interface PromptShape {
  head: string;
  tail: string;
}

export function promptShape(prompt: string): PromptShape | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  return { head: trimmed.slice(0, Math.min(3, trimmed.length)), tail: trimmed.slice(-1) };
}

export function matchesPrompt(text: string, shape: PromptShape): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith(shape.head) || trimmed.endsWith(shape.tail);
}

export function emptyHost(): HostMemory {
  return { sessions: [], commands: {}, dismissed: {} };
}

/** Starts a shell's session record. */
export function startSession(host: HostMemory): HostMemory {
  // A shell where nothing was run leaves no record: reuse its empty slot, or
  // panes opened just to look would push real sessions out.
  const last = host.sessions[host.sessions.length - 1];
  if (last && last.length === 0) return host;
  return { ...host, sessions: [...host.sessions, []].slice(-SESSIONS_KEPT) };
}

/** Takes back a command recorded at its start once it turns out to have failed. */
export function forgetCommand(host: HostMemory, cmd: string): HostMemory {
  const commands = { ...host.commands };
  if (commands[cmd] !== undefined) {
    if (commands[cmd] <= 1) delete commands[cmd];
    else commands[cmd] -= 1;
  }
  const sessions = [...host.sessions];
  const current = sessions[sessions.length - 1];
  if (current) {
    const at = current.lastIndexOf(cmd);
    if (at >= 0) sessions[sessions.length - 1] = [...current.slice(0, at), ...current.slice(at + 1)];
  }
  return { ...host, commands, sessions };
}

const FAILURE =
  /command not found|: not found$|no such file or directory|invalid option|unrecognized option|unknown (option|command)|^usage:|permission denied|operation not permitted/im;

/** Exit code when the shell reports it, otherwise the usual error wording. */
export function commandFailed(exitCode: number | null, output: string[]): boolean {
  return exitCode !== null ? exitCode !== 0 : FAILURE.test(output.join("\n"));
}

/** Adds one command to the newest session and to the command counts. */
export function recordCommand(host: HostMemory, cmd: string): HostMemory {
  const commands = { ...host.commands, [cmd]: (host.commands[cmd] ?? 0) + 1 };
  const names = Object.keys(commands);
  if (names.length > COMMANDS_KEPT) {
    // Forget the least used first.
    names
      .sort((a, b) => commands[a] - commands[b])
      .slice(0, names.length - COMMANDS_KEPT)
      .forEach((name) => delete commands[name]);
  }
  let sessions = host.sessions;
  const current = sessions[sessions.length - 1];
  if (current && !isTrivial(cmd) && current.length < SESSION_LENGTH) {
    sessions = [...sessions.slice(0, -1), [...current, cmd]];
  }
  return { ...host, commands, sessions };
}

export const sequenceKey = (cmds: string[]) => cmds.join("\n");

/**
 * What recent shells on this host usually run first: the commands found in
 * at least 40% (and at least 2) of the last 10 sessions, in the order they
 * tend to come, up to 4. Order and the commands around them may differ from
 * shell to shell — habits are rarely typed identically. A sequence dismissed
 * 3 times in a row loses its least common command until one is left that
 * wasn't.
 */
export function suggestSequence(sessions: string[][], dismissed: Record<string, number>): string[] | null {
  const recent = sessions
    .filter((s) => s.length > 0)
    .slice(-SEQUENCE_WINDOW)
    .map((s) => s.slice(0, OPENING));
  const need = Math.max(2, Math.ceil(recent.length * 0.4));
  const support = new Map<string, number>();
  const position = new Map<string, number>();
  for (const session of recent) {
    const seen = new Set<string>();
    session.forEach((cmd, i) => {
      if (seen.has(cmd)) return;
      seen.add(cmd);
      support.set(cmd, (support.get(cmd) ?? 0) + 1);
      position.set(cmd, (position.get(cmd) ?? 0) + i / Math.max(1, session.length - 1));
    });
  }
  const common = [...support.entries()]
    .filter(([, count]) => count >= need)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEQUENCE_MAX)
    .map(([cmd]) => cmd);
  // Least common last, so it is the one dropped after dismissals.
  while (common.length > 0) {
    const ordered = [...common].sort((a, b) => position.get(a)! / support.get(a)! - position.get(b)! / support.get(b)!);
    if ((dismissed[sequenceKey(ordered)] ?? 0) < DISMISS_LIMIT) return ordered;
    common.pop();
  }
  return null;
}

/**
 * Autocomplete: the remembered command to complete `prefix` with, shown as
 * ghost text after the cursor. Commands seen right after `previous` (the
 * last command of this shell; null at its start) count heavily, then plain
 * use counts. An empty prefix — a fresh prompt — only gets the command that
 * followed `previous` at least twice: a guess at the next step, not noise.
 */
export function predictCommand(host: HostMemory, prefix: string, previous: string | null): string | null {
  const follows = new Map<string, number>();
  for (const session of host.sessions) {
    session.forEach((cmd, i) => {
      if ((i === 0 ? null : session[i - 1]) === previous) follows.set(cmd, (follows.get(cmd) ?? 0) + 1);
    });
  }
  if (!prefix) {
    let best: string | null = null;
    let bestCount = 1;
    for (const [cmd, count] of follows) {
      if (cmd !== previous && count > bestCount) {
        best = cmd;
        bestCount = count;
      }
    }
    return best;
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const [cmd, count] of Object.entries(host.commands)) {
    if (cmd.length <= prefix.length || !cmd.startsWith(prefix)) continue;
    const score = count + 5 * (follows.get(cmd) ?? 0);
    if (score > bestScore || (score === bestScore && best !== null && cmd.length < best.length)) {
      best = cmd;
      bestScore = score;
    }
  }
  return best;
}

/** The next word of a ghost suggestion (Ctrl+→), with the space before it. */
export function nextWord(rest: string): string {
  return rest.match(/^\s*\S+/)?.[0] ?? rest;
}

export type FixReason = "sudo" | "typo" | "hint";

export interface Fix {
  command: string;
  reason: FixReason;
}

/** Commands worth correcting a typo towards even before the host taught us any. */
const COMMON = [
  "git", "docker", "kubectl", "systemctl", "journalctl", "sudo", "grep", "tail", "less", "cat",
  "vim", "nano", "ls", "cd", "cp", "mv", "rm", "mkdir", "find", "curl", "ps", "top", "htop",
  "df", "du", "free", "make", "npm", "yarn", "python3", "pip", "apt", "tmux", "ssh", "scp",
];

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** The closest known program name to a mistyped one, if close enough. */
function closestProgram(typo: string, known: Record<string, number>): string | null {
  const uses = new Map<string, number>();
  for (const [cmd, count] of Object.entries(known)) {
    const name = cmd.split(" ")[0];
    if (name !== "sudo") uses.set(name, (uses.get(name) ?? 0) + count);
  }
  for (const name of COMMON) if (!uses.has(name)) uses.set(name, 0);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [name, count] of uses) {
    if (name === typo) continue;
    const distance = editDistance(typo, name);
    const limit = typo.length <= 3 ? 1 : 2;
    if (distance > limit) continue;
    // Closer wins; among equals, the one used more on this host.
    const score = distance * 1000 - count;
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

const PERMISSION =
  /permission denied|operation not permitted|\bEACCES\b|are you root\?|must be (run as )?root|requires? (root|superuser)|only root can/i;

/**
 * A corrected command for what `cmd` printed (`output`, the lines between the
 * command and the next prompt), or null. Programs that print their own fix
 * (git, command-not-found, `git push` without upstream) are taken at their
 * word; otherwise a permission error means sudo and an unknown program a typo.
 */
export function suggestFix(cmd: string, output: string[], known: Record<string, number>): Fix | null {
  const text = output.join("\n");
  const words = cmd.split(" ");

  // git: "The most similar command is\n\tstatus"
  const similar = text.match(/The most similar commands? (?:is|are)\s*\n\s+(\S+)/);
  if (similar && words[0] === "git" && words.length >= 2) {
    return { command: ["git", similar[1], ...words.slice(2)].join(" "), reason: "typo" };
  }

  // A program spelling out the exact command to run.
  const hint =
    text.match(/^\s*(git push --set-upstream \S+ \S+)\s*$/m) ??
    text.match(/^\s*((?:sudo )?(?:apt|apt-get|dnf|yum|zypper|apk|snap) install \S+)\s*$/m) ??
    text.match(/^\s*((?:sudo )?pacman -S \S+)\s*$/m);
  if (hint && hint[1] !== cmd) return { command: hint[1], reason: "hint" };

  const notFound = text.match(/command not found: (\S+)|(\S+): command not found$|^(?:\S+: )?(\S+): not found$/m);
  if (notFound) {
    const typo = notFound[1] ?? notFound[2] ?? notFound[3];
    const sudo = words[0] === "sudo";
    const at = sudo ? 1 : 0;
    if (typo && words[at] === typo) {
      const fixed = closestProgram(typo, known);
      if (fixed) {
        const next = [...words];
        next[at] = fixed;
        return { command: next.join(" "), reason: "typo" };
      }
    }
    return null;
  }

  // "Permission denied (publickey)" is ssh refusing a login: sudo won't help.
  if (PERMISSION.test(text) && !/permission denied \(publickey/i.test(text) && words[0] !== "sudo") {
    return { command: `sudo ${cmd}`, reason: "sudo" };
  }
  return null;
}
