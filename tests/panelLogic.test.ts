import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIZE,
  firstGeometry,
  gripBox,
  parseFilesGeometry,
  type Box,
} from "../src/terminal/files/geometry";
import {
  canPasteClip,
  deleteConfirmed,
  deleteNeedsTyping,
  jumpIndex,
  knownErrorCode,
  nextSort,
  pageRows,
  pathsIn,
  stepCursor,
} from "../src/terminal/files/panelLogic";

describe("errors", () => {
  test("known codes are returned, others null", () => {
    expect(knownErrorCode("conflict")).toBe("conflict");
    expect(knownErrorCode(new Error("boom"))).toBeNull();
    expect(knownErrorCode("Permission denied")).toBeNull();
  });
});

describe("clipboard and paths", () => {
  test("cut stays on its server, copy goes anywhere", () => {
    expect(canPasteClip(null, "a")).toBe(false);
    expect(canPasteClip({ tunnelId: "a", cut: true }, "a")).toBe(true);
    expect(canPasteClip({ tunnelId: "a", cut: true }, "b")).toBe(false);
    expect(canPasteClip({ tunnelId: "a", cut: false }, "b")).toBe(true);
  });
  test("pathsIn joins, or is empty without a folder", () => {
    expect(pathsIn("/srv", ["a", "b"])).toEqual(["/srv/a", "/srv/b"]);
    expect(pathsIn("/", new Set(["x"]))).toEqual(["/x"]);
    expect(pathsIn(null, ["a"])).toEqual([]);
    expect(pathsIn("", ["a"])).toEqual([]);
  });
});

describe("list navigation", () => {
  test("nextSort flips the same column, resets another", () => {
    expect(nextSort({ key: "name", desc: false }, "name")).toEqual({ key: "name", desc: true });
    expect(nextSort({ key: "name", desc: true }, "name")).toEqual({ key: "name", desc: false });
    expect(nextSort({ key: "name", desc: true }, "size")).toEqual({ key: "size", desc: false });
  });
  test("stepCursor clamps", () => {
    expect(stepCursor(2, 1, 5)).toBe(3);
    expect(stepCursor(0, -1, 5)).toBe(0);
    expect(stepCursor(3, 99, 5)).toBe(4);
    expect(stepCursor(3, -99, 5)).toBe(0);
  });
  test("pageRows is a screenful less one, at least one", () => {
    expect(pageRows(280, 28)).toBe(9);
    expect(pageRows(10, 28)).toBe(1);
    expect(pageRows(0, 28)).toBe(1);
  });
  test("jumpIndex finds the next match after the cursor and wraps", () => {
    const names = ["alpha", "beta", "Bravo", "charlie"];
    expect(jumpIndex(names, 0, "b")).toBe(1);
    expect(jumpIndex(names, 1, "b")).toBe(2);
    expect(jumpIndex(names, 2, "b")).toBe(1);
    expect(jumpIndex(names, 3, "A")).toBe(0);
    expect(jumpIndex(names, 0, "z")).toBe(-1);
    expect(jumpIndex([], 0, "a")).toBe(-1);
  });
});

describe("delete confirmation", () => {
  test("typing is needed from the threshold, or when counting stopped early", () => {
    expect(deleteNeedsTyping(null, 100)).toBe(false);
    expect(deleteNeedsTyping({ files: 50, dirs: 49, more: false }, 100)).toBe(false);
    expect(deleteNeedsTyping({ files: 50, dirs: 50, more: false }, 100)).toBe(true);
    expect(deleteNeedsTyping({ files: 1, dirs: 0, more: true }, 100)).toBe(true);
  });
  test("confirmed needs a count, and the typed name when required", () => {
    const small = { files: 2, dirs: 0, more: false };
    const big = { files: 500, dirs: 0, more: false };
    expect(deleteConfirmed(null, "", "x", 100)).toBe(false);
    expect(deleteConfirmed(small, "", "x", 100)).toBe(true);
    expect(deleteConfirmed(big, "", "x", 100)).toBe(false);
    expect(deleteConfirmed(big, "  x ", "x", 100)).toBe(true);
    expect(deleteConfirmed(big, "X", "x", 100)).toBe(false);
  });
});

describe("panel geometry", () => {
  test("firstGeometry keeps a snapped corner, else bottom-right, and the size", () => {
    const size = { w: 500, h: 400 };
    expect(firstGeometry({ placement: { kind: "snap", corner: "tl" }, size })).toEqual({ placement: { kind: "snap", corner: "tl" }, size });
    expect(firstGeometry({ placement: { kind: "free", fx: 0.2, fy: 0.3 }, size, maximized: true })).toEqual({
      placement: { kind: "snap", corner: "br" },
      size,
    });
  });
  test("parseFilesGeometry validates and upgrades the old default", () => {
    expect(parseFilesGeometry(null)).toBeNull();
    expect(parseFilesGeometry("not json")).toBeNull();
    expect(parseFilesGeometry(JSON.stringify({ placement: { kind: "snap", corner: "tl" }, size: { w: 0, h: 5 } }))).toBeNull();
    expect(parseFilesGeometry(JSON.stringify({ size: { w: 400, h: 300 } }))).toBeNull();
    const ok = { placement: { kind: "snap", corner: "tr" }, size: { w: 400, h: 300 } };
    expect(parseFilesGeometry(JSON.stringify(ok))).toEqual(ok as never);
    expect(parseFilesGeometry(JSON.stringify({ ...ok, size: { w: 760, h: 520 } }))?.size).toEqual(DEFAULT_SIZE);
  });
  test("gripBox straddles each edge and corner", () => {
    const box: Box = { x: 100, y: 50, w: 300, h: 200 };
    expect(gripBox("n", box)).toEqual({ left: 108, width: 284, height: 8, top: 46 });
    expect(gripBox("s", box)).toEqual({ left: 108, width: 284, height: 8, top: 246 });
    expect(gripBox("w", box)).toEqual({ top: 58, height: 184, width: 8, left: 96 });
    expect(gripBox("e", box)).toEqual({ top: 58, height: 184, width: 8, left: 396 });
    expect(gripBox("nw", box)).toEqual({ width: 16, height: 16, left: 92, top: 42 });
    expect(gripBox("se", box)).toEqual({ width: 16, height: 16, left: 392, top: 242 });
  });
});
