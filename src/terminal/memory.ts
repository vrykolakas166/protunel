// The terminal window's copy of `terminal_memory.json`: loaded once, changed
// in place, written back (debounced) through Rust. Panes record commands into
// it; the window reads workspaces from it via `useTerminalMemory`.

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getTerminalMemory, saveTerminalMemory } from "../api";
import type { HostMemory, TerminalMemory, Workspace } from "../types";
import { emptyHost } from "./smart";

/** Workspace id of the tabs open when the window last closed. */
export const LAST_SESSION_ID = "last-session";

let memory: TerminalMemory = { hosts: {}, workspaces: [] };
let loaded: Promise<void> | null = null;
const subscribers = new Set<() => void>();
let saveTimer = 0;

function emit() {
  subscribers.forEach((fn) => fn());
}

/** Loads once; later calls share the first load. */
export function loadMemory(): Promise<void> {
  if (!loaded) {
    loaded = getTerminalMemory()
      .then((m) => {
        memory = { hosts: m.hosts ?? {}, workspaces: m.workspaces ?? [] };
        emit();
      })
      .catch(() => {});
    // "Forget remembered commands" in the main window's settings.
    void listen("terminal-memory-cleared", () => {
      memory = { ...memory, hosts: {} };
      emit();
    });
  }
  return loaded;
}

function change(next: TerminalMemory) {
  memory = next;
  emit();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveTerminalMemory(memory).catch(() => {}), 800);
}

export function getHost(tunnelId: string): HostMemory {
  return memory.hosts[tunnelId] ?? emptyHost();
}

export function updateHost(tunnelId: string, fn: (host: HostMemory) => HostMemory) {
  change({ ...memory, hosts: { ...memory.hosts, [tunnelId]: fn(getHost(tunnelId)) } });
}

/** Drops what was learned about hosts that no longer exist. */
export function pruneHosts(existing: Set<string>) {
  const stale = Object.keys(memory.hosts).filter((id) => !existing.has(id));
  if (stale.length === 0) return;
  const hosts = { ...memory.hosts };
  stale.forEach((id) => delete hosts[id]);
  change({ ...memory, hosts });
}

export function saveWorkspace(workspace: Workspace) {
  const others = memory.workspaces.filter((w) => w.id !== workspace.id);
  // The last session goes first so it never shifts the named ones around.
  change({ ...memory, workspaces: [...others, workspace] });
}

export function deleteWorkspace(id: string) {
  change({ ...memory, workspaces: memory.workspaces.filter((w) => w.id !== id) });
}

/** Writes right away (the window is closing). */
export function flushMemory() {
  window.clearTimeout(saveTimer);
  void saveTerminalMemory(memory).catch(() => {});
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function useTerminalMemory(): TerminalMemory {
  return useSyncExternalStore(subscribe, () => memory);
}
