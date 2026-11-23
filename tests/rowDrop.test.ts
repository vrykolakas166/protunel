import { describe, expect, test } from "bun:test";
import { dropDirFor, dropLabelKey, isSameOrInside, nextSpeed, planDrop } from "../src/terminal/files/dropLogic";
import type { FileEntry } from "../src/types";

const entry = (name: string, kind: FileEntry["kind"]): FileEntry =>
  ({ name, kind, size: 0, mtime: null, mode: null }) as FileEntry;

describe("isSameOrInside", () => {
  test("itself, descendants, not siblings", () => {
    expect(isSameOrInside("/a/b", "/a/b")).toBe(true);
    expect(isSameOrInside("/a/b", "/a/b/")).toBe(true);
    expect(isSameOrInside("/a/b", "/a/b/c/d")).toBe(true);
    expect(isSameOrInside("/a/b", "/a/bc")).toBe(false);
    expect(isSameOrInside("/a/b", "/a")).toBe(false);
    expect(isSameOrInside("/", "/x")).toBe(true);
  });
});

describe("planDrop", () => {
  const src = (paths: string[], tunnelId = "A", dir = "/home") => ({ tunnelId, dir, paths });
  test("same tunnel moves, Ctrl copies", () => {
    expect(planDrop(src(["/home/f"]), { tunnelId: "A", dir: "/srv" }, false).kind).toBe("move");
    expect(planDrop(src(["/home/f"]), { tunnelId: "A", dir: "/srv" }, true).kind).toBe("copy");
  });
  test("another tunnel always copies across, even with Ctrl off", () => {
    expect(planDrop(src(["/home/f"]), { tunnelId: "B", dir: "/home" }, false).kind).toBe("across");
    expect(planDrop(src(["/home/f"]), { tunnelId: "B", dir: "/srv" }, true).kind).toBe("across");
  });
  test("a folder never goes into itself or a descendant", () => {
    const plan = (dir: string, ctrl: boolean) => planDrop(src(["/home/d"]), { tunnelId: "A", dir }, ctrl);
    expect(plan("/home/d", false)).toEqual({ kind: "none", reason: "into-self" });
    expect(plan("/home/d/sub", false)).toEqual({ kind: "none", reason: "into-self" });
    expect(plan("/home/d/sub", true)).toEqual({ kind: "none", reason: "into-self" });
  });
  test("a move into the current parent is refused, a copy there is allowed", () => {
    expect(planDrop(src(["/home/f", "/home/g"]), { tunnelId: "A", dir: "/home" }, false)).toEqual({
      kind: "none",
      reason: "same-folder",
    });
    expect(planDrop(src(["/home/f"]), { tunnelId: "A", dir: "/home" }, true).kind).toBe("copy");
  });
  test("nothing to drop", () => {
    expect(planDrop(src([]), { tunnelId: "A", dir: "/srv" }, false).kind).toBe("none");
  });
  test("a mixed move where one row already lives there still moves", () => {
    expect(planDrop(src(["/home/f", "/srv/g"]), { tunnelId: "A", dir: "/srv" }, false).kind).toBe("move");
  });
});

describe("dropDirFor / dropLabelKey", () => {
  test("folder row wins, files and gaps fall back to the open folder", () => {
    expect(dropDirFor("/a", entry("d", "dir"))).toBe("/a/d");
    expect(dropDirFor("/a", entry("f", "file"))).toBe("/a");
    expect(dropDirFor("/a", undefined)).toBe("/a");
    expect(dropDirFor("/", entry("d", "dir"))).toBe("/d");
  });
  test("label keys", () => {
    expect(dropLabelKey({ kind: "move" })).toBe("files.dropMove");
    expect(dropLabelKey({ kind: "copy" })).toBe("files.dropCopy");
    expect(dropLabelKey({ kind: "across" })).toBe("files.dropCopy");
    expect(dropLabelKey({ kind: "none", reason: "empty" })).toBeNull();
  });
});

describe("nextSpeed", () => {
  test("first reading has no speed, then bytes per second from deltas", () => {
    const a = nextSpeed(undefined, 0, 0);
    expect(a.speed).toBeNull();
    const b = nextSpeed(a, 1_000_000, 1000);
    expect(b.speed).toBe(1_000_000);
  });
  test("readings closer than the minimum interval are folded in later", () => {
    const a = nextSpeed(undefined, 0, 0);
    expect(nextSpeed(a, 500, 100)).toBe(a);
  });
  test("smooths and resets when progress goes backwards", () => {
    const a = nextSpeed(nextSpeed(undefined, 0, 0), 1000, 1000);
    const b = nextSpeed(a, 1000 + 3000, 2000);
    expect(b.speed).toBeCloseTo(1000 + 0.3 * 2000);
    expect(nextSpeed(b, 10, 3000).speed).toBeNull();
  });
});
