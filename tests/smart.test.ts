import { describe, expect, test } from "bun:test";
import {
  emptyHost,
  matchesPrompt,
  normalizeCommand,
  promptShape,
  recordCommand,
  commandFailed,
  forgetCommand,
  startSession,
  suggestFix,
  suggestSequence,
} from "../src/terminal/smart";

describe("normalizeCommand", () => {
  test("keeps ordinary commands, collapsing spaces", () => {
    expect(normalizeCommand("git   pull  ")).toBe("git pull");
  });
  test("drops lines that look like secrets", () => {
    expect(normalizeCommand(" export X=1")).toBeNull();
    expect(normalizeCommand("mysql -u root -phunter2")).toBeNull();
    expect(normalizeCommand("curl -u admin:pw https://x")).toBeNull();
    expect(normalizeCommand("export API_TOKEN=abc")).toBeNull();
    expect(normalizeCommand("app --password=abc")).toBeNull();
  });
  test("drops empty lines", () => {
    expect(normalizeCommand("   ")).toBeNull();
  });
});

describe("prompt shape", () => {
  test("bash prompt with a new cwd still matches", () => {
    const shape = promptShape("deploy@web-1:~$ ")!;
    expect(matchesPrompt("deploy@web-1:/srv/app$ ", shape)).toBe(true);
  });
  test("a REPL prompt does not", () => {
    const shape = promptShape("deploy@web-1:~$ ")!;
    expect(matchesPrompt(">>> ", shape)).toBe(false);
    expect(matchesPrompt("mysql> ", shape)).toBe(false);
  });
  test("oh-my-zsh prompt whose tail changes still matches by its head", () => {
    const shape = promptShape("➜  app git:(main) ")!;
    expect(matchesPrompt("➜  app git:(main) ✗ ", shape)).toBe(true);
  });
});

describe("recordCommand", () => {
  test("skips trivial commands in the session but counts them", () => {
    let host = startSession(emptyHost());
    host = recordCommand(host, "ls");
    host = recordCommand(host, "cd /srv/app");
    expect(host.sessions).toEqual([["cd /srv/app"]]);
    expect(host.commands.ls).toBe(1);
  });
});

describe("sessions", () => {
  test("an empty session is reused, not stacked", () => {
    const host = startSession(startSession(emptyHost()));
    expect(host.sessions).toEqual([[]]);
  });
  test("a failed command is taken back", () => {
    let host = startSession(emptyHost());
    host = recordCommand(host, "dokcer ps");
    host = forgetCommand(host, "dokcer ps");
    expect(host.sessions).toEqual([[]]);
    expect(host.commands["dokcer ps"]).toBeUndefined();
  });
  test("failure without an exit code is read from the output", () => {
    expect(commandFailed(null, ["bash: dokcer: command not found"])).toBe(true);
    expect(commandFailed(null, ["Filesystem  Size"])).toBe(false);
    expect(commandFailed(1, [])).toBe(true);
    expect(commandFailed(0, ["No such file or directory"])).toBe(false);
  });
});

describe("suggestSequence", () => {
  test("commands common to recent shells, in their usual order", () => {
    const sessions = [
      ["cd /srv/app", "git pull", "docker compose logs -f"],
      ["cd /srv/app", "git pull", "make"],
      ["cd /srv/app", "git pull", "docker compose logs -f"],
      ["top"],
    ];
    expect(suggestSequence(sessions, {})).toEqual(["cd /srv/app", "git pull", "docker compose logs -f"]);
  });
  test("the same habit typed in a different order and among other commands", () => {
    // From a real terminal_memory.json: no two sessions open the same way.
    const sessions = [
      ["df -h", "cd /opt/app/", "cat docker-compose.yml"],
      ["docker ps", "cd /opt/app/", "cat docker-compose.yml"],
      ["cd /opt/app/"],
      ["df -h", "cd /opt/x", "docker ps"],
    ];
    const seq = suggestSequence(sessions, {})!;
    expect(seq.indexOf("cd /opt/app/")).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf("cat docker-compose.yml")).toBeGreaterThan(seq.indexOf("cd /opt/app/"));
    expect(seq).not.toContain("cd /opt/x");
  });
  test("one session is not a habit", () => {
    expect(suggestSequence([["a"], []], {})).toBeNull();
  });
  test("skips a sequence dismissed three times, falling back to a shorter one", () => {
    const sessions = [["a", "b"], ["a", "b"], ["a", "b"]];
    expect(suggestSequence(sessions, { "a\nb": 3 })).toEqual(["a"]);
  });
});

describe("suggestFix", () => {
  test("permission denied suggests sudo", () => {
    expect(suggestFix("systemctl restart nginx", ["Failed: Access denied", "Permission denied"], {})).toEqual({
      command: "sudo systemctl restart nginx",
      reason: "sudo",
    });
  });
  test("ssh publickey refusal is not a sudo case", () => {
    expect(suggestFix("ssh x", ["git@x: Permission denied (publickey)."], {})).toBeNull();
  });
  test("already sudo: nothing", () => {
    expect(suggestFix("sudo cat /x", ["Permission denied"], {})).toBeNull();
  });
  test("git's own suggestion", () => {
    const out = ["git: 'stauts' is not a git command. See 'git --help'.", "", "The most similar command is", "\tstatus"];
    expect(suggestFix("git stauts -s", out, {})).toEqual({ command: "git status -s", reason: "typo" });
  });
  test("git push upstream hint", () => {
    const out = [
      "fatal: The current branch feat has no upstream branch.",
      "To push the current branch and set the remote as upstream, use",
      "",
      "    git push --set-upstream origin feat",
    ];
    expect(suggestFix("git push", out, {})?.command).toBe("git push --set-upstream origin feat");
  });
  test("command-not-found install hint", () => {
    const out = ["Command 'htop' not found, but can be installed with:", "sudo apt install htop"];
    expect(suggestFix("htop", out, {})).toEqual({ command: "sudo apt install htop", reason: "hint" });
  });
  test("typo of a known program", () => {
    expect(suggestFix("dokcer ps", ["bash: dokcer: command not found"], {})).toEqual({
      command: "docker ps",
      reason: "typo",
    });
    expect(suggestFix("sudo sytemctl status", ["sudo: sytemctl: command not found"], {})?.command).toBe(
      "sudo systemctl status",
    );
  });
  test("prefers the program used on this host", () => {
    expect(suggestFix("kubctl get pods", ["zsh: command not found: kubctl"], { "kubectl get pods": 9 })?.command).toBe(
      "kubectl get pods",
    );
  });
  test("unknown program with nothing close: nothing", () => {
    expect(suggestFix("qqqqqq", ["bash: qqqqqq: command not found"], {})).toBeNull();
  });
});

import { paneIds, reviveLayout, type LayoutNode } from "../src/terminal/layout";

describe("reviveLayout", () => {
  const saved: LayoutNode = {
    kind: "split",
    id: "s",
    dir: "row",
    ratio: 0.3,
    a: { kind: "pane", id: "p1", tunnelId: "web" },
    b: { kind: "pane", id: "p2", tunnelId: "db" },
  };
  test("fresh ids, same shape", () => {
    const live = reviveLayout(saved, () => true)!;
    expect(live.kind).toBe("split");
    expect(paneIds(live)).toHaveLength(2);
    expect(paneIds(live)).not.toContain("p1");
    expect(live.kind === "split" && live.ratio).toBe(0.3);
  });
  test("a deleted host's pane is dropped, its sibling takes the space", () => {
    const live = reviveLayout(saved, (id) => id === "db")!;
    expect(live.kind === "pane" && live.tunnelId).toBe("db");
  });
  test("garbage is null", () => {
    expect(reviveLayout({ kind: "nope" }, () => true)).toBeNull();
    expect(reviveLayout(null, () => true)).toBeNull();
  });
});

import { isTerminalReport } from "../src/terminal/shellWatch";

describe("isTerminalReport", () => {
  test("xterm's own replies", () => {
    expect(isTerminalReport("\x1b[?1;2c")).toBe(true);
    expect(isTerminalReport("\x1b[12;40R")).toBe(true);
    expect(isTerminalReport("\x1b[I")).toBe(true);
    expect(isTerminalReport("\x1b[<0;10;5M")).toBe(true);
  });
  test("typing is not", () => {
    expect(isTerminalReport("l")).toBe(false);
    expect(isTerminalReport("\r")).toBe(false);
    expect(isTerminalReport("\x1b[A")).toBe(false); // arrow up
    expect(isTerminalReport("\x1b")).toBe(false);
  });
});

import { nextWord, predictCommand } from "../src/terminal/smart";

describe("predictCommand", () => {
  const host = {
    sessions: [
      ["cd /srv/app", "git pull", "docker compose up -d"],
      ["cd /srv/app", "git pull", "docker compose logs -f"],
      ["cd /srv/app", "git status"],
    ],
    commands: {
      "cd /srv/app": 3,
      "git pull": 2,
      "git status": 1,
      "docker compose up -d": 1,
      "docker compose logs -f": 4,
    },
    dismissed: {},
  };
  test("completes a prefix with the most used command", () => {
    expect(predictCommand(host, "docker c", null)).toBe("docker compose logs -f");
  });
  test("what usually follows the previous command wins", () => {
    expect(predictCommand(host, "git ", "cd /srv/app")).toBe("git pull");
  });
  test("a fresh prompt gets the usual next step, if seen twice", () => {
    expect(predictCommand(host, "", "cd /srv/app")).toBe("git pull");
    expect(predictCommand(host, "", null)).toBe("cd /srv/app");
    expect(predictCommand(host, "", "git status")).toBeNull();
  });
  test("nothing for a full match or unknown prefix", () => {
    expect(predictCommand(host, "git pull", null)).toBeNull();
    expect(predictCommand(host, "kubectl", null)).toBeNull();
  });
  test("nextWord", () => {
    expect(nextWord("compose logs -f")).toBe("compose");
    expect(nextWord(" logs -f")).toBe(" logs");
  });
});
