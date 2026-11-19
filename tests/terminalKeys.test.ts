import { describe, expect, test } from "bun:test";
import { matchShortcut, strayKeyAction } from "../src/terminal/shortcuts";

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("strayKeyAction in the terminal", () => {
  test.each([
    ["F5 (reload)", key("F5")],
    ["F7 (caret browsing)", key("F7")],
    ["F12 (devtools)", key("F12")],
    ["Ctrl+R (reload)", key("r", { ctrl: true })],
    ["Ctrl+Shift+R (hard reload)", key("R", { ctrl: true, shift: true })],
    ["Ctrl+Shift+I (devtools)", key("I", { ctrl: true, shift: true })],
    ["Ctrl+= (zoom)", key("=", { ctrl: true })],
    ["Ctrl+0 (zoom reset)", key("0", { ctrl: true })],
    ["Ctrl+P (print)", key("p", { ctrl: true })],
    ["Cmd+F", key("f", { meta: true })],
  ])("cancels %s", (_, e) => expect(strayKeyAction(e, "terminal")).toBe("cancel"));

  test.each([
    ["a letter", key("a")],
    ["Shift+letter", key("A", { shift: true })],
    ["AltGr+Q (@ on German)", key("@", { ctrl: true, alt: true })],
    ["AltGr+E (€)", key("€", { ctrl: true, alt: true })],
    ["Space", key(" ")],
    ["Enter", key("Enter")],
  ])("lets %s through", (_, e) => expect(strayKeyAction(e, "terminal")).toBe("pass"));
});

describe("strayKeyAction in a text field", () => {
  test.each(["a", "c", "v", "x", "z", "y", "ArrowLeft", "Backspace"])("keeps Ctrl+%s for editing", (k) =>
    expect(strayKeyAction(key(k, { ctrl: true }), "textField")).toBe("pass"),
  );
  test("keeps plain typing", () => expect(strayKeyAction(key("k"), "textField")).toBe("pass"));
  test.each(["r", "f", "p", "="])("cancels Ctrl+%s", (k) =>
    expect(strayKeyAction(key(k, { ctrl: true }), "textField")).toBe("cancel"),
  );
  test("cancels F5", () => expect(strayKeyAction(key("F5"), "textField")).toBe("cancel"));
});

describe("strayKeyAction elsewhere", () => {
  test.each([key(" "), key("Tab"), key("a"), key("F5")])("hands focus back to the shell (%o)", (e) =>
    expect(strayKeyAction(e, "other")).toBe("refocus"),
  );
});

describe("matchShortcut", () => {
  const ev = (k: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
    ({ key: k, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false }) as KeyboardEvent;

  test("Ctrl+Shift+S toggles the sidebar", () =>
    expect(matchShortcut(ev("S", "KeyS", { ctrl: true, shift: true }))).toEqual({ kind: "toggleSidebar" }));
  test("plain Ctrl+S stays with the shell (XOFF)", () =>
    expect(matchShortcut(ev("s", "KeyS", { ctrl: true }))).toBeNull());
  test("plain Ctrl+B stays with the shell (tmux prefix)", () =>
    expect(matchShortcut(ev("b", "KeyB", { ctrl: true }))).toBeNull());
});
