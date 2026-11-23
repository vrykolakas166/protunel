import { expect, test } from "bun:test";
import { canonicalGroup, groupNames, groupSections, hasGroups } from "../src/groups";

const t = (name: string, group?: string | null) => ({ name, group: group ?? null });

test("sections: named groups by name, numbers in order, ungrouped last, order kept inside", () => {
  const items = [t("a", "Site 10"), t("b"), t("c", "site 2"), t("d", "Site 2"), t("e", "  ")];
  const sections = groupSections(items, (x) => x.group?.trim() || null);
  expect(sections.map((s) => s.name)).toEqual(["site 2", "Site 10", null]);
  expect(sections[0].items.map((x) => x.name)).toEqual(["c", "d"]);
  expect(sections[2].items.map((x) => x.name)).toEqual(["b", "e"]);
});

test("canonical group reuses an existing spelling; blank is none", () => {
  expect(canonicalGroup(" pt ", ["PT", "HCM"])).toBe("PT");
  expect(canonicalGroup("New", ["PT"])).toBe("New");
  expect(canonicalGroup("   ", ["PT"])).toBeNull();
});

test("group names are unique and sorted; hasGroups", () => {
  expect(groupNames([t("a", "b"), t("b", "A"), t("c", "B"), t("d")])).toEqual(["A", "b"]);
  expect(hasGroups([t("a"), t("b", " ")])).toBe(false);
  expect(hasGroups([t("a", "x")])).toBe(true);
});

import { hostTree } from "../src/terminal/HostTree";
import type { Tunnel } from "../src/types";

const host = (id: string, group: string | null, jump: string | null = null) =>
  ({ id, name: id, host: `${id}.lan`, username: "root", group, jumpTunnelId: jump }) as unknown as Tunnel;

test("host tree: a host nests under its jump host only in the same group", () => {
  const list = [host("vpn", "PT"), host("a", "PT", "vpn"), host("b", "HCM", "vpn"), host("c", null)];
  const { rows, sections } = hostTree(list, "", new Set(), new Set());
  expect(sections!.map((s) => [s.name, s.ids])).toEqual([
    ["HCM", ["b"]],
    ["PT", ["vpn", "a"]],
    [null, ["c"]],
  ]);
  const b = rows.find((r) => r.tunnel.id === "b")!;
  expect([b.depth, b.via]).toEqual([0, "vpn"]);
  const a = rows.find((r) => r.tunnel.id === "a")!;
  expect([a.depth, a.via]).toEqual([1, null]);
});

test("host tree: collapsed groups hide rows; a search ignores that and drops empty groups", () => {
  const list = [host("x", "PT"), host("y", "HCM")];
  const collapsed = hostTree(list, "", new Set(), new Set(["pt"]));
  expect(collapsed.rows.map((r) => r.tunnel.id)).toEqual(["y"]);
  expect(collapsed.sections!.find((s) => s.name === "PT")!.collapsed).toBe(true);
  const search = hostTree(list, "x.lan", new Set(), new Set(["pt"]));
  expect(search.sections!.map((s) => s.name)).toEqual(["PT"]);
  expect(search.rows.map((r) => r.tunnel.id)).toEqual(["x"]);
  // A group name matches every host in it.
  expect(hostTree(list, "hcm", new Set(), new Set()).rows.map((r) => r.tunnel.id)).toEqual(["y"]);
});

test("host tree without groups has no sections", () => {
  expect(hostTree([host("a", null)], "", new Set(), new Set()).sections).toBeNull();
});
