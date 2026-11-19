import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { MouseGate, splitTrackingModes } from "../src/terminal/mouseGate";

type Mode = Terminal["modes"]["mouseTrackingMode"];
const MODE_OF: Record<number, Mode> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };

/**
 * Just enough of xterm: `CSI ? … h/l` goes to the registered handlers, and
 * when none claims it the default applies tracking modes (and records the rest).
 */
function fakeTerminal() {
  const handlers: Record<string, ((p: number[]) => boolean)[]> = { h: [], l: [] };
  const other: string[] = [];
  const term = {
    modes: { mouseTrackingMode: "none" as Mode },
    parser: {
      registerCsiHandler(id: { final: string }, cb: (p: number[]) => boolean) {
        handlers[id.final].push(cb);
        return { dispose() {} };
      },
    },
    write(data: string, done?: () => void) {
      for (const [, list, final] of data.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
        const params = list.split(";").map(Number);
        if (handlers[final].some((cb) => cb(params))) continue;
        for (const p of params) {
          if (MODE_OF[p]) term.modes.mouseTrackingMode = final === "h" ? MODE_OF[p] : "none";
          else other.push(`${p}${final}`);
        }
      }
      done?.();
    },
  };
  return { term, other };
}

function setup(allowed: boolean) {
  const { term, other } = fakeTerminal();
  let changes = 0;
  const gate = new MouseGate(term as unknown as Terminal, allowed, () => changes++);
  gate.attach();
  return { term, other, gate, changes: () => changes };
}

test("splitTrackingModes", () => {
  expect(splitTrackingModes([1000, 1006, [1002], 25])).toEqual({ tracking: [1000, 1002], other: [1006, 25] });
});

describe("blocked (default)", () => {
  test("a program asking for the mouse does not get it", () => {
    const { term, gate } = setup(false);
    term.write("\x1b[?1000h\x1b[?1006h");
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(gate.wanted).toBe(true);
  });

  test("non-mouse modes in the same sequence still apply", () => {
    const { term, other } = setup(false);
    term.write("\x1b[?1002;1006;25h");
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(other).toEqual(["1006h", "25h"]);
  });

  test("the program letting go clears the request", () => {
    const { term, gate } = setup(false);
    term.write("\x1b[?1002h");
    term.write("\x1b[?1002l");
    expect(gate.wanted).toBe(false);
  });

  test("allowing later hands over the mouse at once", () => {
    const { term, gate } = setup(false);
    term.write("\x1b[?1003h");
    gate.setAllowed(true);
    expect(term.modes.mouseTrackingMode).toBe("any");
    expect(gate.wanted).toBe(false);
  });
});

describe("allowed", () => {
  test("the program gets the mouse", () => {
    const { term, gate } = setup(true);
    term.write("\x1b[?1000h");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    expect(gate.wanted).toBe(false);
  });

  test("blocking takes it back and remembers it for later", () => {
    const { term, gate } = setup(true);
    term.write("\x1b[?1002h");
    gate.setAllowed(false);
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(gate.wanted).toBe(true);
    gate.setAllowed(true);
    expect(term.modes.mouseTrackingMode).toBe("drag");
  });
});
