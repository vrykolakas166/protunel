import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { terminalSetUnsaved } from "../api";
import type { Tunnel } from "../types";
import { computeLayout, findPane, paneIds } from "./layout";
import type { Tab } from "./tabs";
import type { FilePanelHandle, PaneFiles } from "./files/FilePanel";
import { collectUnsaved } from "./files/unsaved";
import { DEFAULT_SIZE, firstGeometry, maximizedBox, paneBox, parseFilesGeometry, place, type Box, type FilesGeometry } from "./files/geometry";
import { useTransfers } from "./files/useTransfers";

/** Open file panels at once; opening one more closes the oldest. */
export const MAX_FILE_PANELS = 8;
const FILES_GEOMETRY_KEY = "protunel.files.geometry";
/** The file panel's last place and size, for a pane that has none yet. */
function loadFilesGeometry(): FilesGeometry {
  try {
    const geo = parseFilesGeometry(localStorage.getItem(FILES_GEOMETRY_KEY));
    if (geo) return geo;
  } catch {
    // Blocked: the default.
  }
  return { placement: { kind: "snap", corner: "br" }, size: DEFAULT_SIZE };
}
function saveFilesGeometry(geo: FilesGeometry) {
  try {
    localStorage.setItem(FILES_GEOMETRY_KEY, JSON.stringify(geo));
  } catch {
    // Only a convenience.
  }
}

/** An open file panel with its owner pane and where it sits now. */
export interface PanelItem {
  paneId: string;
  tab: Tab;
  tunnel: Tunnel;
  owner: Box;
  geo: FilesGeometry;
  box: Box;
  shown: boolean;
  z: number;
}

/**
 * File panel state of the terminal window: which panels are open (and their
 * stacking, geometry and measured boxes), OS file drops, and the lookups a
 * panel needs about shells. The guarded opening (unsaved edits) stays with
 * the caller, which owns the confirmation.
 */
export function useFilePanels({
  tabs,
  byId,
  activeKey,
  paneAreaRef,
  terminalIds,
  focusPane,
  setActiveKey,
}: {
  tabs: Tab[];
  byId: Record<string, Tunnel>;
  activeKey: string | null;
  paneAreaRef: RefObject<HTMLDivElement | null>;
  terminalIds: RefObject<Map<string, string>>;
  focusPane: (tabKey: string, paneId: string) => void;
  setActiveKey: (key: string) => void;
}) {
  const { transfers, clearFinished } = useTransfers();
  /** Open file panels by pane id, in opening order (also their DOM order,
   * which never changes: moving a node would blur what has focus in it). */
  const [filesOpen, setFilesOpen] = useState<string[]>([]);
  /** The same panels bottom to top: the last one touched is on top. */
  const [filesStack, setFilesStack] = useState<string[]>([]);
  const filesRefs = useRef(new Map<string, FilePanelHandle>());
  /** Panes whose file panel holds an editor with unsaved changes. */
  const [dirtyPanes, setDirtyPanes] = useState<Set<string>>(() => new Set());
  const unsavedFlag = dirtyPanes.size > 0;
  // Rust asks the page before hiding the window only while this is set.
  useEffect(() => {
    void terminalSetUnsaved(unsavedFlag).catch(() => {});
  }, [unsavedFlag]);
  /** Pane id → the folder its panel showed last (session only). */
  const filesMemory = useRef(new Map<string, PaneFiles>());
  /** Pane id → where its panel sat; new panes start from the last one used. */
  const [filesGeometry, setFilesGeometry] = useState<Record<string, FilesGeometry>>({});
  const [areaBox, setAreaBox] = useState<Box | null>(null);
  const [windowBox, setWindowBox] = useState<Box>(() => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }));
  const [dropHover, setDropHover] = useState<{ x: number; y: number; paneId: string } | null>(null);
  const [footerQueue, setFooterQueue] = useState(false);

  useEffect(() => {
    const el = paneAreaRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setAreaBox({ x: r.left, y: r.top, w: r.width, h: r.height });
      setWindowBox({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  /** Where a pane's first panel opens: the last place used, read once. */
  const lastFilesGeometry = useRef<FilesGeometry | null>(null);
  lastFilesGeometry.current ??= loadFilesGeometry();

  /** Every open panel with its owner pane and box; hidden (not closed) while
   * its pane is in another tab or zoomed away. */
  const panels = filesOpen.flatMap((paneId) => {
    const tab = tabs.find((x) => findPane(x.root, paneId));
    const node = tab ? findPane(tab.root, paneId) : null;
    const tunnel = node ? byId[node.tunnelId] : undefined;
    if (!tab || !tunnel || !areaBox) return [];
    const rect =
      tab.zoomed === paneId ? { x: 0, y: 0, w: 1, h: 1 } : computeLayout(tab.root).panes.find((pane) => pane.id === paneId)?.rect;
    if (!rect) return [];
    const owner = paneBox(areaBox, rect);
    const geo = filesGeometry[paneId] ?? firstGeometry(lastFilesGeometry.current!);
    const box = geo.maximized ? maximizedBox(windowBox) : place(geo.placement, geo.size, owner, windowBox);
    const shown = tab.key === activeKey && (tab.zoomed === null || tab.zoomed === paneId);
    const z = 40 + Math.max(0, filesStack.indexOf(paneId));
    return [{ paneId, tab, tunnel, owner, geo, box, shown, z } satisfies PanelItem];
  });
  const filesPanes = useMemo(() => new Set(filesOpen), [filesOpen]);
  /** Shown panels, top first: what a drop hits. */
  const dropTargets = useRef<{ paneId: string; box: Box }[]>([]);
  dropTargets.current = panels.filter((x) => x.shown).sort((a, b) => b.z - a.z);

  // A panel goes when its pane does (closed, or every tab dropped on hide).
  useEffect(() => {
    const alive = filesOpen.filter((id) => tabs.some((tab) => findPane(tab.root, id)));
    if (alive.length !== filesOpen.length) {
      setFilesOpen(alive);
      setFilesStack((prev) => prev.filter((id) => alive.includes(id)));
    }
  }, [filesOpen, tabs]);

  const raiseFiles = (paneId: string) =>
    setFilesStack((prev) => (prev[prev.length - 1] === paneId ? prev : [...prev.filter((id) => id !== paneId), paneId]));

  const openFilesNow = (paneId: string) => {
    if (filesOpen.includes(paneId)) {
      raiseFiles(paneId);
      filesRefs.current.get(paneId)?.focus();
      return;
    }
    // Its own geometry from the start: one it shared with "the last used"
    // would move whenever another panel moved.
    setFilesGeometry((prev) => (prev[paneId] ? prev : { ...prev, [paneId]: firstGeometry(lastFilesGeometry.current!) }));
    // At the limit the panel used longest ago gives way.
    const evict = filesOpen.length >= MAX_FILE_PANELS ? filesStack[0] : null;
    setFilesOpen((prev) => [...prev.filter((id) => id !== evict), paneId]);
    setFilesStack((prev) => [...prev.filter((id) => id !== evict), paneId]);
  };

  /** The terminal id of a live shell on `tunnelId`: the preferred pane's if it
   * is on that tunnel, else any pane of this window on it; null when none. */
  const shellFor = (tunnelId: string, preferPaneId?: string): string | null => {
    const ids = tabs.flatMap((tab) => paneIds(tab.root));
    const ordered = preferPaneId ? [preferPaneId, ...ids] : ids;
    for (const id of ordered) {
      const tab = tabs.find((x) => findPane(x.root, id));
      const node = tab ? findPane(tab.root, id) : null;
      const term = terminalIds.current.get(id);
      if (node && node.tunnelId === tunnelId && term) return term;
    }
    return null;
  };

  /** `termId` is still a live shell, and its pane is still on `tunnelId`. */
  const shellAlive = (termId: string, tunnelId: string): boolean => {
    for (const [paneId, term] of terminalIds.current) {
      if (term !== termId) continue;
      const tab = tabs.find((x) => findPane(x.root, paneId));
      const node = tab ? findPane(tab.root, paneId) : null;
      return !!node && node.tunnelId === tunnelId;
    }
    return false;
  };

  const closeFiles = (paneId: string) => {
    setFilesOpen((prev) => prev.filter((id) => id !== paneId));
    setFilesStack((prev) => prev.filter((id) => id !== paneId));
    filesRefs.current.delete(paneId);
    const tab = tabs.find((x) => findPane(x.root, paneId));
    if (tab && tab.key === activeKey) focusPane(tab.key, paneId);
  };

  const focusFilesOwner = (paneId: string) => {
    const tab = tabs.find((x) => findPane(x.root, paneId));
    if (tab) {
      setActiveKey(tab.key);
      focusPane(tab.key, paneId);
    }
  };

  const setGeometry = (paneId: string, geo: FilesGeometry) => {
    setFilesGeometry((prev) => ({ ...prev, [paneId]: geo }));
    lastFilesGeometry.current = geo;
    saveFilesGeometry(geo);
  };

  // Files dragged in from the OS: only a drop on the panel uploads (never on
  // a shell — too easy to mistake where they would go).
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") {
        setDropHover(null);
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      const x = p.position.x / ratio;
      const y = p.position.y / ratio;
      const hit = dropTargets.current.find(
        ({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,
      );
      if (p.type === "drop") {
        setDropHover(null);
        if (hit) filesRefs.current.get(hit.paneId)?.drop(p.paths, x, y);
      } else {
        setDropHover(hit ? { x, y, paneId: hit.paneId } : null);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  /** Unsaved editors among `ids`, with their file paths. */
  const unsavedAmong = (ids: string[]) => collectUnsaved(ids, (id) => filesRefs.current.get(id)?.unsaved() ?? null);

  return {
    transfers,
    clearFinished,
    filesOpen,
    filesStack,
    filesRefs,
    setDirtyPanes,
    filesMemory,
    windowBox,
    dropHover,
    footerQueue,
    setFooterQueue,
    panels,
    filesPanes,
    raiseFiles,
    openFilesNow,
    closeFiles,
    focusFilesOwner,
    setGeometry,
    shellFor,
    shellAlive,
    unsavedAmong,
  };
}
