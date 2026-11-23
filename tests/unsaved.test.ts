import { describe, expect, test } from "bun:test";
import { collectUnsaved, describeUnsaved } from "../src/terminal/files/unsaved";

describe("collectUnsaved", () => {
  const dirty: Record<string, string> = { b: "/etc/app.conf", d: "/home/u/notes.txt" };
  test("keeps order, skips clean and duplicate panes", () => {
    const got = collectUnsaved(["a", "b", "c", "d", "b"], (id) => dirty[id] ?? null);
    expect(got).toEqual([
      { paneId: "b", path: "/etc/app.conf" },
      { paneId: "d", path: "/home/u/notes.txt" },
    ]);
  });
  test("nothing dirty", () => {
    expect(collectUnsaved(["a"], () => null)).toEqual([]);
  });
});

describe("describeUnsaved", () => {
  test("host and file name per line", () => {
    const lines = describeUnsaved([{ paneId: "b", path: "/etc/app.conf" }], () => "root@web1");
    expect(lines).toEqual(["root@web1: app.conf"]);
  });
});
