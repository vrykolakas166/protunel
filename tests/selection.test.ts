import { describe, expect, test } from "bun:test";
import { applySelection } from "../src/terminal/files/selection";

const names = ["a", "b", "c", "d", "e"];
const set = (...n: string[]) => new Set(n);

describe("applySelection", () => {
  test("only replaces the selection and moves the anchor", () => {
    expect(applySelection(names, set("a", "b"), 0, 3, "only")).toEqual({ selected: set("d"), anchor: 3 });
  });

  test("toggle adds, then removes, and moves the anchor", () => {
    const added = applySelection(names, set("a"), 0, 2, "toggle");
    expect(added).toEqual({ selected: set("a", "c"), anchor: 2 });
    expect(applySelection(names, added.selected, added.anchor, 0, "toggle")).toEqual({
      selected: set("c"),
      anchor: 0,
    });
  });

  test("range selects anchor..index in either direction and keeps the anchor", () => {
    expect(applySelection(names, set("b"), 1, 3, "range")).toEqual({ selected: set("b", "c", "d"), anchor: 1 });
    expect(applySelection(names, set("d"), 3, 1, "range")).toEqual({ selected: set("b", "c", "d"), anchor: 3 });
  });

  test("range drops what was selected outside it", () => {
    expect(applySelection(names, set("a", "e"), 2, 2, "range").selected).toEqual(set("c"));
  });

  test("out-of-range index changes nothing", () => {
    expect(applySelection(names, set("a"), 0, 9, "only")).toEqual({ selected: set("a"), anchor: 0 });
  });

  test("does not mutate its input", () => {
    const sel = set("a");
    applySelection(names, sel, 0, 1, "toggle");
    expect(sel).toEqual(set("a"));
  });
});
