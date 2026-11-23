// Host groups: one folder per host (WinSCP-style), shown as sections in the
// tunnel list and the terminal's host tree. Pure helpers, shared by both
// windows (`tests/groups.test.ts`).

import type { Tunnel } from "./types";

/** A section of hosts: a named group, or `null` for the ungrouped ones. */
export interface GroupSection<T> {
  name: string | null;
  items: T[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The group a host is filed under; blank counts as none. */
export function groupOf(tunnel: Pick<Tunnel, "group">): string | null {
  const name = tunnel.group?.trim();
  return name ? name : null;
}

/** Every group name in use, sorted the way sections are. */
export function groupNames(tunnels: Pick<Tunnel, "group">[]): string[] {
  const names = new Map<string, string>();
  for (const tun of tunnels) {
    const name = groupOf(tun);
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].sort(collator.compare);
}

/**
 * The spelling to store for a typed group: an existing group that matches
 * case-insensitively keeps its spelling ("pt" joins "PT"), blank is none.
 */
export function canonicalGroup(input: string, existing: string[]): string | null {
  const name = input.trim();
  if (!name) return null;
  return existing.find((g) => g.toLowerCase() === name.toLowerCase()) ?? name;
}

/**
 * Items split into sections: named groups sorted by name (numbers in
 * order: "Site 2" before "Site 10"), the ungrouped last. Items keep their
 * given order inside a section. Names compare case-insensitively.
 */
export function groupSections<T>(items: T[], group: (item: T) => string | null): GroupSection<T>[] {
  const named = new Map<string, GroupSection<T>>();
  const ungrouped: T[] = [];
  for (const item of items) {
    const name = group(item);
    if (!name) {
      ungrouped.push(item);
      continue;
    }
    const key = name.toLowerCase();
    const section = named.get(key) ?? { name, items: [] };
    section.items.push(item);
    named.set(key, section);
  }
  const sections = [...named.values()].sort((a, b) => collator.compare(a.name!, b.name!));
  if (ungrouped.length > 0) sections.push({ name: null, items: ungrouped });
  return sections;
}

/** Whether `tunnels` has any group at all: without one, no section headers. */
export function hasGroups(tunnels: Pick<Tunnel, "group">[]): boolean {
  return tunnels.some((tun) => groupOf(tun) !== null);
}

/** Stable key for a section's collapsed state ("" for the ungrouped one). */
export const sectionKey = (name: string | null) => (name ?? "").toLowerCase();

/** Collapsed sections, remembered per window; storage may be unavailable. */
export function loadCollapsedGroups(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(storageKey: string, collapsed: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
  } catch {
    // Only a convenience: it starts expanded next time.
  }
}
