import { describe, expect, test } from "bun:test";
import {
  EDGE,
  INSET,
  MIN_SIZE,
  fitSize,
  freeAt,
  place,
  afterResize,
  maximizedBox,
  resizedFrom,
  snapCorner,
  type Box,
} from "../src/terminal/files/geometry";
import {
  baseName,
  crumbs,
  cwdFromOsc7,
  cwdFromPrompt,
  modeString,
  octal,
  parentPath,
  resolvePath,
  sortEntries,
  validName,
  viewKind,
} from "../src/terminal/files/paths";
import type { FileEntry } from "../src/types";

const win: Box = { x: 0, y: 0, w: 1200, h: 800 };
const pane: Box = { x: 600, y: 40, w: 600, h: 720 };

describe("geometry", () => {
  test("snapped to a corner of the owner pane", () => {
    const box = place({ kind: "snap", corner: "br" }, { w: 400, h: 300 }, pane, win);
    expect(box).toEqual({ x: 1200 - INSET - 400, y: 760 - INSET - 300, w: 400, h: 300 });
    const tl = place({ kind: "snap", corner: "tl" }, { w: 400, h: 300 }, pane, win);
    expect([tl.x, tl.y]).toEqual([600 + INSET, 40 + INSET]);
  });

  test("a panel wider than its pane stays inside the window", () => {
    const small: Box = { x: 1000, y: 40, w: 200, h: 200 };
    const box = place({ kind: "snap", corner: "tl" }, { w: 500, h: 300 }, small, win);
    expect(box.x + box.w).toBeLessThanOrEqual(1200 - EDGE);
  });

  test("size fits the window but never below the minimum when there is room", () => {
    expect(fitSize({ w: 5000, h: 5000 }, win)).toEqual({ w: 1200 - 2 * EDGE, h: 800 - 2 * EDGE });
    expect(fitSize({ w: 10, h: 10 }, win)).toEqual(MIN_SIZE);
    // A window smaller than the minimum: the window wins.
    expect(fitSize({ w: 10, h: 10 }, { x: 0, y: 0, w: 300, h: 200 })).toEqual({ w: 300 - 2 * EDGE, h: 200 - 2 * EDGE });
  });

  test("free placement round-trips and scales with the window", () => {
    const box = { x: 300, y: 200, w: 400, h: 300 };
    const free = freeAt(box, win);
    expect(place(free, box, pane, win)).toEqual(box);
    const wide = place(free, box, pane, { x: 0, y: 0, w: 1600, h: 800 });
    expect(wide.x).toBeGreaterThan(300);
  });

  test("snap engages close to a corner and holds until released", () => {
    const at = place({ kind: "snap", corner: "br" }, { w: 400, h: 300 }, pane, win);
    expect(snapCorner({ ...at, x: at.x - 10 }, pane, null)).toBe("br");
    expect(snapCorner({ ...at, x: at.x - 20 }, pane, null)).toBe(null);
    expect(snapCorner({ ...at, x: at.x - 20 }, pane, "br")).toBe("br");
    expect(snapCorner({ ...at, x: at.x - 30 }, pane, "br")).toBe(null);
  });

  test("resize from any edge or corner keeps the opposite side and the limits", () => {
    const start = { x: 100, y: 100, w: 400, h: 300 };
    expect(resizedFrom(start, "se", -1000, -1000, win)).toEqual({ x: 100, y: 100, ...MIN_SIZE });
    expect(resizedFrom(start, "se", 5000, 5000, win)).toEqual({ x: 100, y: 100, w: 1200 - EDGE - 100, h: 800 - EDGE - 100 });
    const nw = resizedFrom(start, "nw", -50, -20, win);
    expect([nw.x + nw.w, nw.y + nw.h]).toEqual([500, 400]);
    expect(resizedFrom(start, "w", -500, 0, win).x).toBe(EDGE);
    // An edge changes one dimension only.
    expect(resizedFrom(start, "n", 30, 10, win)).toEqual({ x: 100, y: 110, w: 400, h: 290 });
    expect(resizedFrom(start, "e", 30, 30, win)).toEqual({ x: 100, y: 100, w: 430, h: 300 });
  });

  test("a snap survives resizing away from its corner only", () => {
    const snap = { kind: "snap", corner: "br" } as const;
    const box = { x: 100, y: 100, w: 400, h: 300 };
    expect(afterResize(snap, "nw", box, win)).toBe(snap);
    expect(afterResize(snap, "n", box, win)).toBe(snap);
    expect(afterResize(snap, "e", box, win).kind).toBe("free");
    expect(afterResize(snap, "se", box, win).kind).toBe("free");
    expect(maximizedBox(win)).toEqual({ x: EDGE, y: EDGE, w: 1200 - 2 * EDGE, h: 800 - 2 * EDGE });
  });
});

describe("paths", () => {
  test("parent, base and crumbs", () => {
    expect(parentPath("/var/log/")).toBe("/var");
    expect(parentPath("/etc")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(baseName("/var/log")).toBe("log");
    expect(crumbs("/var/log").map((c) => c.path)).toEqual(["/", "/var", "/var/log"]);
  });

  test("typed paths resolve against home and the current folder", () => {
    expect(resolvePath("~", "/tmp", "/root")).toBe("/root");
    expect(resolvePath("~/app", "/tmp", "/root")).toBe("/root/app");
    expect(resolvePath("logs", "/var", "/root")).toBe("/var/logs");
    expect(resolvePath("/etc", "/var", "/root")).toBe("/etc");
  });

  test("names", () => {
    expect(validName("a.txt")).toBe(true);
    expect(validName("a/b")).toBe(false);
    expect(validName("..")).toBe(false);
    expect(validName("  ")).toBe(false);
  });

  test("shell directory from OSC 7 and from the prompt", () => {
    expect(cwdFromOsc7("file://web01/var/www/my%20site")).toBe("/var/www/my site");
    expect(cwdFromOsc7("nonsense")).toBe(null);
    expect(cwdFromPrompt("root@web01:/var/www# ")).toBe("/var/www");
    expect(cwdFromPrompt("admin@10.0.0.1:~/app$")).toBe("~/app");
    expect(cwdFromPrompt("admin@host:~$ ")).toBe("~");
    expect(cwdFromPrompt("[root@web01 www]# ")).toBe(null);
    expect(cwdFromPrompt("root@web01:/var/www# ls -la")).toBe(null);
  });

  test("permissions", () => {
    expect(modeString(0o755)).toBe("rwxr-xr-x");
    expect(modeString(0o4755)).toBe("rwsr-xr-x");
    expect(modeString(0o1777)).toBe("rwxrwxrwt");
    expect(modeString(0o644)).toBe("rw-r--r--");
    expect(octal(0o644)).toBe("0644");
  });

  test("folders first, hidden files on request, natural order", () => {
    const e = (name: string, kind: FileEntry["kind"] = "file", size = 0): FileEntry => ({
      name,
      kind,
      linkDir: false,
      size,
      mtime: null,
      mode: null,
      uid: null,
      gid: null,
    });
    const list = [e("b10.log"), e("b2.log"), e("logs", "dir"), e(".env"), { ...e("www", "symlink"), linkDir: true }];
    expect(sortEntries(list, "name", false, false, "").map((x) => x.name)).toEqual(["logs", "www", "b2.log", "b10.log"]);
    expect(sortEntries(list, "name", false, true, "").map((x) => x.name)[2]).toBe(".env");
    expect(sortEntries(list, "name", false, false, "B1").map((x) => x.name)).toEqual(["b10.log"]);
  });

  test("view kind", () => {
    expect(viewKind("nginx.conf")).toBe("text");
    expect(viewKind("Dockerfile")).toBe("text");
    expect(viewKind(".bashrc")).toBe("text");
    expect(viewKind("syslog.1")).toBe("unknown");
    expect(viewKind("logo.PNG")).toBe("image");
    expect(viewKind("app.tar.gz")).toBe("unknown");
  });
});
