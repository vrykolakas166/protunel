import { describe, expect, test } from "bun:test";
import { EMPTY_HISTORY, MAX_RECENT, addRecent, moveTo, step, visit } from "../src/terminal/files/history";

describe("folder history", () => {
  test("visit, back, forward, and a new visit drops forward", () => {
    let h = visit(visit(visit(EMPTY_HISTORY, "/a"), "/b"), "/c");
    expect(h).toEqual({ stack: ["/a", "/b", "/c"], index: 2 });
    expect(step(h, 1)).toBeNull();
    const back = step(h, -1)!;
    expect(back).toEqual({ path: "/b", index: 1 });
    h = moveTo(h, back.index, back.path);
    expect(step(h, 1)).toEqual({ path: "/c", index: 2 });
    h = visit(h, "/d");
    expect(h).toEqual({ stack: ["/a", "/b", "/d"], index: 2 });
  });

  test("revisiting the current folder changes nothing", () => {
    const h = visit(EMPTY_HISTORY, "/a");
    expect(visit(h, "/a")).toBe(h);
  });

  test("history is capped", () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < 80; i++) h = visit(h, `/${i}`);
    expect(h.stack.length).toBe(50);
    expect(h.stack[49]).toBe("/79");
    expect(h.index).toBe(49);
  });

  test("recent folders: newest first, unique, capped", () => {
    let list: string[] = [];
    for (let i = 0; i < 15; i++) list = addRecent(list, `/${i}`);
    expect(list.length).toBe(MAX_RECENT);
    expect(addRecent(list, "/10")[0]).toBe("/10");
    expect(addRecent(list, "/10").filter((p) => p === "/10").length).toBe(1);
  });
});
