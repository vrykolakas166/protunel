// The file panel: a non-modal, movable window over the terminal for the files
// of ONE pane's server (SFTP on that tunnel's session). It belongs to the pane
// that opened it; changing shell focus never retargets it. See CLAUDE.md
// "File panel".

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  filesCount,
  filesCreate,
  filesDelete,
  filesDownload,
  filesHome,
  filesList,
  filesOpenLocal,
  filesPaste,
  filesPickUpload,
  filesRename,
  filesUpload,
} from "../../api";
import { openMenu, type MenuEntry } from "../../contextMenu";
import { formatBytes, formatTimestamp } from "../../format";
import type { FileCount, FileEntry, FileTransfer, Tunnel } from "../../types";
import { FileDetails } from "./FileDetails";
import { FileView, type FileViewHandle } from "./FileView";
import {
  CORNERS,
  DEFAULT_SIZE,
  HANDLES,
  afterResize,
  cornerPosition,
  freeAt,
  keepInside,
  resizedFrom,
  snapCorner,
  type Box,
  type Corner,
  type Handle,
  type Placement,
  type Size,
} from "./geometry";
import {
  baseName,
  crumbs,
  isDirLike,
  joinPath,
  modeString,
  parentPath,
  resolvePath,
  sortEntries,
  validName,
  viewKind,
  type SortKey,
} from "./paths";
import { TransferList } from "./TransferList";
import { isActive, overallProgress } from "./useTransfers";

const ROW = 28;
/** Deletes this big ask for the folder's name to be typed. */
const TYPE_TO_CONFIRM = 100;
const DETAILS_MIN = 880;
const COLUMNS_MIN = 600;

export interface FilePanelHandle {
  /** Resolves false when the user keeps the panel (unsaved edits → Cancel). */
  requestClose: () => Promise<boolean>;
  focus: () => void;
  /** Local paths dropped from the OS at window point (x, y). */
  drop: (paths: string[], x: number, y: number) => void;
}

/** Remembered per pane while the window lives. */
export interface PaneFiles {
  path: string;
}

interface Props {
  /** The pane this panel belongs to (`data-file-panel`). */
  paneId: string;
  /** Stacking among the open panels; the last one touched is on top. */
  z: number;
  onRaise: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  tunnel: Tunnel;
  /** Where the shell really is (`user@host:port`). */
  target: string;
  box: Box;
  owner: Box;
  bounds: Box;
  placement: Placement;
  onPlacement: (placement: Placement, size: Size) => void;
  memory: PaneFiles | undefined;
  onMemory: (memory: PaneFiles) => void;
  /** The shell's directory if known: absolute, or `~…`. */
  shellDir: () => string | null;
  transfers: FileTransfer[];
  byId: Record<string, Tunnel>;
  onClearTransfers: () => void;
  /** An OS drag is over the window here (window px), or null. */
  dropHover: { x: number; y: number } | null;
  onClose: () => void;
  onFocusShell: () => void;
}

type NameBar = { kind: "file" | "dir" } | { kind: "rename"; from: string };
type Confirm =
  | { kind: "delete"; paths: string[]; count: FileCount | null; typed: string }
  | { kind: "dirty"; resolve: (choice: "save" | "discard" | "cancel") => void };

/** Copied/cut paths; outlives the panel so reopening can still paste. */
let clipboard: { tunnelId: string; paths: string[]; cut: boolean } | null = null;

export const FilePanel = forwardRef<FilePanelHandle, Props>(function FilePanel(props, ref) {
  const {
    paneId,
    z,
    onRaise,
    maximized,
    onToggleMaximize,
    tunnel,
    target,
    box,
    owner,
    bounds,
    placement,
    onPlacement,
    memory,
    onMemory,
    shellDir,
    transfers,
    byId,
    onClearTransfers,
    dropHover,
    onClose,
    onFocusShell,
  } = props;
  const { t } = useTranslation("terminal");
  const tunnelId = tunnel.id;
  const where = target.replace(/:22$/, "");
  const titleId = `file-panel-title-${paneId}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The list's scroll position, kept while it is unmounted (file open, narrow details). */
  const savedScroll = useRef(0);
  const viewRef = useRef<FileViewHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const [home, setHome] = useState("/");
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const anchor = useRef(0);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [showHidden, setShowHidden] = useState(() => readFlag(HIDDEN_KEY));
  const [filter, setFilter] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [nameBar, setNameBar] = useState<(NameBar & { value: string }) | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(300);
  const [, bumpClipboard] = useState(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** Snap preview while dragging the header. */
  const [snapPreview, setSnapPreview] = useState<Corner | null>(null);
  const [moving, setMoving] = useState(false);
  const loadSeq = useRef(0);

  const wide = box.w >= DETAILS_MIN;
  const columns = box.w >= COLUMNS_MIN;

  const errorText = useCallback(
    (e: unknown) => {
      const code = String(e);
      return KNOWN_ERRORS.has(code) ? t(`files.err.${code}`, { where }) : code;
    },
    [t, where],
  );

  const visible = useMemo(
    () => sortEntries(entries, sort.key, sort.desc, showHidden, filter),
    [entries, sort, showHidden, filter],
  );

  // ---- loading ----------------------------------------------------------

  /** Lists `dir`; the newest request wins (a slow listing never lands late). */
  const load = useCallback(
    async (dir: string, keep?: { select?: string[] }) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      setError(null);
      try {
        const listing = await filesList(tunnelId, dir);
        if (seq !== loadSeq.current) return;
        setPath(listing.path);
        setEntries(listing.entries);
        onMemory({ path: listing.path });
        const keepNames = new Set(keep?.select ?? []);
        setSelected(keepNames);
        setCursor(0);
        anchor.current = 0;
        setFilter("");
        savedScroll.current = 0;
        setScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setError(errorText(e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [tunnelId, errorText, onMemory],
  );

  const refresh = useCallback(() => {
    if (path) void load(path, { select: [...selected] });
  }, [path, load, selected]);

  // Opening the panel is asking for it: the keyboard moves in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // First open: where this pane's panel last was, else the shell's folder,
  // else the login folder.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let homeDir = "/";
      try {
        homeDir = await filesHome(tunnelId);
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
        setLoading(false);
        return;
      }
      if (!alive) return;
      setHome(homeDir);
      const guess = memory?.path ?? shellDir();
      const start = guess ? resolvePath(guess, homeDir, homeDir) : homeDir;
      try {
        const listing = await filesList(tunnelId, start);
        if (!alive) return;
        setPath(listing.path);
        setEntries(listing.entries);
        onMemory({ path: listing.path });
        setScrollTop(0);
      } catch {
        if (alive) await load(homeDir);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId]);

  // A finished upload into the folder on screen shows up without a refresh.
  const seenDone = useRef(new Set<string>());
  useEffect(() => {
    let changed = false;
    for (const x of transfers) {
      if (x.tunnelId !== tunnelId || x.direction !== "upload" || x.state !== "done") continue;
      if (seenDone.current.has(x.id)) continue;
      seenDone.current.add(x.id);
      if (path && parentPath(x.remotePath) === path) changed = true;
    }
    if (changed) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers]);

  // ---- list measurements --------------------------------------------------

  // The list unmounts while a file is open (and behind narrow details): on
  // every mount it gets its scroll back and its size measured again, so the
  // virtual window never points at rows from a stale position.
  const listObserver = useRef<ResizeObserver | null>(null);
  const attachList = useCallback((el: HTMLDivElement | null) => {
    listObserver.current?.disconnect();
    listObserver.current = null;
    if (listRef.current && !el) savedScroll.current = listRef.current.scrollTop;
    listRef.current = el;
    if (!el) return;
    el.scrollTop = savedScroll.current;
    setScrollTop(el.scrollTop);
    setListHeight(el.clientHeight);
    // Also re-read the scroll: a panel hidden with its tab comes back with
    // its size changing from 0, and no scroll event for any position it lost.
    const observer = new ResizeObserver(() => {
      setListHeight(el.clientHeight);
      setScrollTop(el.scrollTop);
    });
    observer.observe(el);
    listObserver.current = observer;
  }, []);
  useEffect(() => () => listObserver.current?.disconnect(), []);

  // Clamped: a shorter list (filter, reload) can leave a stale position.
  const top = Math.min(scrollTop, Math.max(0, visible.length * ROW - listHeight));
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(visible.length, Math.ceil((top + listHeight) / ROW) + 5);

  const scrollIntoView = (index: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = index * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  };

  // ---- actions ------------------------------------------------------------

  const pathsOf = (names: Iterable<string>) => (path ? [...names].map((n) => joinPath(path, n)) : []);
  const current = visible[cursor];
  const targets = (): string[] => {
    if (selected.size > 0) return pathsOf(selected);
    return current ? pathsOf([current.name]) : [];
  };

  const open = (entry: FileEntry) => {
    if (!path) return;
    const full = joinPath(path, entry.name);
    if (isDirLike(entry)) {
      setDetails(null);
      void load(full);
    } else {
      setViewing(full);
    }
  };

  const goUp = () => {
    if (path && path !== "/") void load(parentPath(path), { select: [baseName(path)] });
  };

  const download = (paths = targets()) => {
    if (paths.length === 0) return;
    void filesDownload(tunnelId, paths)
      .then(() => {
        setQueueOpen(true);
      })
      .catch((e) => setNotice(errorText(e)));
  };

  const openLocal = (p: string) => {
    void filesOpenLocal(tunnelId, p).catch((e) => setNotice(errorText(e)));
    setNotice(t("files.openingLocal", { name: baseName(p) }));
  };

  const upload = () => {
    if (!path) return;
    void filesPickUpload(tunnelId, path)
      .then((ids) => ids.length > 0 && setQueueOpen(true))
      .catch((e) => setNotice(errorText(e)));
  };

  const copyToClipboard = (cut: boolean) => {
    const paths = targets();
    if (paths.length === 0) return;
    clipboard = { tunnelId, paths, cut };
    bumpClipboard((n) => n + 1);
    setNotice(t(cut ? "files.cutCount" : "files.copiedCount", { count: paths.length }));
  };

  const canPaste = clipboard !== null && clipboard.tunnelId === tunnelId;
  const paste = async () => {
    if (!path || !clipboard || clipboard.tunnelId !== tunnelId) return;
    const clip = clipboard;
    setNotice(t("files.pasting"));
    try {
      const out = await filesPaste(tunnelId, clip.paths, path, clip.cut);
      if (clip.cut) {
        clipboard = null;
        bumpClipboard((n) => n + 1);
      }
      setNotice(
        out.skipped.length > 0
          ? t("files.pasteSkipped", { count: out.skipped.length, names: out.skipped.map(baseName).join(", ") })
          : null,
      );
      void load(path, { select: out.done.map(baseName) });
    } catch (e) {
      setNotice(errorText(e));
      refresh();
    }
  };

  const askDelete = (paths = targets()) => {
    if (paths.length === 0) return;
    setConfirm({ kind: "delete", paths, count: null, typed: "" });
    filesCount(tunnelId, paths)
      .then((count) =>
        setConfirm((c) => (c?.kind === "delete" && c.paths === paths ? { ...c, count } : c)),
      )
      .catch((e) => {
        setConfirm(null);
        setNotice(errorText(e));
      });
  };

  const doDelete = async (paths: string[]) => {
    setConfirm(null);
    setNotice(t("files.deleting"));
    try {
      await filesDelete(tunnelId, paths);
      setNotice(null);
    } catch (e) {
      setNotice(errorText(e));
    }
    refresh();
    focusList();
  };

  const submitName = async () => {
    if (!nameBar || !path || !validName(nameBar.value)) return;
    const name = nameBar.value.trim();
    try {
      if (nameBar.kind === "rename") {
        if (name !== nameBar.from) await filesRename(tunnelId, joinPath(path, nameBar.from), joinPath(path, name));
      } else {
        await filesCreate(tunnelId, joinPath(path, name), nameBar.kind === "dir");
      }
      setNameBar(null);
      await load(path, { select: [name] });
      focusList();
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const copyPath = (p: string) => {
    void writeText(p).catch(() => {});
    setNotice(t("files.pathCopied"));
  };

  const goShellDir = async () => {
    const dir = shellDir();
    if (!dir) {
      setNotice(t("files.shellDirUnknown"));
      return;
    }
    await load(resolvePath(dir, home, home));
  };

  const focusList = () => requestAnimationFrame(() => listRef.current?.focus());

  // ---- closing ------------------------------------------------------------

  /** Unsaved edits: Save / Discard / Cancel. True when it is fine to leave. */
  const settleDirty = async (): Promise<boolean> => {
    if (!viewRef.current?.dirty()) return true;
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) =>
      setConfirm((prev) => {
        // Asked again while the question is up: the earlier ask is answered "cancel".
        if (prev?.kind === "dirty") prev.resolve("cancel");
        return { kind: "dirty", resolve };
      }),
    );
    setConfirm(null);
    if (choice === "cancel") return false;
    if (choice === "save") return (await viewRef.current?.save()) ?? true;
    return true;
  };

  const closeView = async () => {
    if (await settleDirty()) {
      setViewing(null);
      refresh();
      focusList();
    }
  };

  useImperativeHandle(ref, () => ({
    requestClose: settleDirty,
    focus: () => {
      if (rootRef.current?.contains(document.activeElement)) return;
      if (viewing) rootRef.current?.querySelector<HTMLElement>(".cm-content")?.focus();
      else listRef.current?.focus();
    },
    drop: (paths, x, y) => {
      const dir = dirAt(x, y) ?? path;
      setDropDir(null);
      if (!dir || paths.length === 0) return;
      void filesUpload(tunnelId, paths, dir, false)
        .then(() => setQueueOpen(true))
        .catch((e) => setNotice(errorText(e)));
    },
  }));

  // ---- OS drag over the panel ----------------------------------------------

  /** The folder a drop at window point (x, y) goes to: a folder row, else the open folder. */
  const dirAt = (x: number, y: number): string | null => {
    if (!path || viewing) return path;
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-row]");
    const name = row?.dataset.fileRow;
    const entry = name ? entries.find((e) => e.name === name) : undefined;
    return entry && isDirLike(entry) ? joinPath(path, entry.name) : path;
  };
  useEffect(() => {
    setDropDir(dropHover ? dirAt(dropHover.x, dropHover.y) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropHover?.x, dropHover?.y, path, viewing]);

  // ---- moving and resizing ------------------------------------------------

  /** Header drag: follows the pointer by transform, commits on release. */
  const startMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || maximized || (e.target as HTMLElement).closest("button, input")) return;
    const el = rootRef.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let engaged: Corner | null = placement.kind === "snap" ? placement.corner : null;
    let latest = box;
    let frame = 0;
    setMoving(true);
    const move = (ev: PointerEvent) => {
      const free = keepInside({ ...box, x: box.x + ev.clientX - sx, y: box.y + ev.clientY - sy }, bounds);
      latest = free;
      const corner = snapCorner(free, owner, engaged);
      if (corner !== engaged) {
        engaged = corner;
        setSnapPreview(corner);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.transform = `translate(${free.x - box.x}px, ${free.y - box.y}px)`;
      });
    };
    const end = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      el.style.transform = "";
      setMoving(false);
      setSnapPreview(null);
      if (ev.type === "pointercancel") return;
      onPlacement(engaged ? { kind: "snap", corner: engaged } : freeAt(latest, bounds), { w: box.w, h: box.h });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const startResize = (handleSide: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = rootRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let latest = box;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      latest = resizedFrom(box, handleSide, ev.clientX - sx, ev.clientY - sy, bounds);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.left = `${latest.x}px`;
        el.style.top = `${latest.y}px`;
        el.style.width = `${latest.w}px`;
        el.style.height = `${latest.h}px`;
      });
    };
    const end = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      // A snapped panel keeps its corner unless the grip moved that corner.
      onPlacement(afterResize(placement, handleSide, latest, bounds), { w: latest.w, h: latest.h });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const positionMenu = (e: ReactMouseEvent) => {
    const label: Record<Corner, string> = {
      tl: t("files.pos.tl"),
      tr: t("files.pos.tr"),
      bl: t("files.pos.bl"),
      br: t("files.pos.br"),
    };
    openMenu(e, [
      ...CORNERS.map((corner) => ({
        label: label[corner],
        checked: placement.kind === "snap" && placement.corner === corner,
        action: () => onPlacement({ kind: "snap", corner }, { w: box.w, h: box.h }),
      })),
      "separator",
      { label: t("files.pos.resetSize"), action: () => onPlacement(placement, DEFAULT_SIZE) },
    ]);
  };

  // ---- menus --------------------------------------------------------------

  const rowMenu = (e: ReactMouseEvent, entry: FileEntry, index: number) => {
    if (!path) return;
    if (!selected.has(entry.name)) {
      setSelected(new Set([entry.name]));
      setCursor(index);
      anchor.current = index;
    }
    const many = selected.has(entry.name) && selected.size > 1;
    const full = joinPath(path, entry.name);
    const paths = many ? pathsOf(selected) : [full];
    const items: MenuEntry[] = [
      { label: isDirLike(entry) ? t("files.menu.openFolder") : t("files.menu.open"), action: () => open(entry), enabled: !many },
      { label: t("files.download"), action: () => download(paths) },
      { label: t("files.openLocal"), action: () => openLocal(full), enabled: !many && !isDirLike(entry) },
      "separator",
      { label: t("files.menu.copy"), action: () => ((clipboard = { tunnelId, paths, cut: false }), bumpClipboard((n) => n + 1)) },
      { label: t("files.menu.cut"), action: () => ((clipboard = { tunnelId, paths, cut: true }), bumpClipboard((n) => n + 1)) },
      { label: t("files.menu.paste"), action: () => void paste(), enabled: canPaste },
      "separator",
      { label: t("files.menu.rename"), action: () => setNameBar({ kind: "rename", from: entry.name, value: entry.name }), enabled: !many },
      { label: t("files.copyPath"), action: () => copyPath(full), enabled: !many },
      { label: t("files.menu.properties"), action: () => setDetails(full), enabled: !many },
      "separator",
      { label: t("files.menu.delete"), action: () => askDelete(paths) },
    ];
    openMenu(e, items);
  };

  const backgroundMenu = (e: ReactMouseEvent) => {
    openMenu(e, [
      { label: t("files.newFolder"), action: () => setNameBar({ kind: "dir", value: "" }) },
      { label: t("files.newFile"), action: () => setNameBar({ kind: "file", value: "" }) },
      { label: t("files.menu.paste"), action: () => void paste(), enabled: canPaste },
      "separator",
      { label: t("files.upload"), action: upload },
      { label: t("files.refresh"), action: refresh },
      { label: t("files.showHidden"), checked: showHidden, action: toggleHidden },
      ...(path ? ([{ label: t("files.copyPath"), action: () => copyPath(path) }] as MenuEntry[]) : []),
    ]);
  };

  const toggleHidden = () =>
    setShowHidden((v) => {
      writeFlag(HIDDEN_KEY, !v);
      return !v;
    });

  // ---- selection ------------------------------------------------------------

  const selectAt = (index: number, mode: "only" | "toggle" | "range") => {
    const entry = visible[index];
    if (!entry) return;
    setCursor(index);
    if (mode === "only") {
      setSelected(new Set([entry.name]));
      anchor.current = index;
    } else if (mode === "toggle") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.name)) next.delete(entry.name);
        else next.add(entry.name);
        return next;
      });
      anchor.current = index;
    } else {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelected(new Set(visible.slice(a, b + 1).map((x) => x.name)));
    }
    scrollIntoView(index);
  };

  // ---- keyboard -------------------------------------------------------------

  const onListKey = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const step = (delta: number) => {
      e.preventDefault();
      const next = Math.min(visible.length - 1, Math.max(0, cursor + delta));
      selectAt(next, e.shiftKey ? "range" : "only");
    };
    switch (true) {
      case e.key === "ArrowDown":
        return step(1);
      case e.key === "ArrowUp" && !e.altKey:
        return step(-1);
      case e.key === "PageDown":
        return step(Math.max(1, Math.floor(listHeight / ROW) - 1));
      case e.key === "PageUp":
        return step(-Math.max(1, Math.floor(listHeight / ROW) - 1));
      case e.key === "Home":
        return step(-visible.length);
      case e.key === "End":
        return step(visible.length);
      case e.key === "Enter" && e.altKey:
        e.preventDefault();
        if (current && path) setDetails(joinPath(path, current.name));
        return;
      case e.key === "Enter":
        e.preventDefault();
        if (current) open(current);
        return;
      case e.key === "Backspace" || (e.key === "ArrowUp" && e.altKey):
        e.preventDefault();
        goUp();
        return;
      case e.key === "F2":
        e.preventDefault();
        if (current) setNameBar({ kind: "rename", from: current.name, value: current.name });
        return;
      case e.key === "F5":
        e.preventDefault();
        refresh();
        return;
      case e.key === "Delete":
        e.preventDefault();
        askDelete();
        return;
      case mod && e.shiftKey && e.key.toLowerCase() === "n":
        e.preventDefault();
        setNameBar({ kind: "dir", value: "" });
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "a":
        e.preventDefault();
        setSelected(new Set(visible.map((x) => x.name)));
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "c":
        e.preventDefault();
        copyToClipboard(false);
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "x":
        e.preventDefault();
        copyToClipboard(true);
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "v":
        e.preventDefault();
        void paste();
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "l":
        e.preventDefault();
        setPathEdit(path ?? "");
        return;
      case mod && !e.shiftKey && e.key.toLowerCase() === "f":
        e.preventDefault();
        filterRef.current?.focus();
        return;
      case !mod && !e.altKey && e.key.length === 1 && e.key !== " ":
        // Type to jump: the next name starting with that letter.
        {
          const k = e.key.toLowerCase();
          const from = cursor + 1;
          const order = [...visible.slice(from), ...visible.slice(0, from)];
          const hit = order.find((x) => x.name.toLowerCase().startsWith(k));
          if (hit) selectAt(visible.indexOf(hit), "only");
        }
        return;
    }
  };

  /** Esc unwinds one layer at a time; the panel closes last. */
  const onRootKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (confirm) {
      if (confirm.kind === "dirty") confirm.resolve("cancel");
      else setConfirm(null);
      focusList();
    } else if (nameBar) {
      setNameBar(null);
      focusList();
    } else if (pathEdit !== null) {
      setPathEdit(null);
      focusList();
    } else if (queueOpen) setQueueOpen(false);
    else if (viewing) void closeView();
    else if (details) setDetails(null);
    else if (filter) {
      setFilter("");
      focusList();
    } else if (selected.size > 1) setSelected(new Set(current ? [current.name] : []));
    else onClose();
  };

  // ---- render ---------------------------------------------------------------

  const activeHere = transfers.filter((x) => x.tunnelId === tunnelId);
  const running = activeHere.filter(isActive);
  const progress = overallProgress(activeHere);
  const snapGhost = snapPreview ? { ...cornerPosition(snapPreview, box, owner), w: box.w, h: box.h } : null;
  // Grips on every edge and corner, outside the panel (so nothing inside it,
  // scrollbars included, can cover them) and straddling its border.
  const G = 8;
  const C = 16;
  const gripStyle = (h: Handle): React.CSSProperties => {
    const { x, y, w, h: ht } = box;
    const style: React.CSSProperties = { position: "fixed", zIndex: z + 1 };
    if (h === "n" || h === "s") Object.assign(style, { left: x + C / 2, width: w - C, height: G, top: (h === "n" ? y : y + ht) - G / 2 });
    else if (h === "e" || h === "w") Object.assign(style, { top: y + C / 2, height: ht - C, width: G, left: (h === "w" ? x : x + w) - G / 2 });
    else
      Object.assign(style, {
        width: C,
        height: C,
        left: (h.includes("w") ? x : x + w) - C / 2,
        top: (h.includes("n") ? y : y + ht) - C / 2,
      });
    return style;
  };
  const gripCursor: Record<Handle, string> = {
    n: "cursor-ns-resize",
    s: "cursor-ns-resize",
    e: "cursor-ew-resize",
    w: "cursor-ew-resize",
    nw: "cursor-nwse-resize",
    se: "cursor-nwse-resize",
    ne: "cursor-nesw-resize",
    sw: "cursor-nesw-resize",
  };
  const iconButton = "rounded p-1 text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40";

  return (
    <>
      {snapGhost && (
        <div
          className="pointer-events-none fixed rounded-lg border-2 border-dashed border-accent bg-accent/10"
          style={{ left: snapGhost.x, top: snapGhost.y, width: snapGhost.w, height: snapGhost.h, zIndex: z }}
        />
      )}
      <div
        ref={rootRef}
        role="dialog"
        aria-labelledby={titleId}
        data-file-panel={paneId}
        onKeyDown={onRootKey}
        onPointerDownCapture={onRaise}
        onFocusCapture={onRaise}
        className={`@container fixed z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl outline-none focus-within:border-accent ${
          moving ? "opacity-95" : ""
        }`}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z }}
      >
        {/* Header: who this is (big, so a host is never mistaken), drag to move. */}
        <div
          onPointerDown={startMove}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest("button")) onToggleMaximize();
          }}
          className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border bg-bg/60 px-2.5 py-1.5 active:cursor-grabbing"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0 text-accent" aria-hidden="true">
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" strokeLinejoin="round" />
          </svg>
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-text" title={`${tunnel.name} · ${target}`}>
            {where}
            <span className="ml-2 font-sans text-[11px] font-normal text-muted">{tunnel.name}</span>
          </h2>
          <button onClick={positionMenu} disabled={maximized} className={iconButton} title={t("files.pos.menu")} aria-label={t("files.pos.menu")} aria-haspopup="menu">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="1.5" />
              <rect x="8.5" y="8.5" width="4" height="4" rx="0.5" fill="currentColor" />
            </svg>
          </button>
          <button
            onClick={onToggleMaximize}
            className={iconButton}
            title={maximized ? t("files.restore") : t("files.maximize")}
            aria-label={maximized ? t("files.restore") : t("files.maximize")}
            aria-pressed={maximized}
          >
            {maximized ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <rect x="2.5" y="5" width="8.5" height="8.5" rx="1" />
                <path d="M5.5 5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H11" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
              </svg>
            )}
          </button>
          <button onClick={onFocusShell} className={iconButton} title={t("files.focusShell")} aria-label={t("files.focusShell")}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4.5l3.5 3.5L3 11.5M8 12h5" />
            </svg>
          </button>
          <button onClick={() => void settleDirty().then((ok) => ok && onClose())} className={iconButton} title={t("files.close")} aria-label={t("files.close")}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {viewing ? (
          <FileView
            ref={viewRef}
            tunnelId={tunnelId}
            path={viewing}
            where={where}
            onBack={() => void closeView()}
            onDownload={() => download([viewing])}
            onOpenLocal={() => openLocal(viewing)}
            onSaved={() => setNotice(t("files.view.saved"))}
            errorText={errorText}
          />
        ) : (
          <>
            {/* Toolbar: where we are, and what can be done here. */}
            <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
              <button onClick={goUp} disabled={!path || path === "/"} className={iconButton} title={t("files.up")} aria-label={t("files.up")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
                </svg>
              </button>
              {pathEdit !== null ? (
                <form
                  className="min-w-0 flex-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = resolvePath(pathEdit, path ?? home, home);
                    setPathEdit(null);
                    void load(next);
                    focusList();
                  }}
                >
                  <input
                    ref={pathInputRef}
                    autoFocus
                    value={pathEdit}
                    onChange={(e) => setPathEdit(e.target.value)}
                    onBlur={() => setPathEdit(null)}
                    spellCheck={false}
                    className="w-full rounded border border-accent bg-bg px-2 py-0.5 font-mono text-xs text-text outline-none"
                  />
                </form>
              ) : (
                <nav
                  aria-label={t("files.path")}
                  onDoubleClick={() => setPathEdit(path ?? "")}
                  title={t("files.pathHint")}
                  className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-xs"
                >
                  {path &&
                    crumbs(path).map((c, i, all) => (
                      <span key={c.path} className={`flex min-w-0 items-center ${i < all.length - 2 ? "shrink" : "shrink-0"}`}>
                        {i > 1 && <span className="px-0.5 text-muted">/</span>}
                        <button
                          onClick={() => void load(c.path)}
                          className={`truncate rounded px-1 py-0.5 hover:bg-surface-hover ${i === all.length - 1 ? "text-text" : "text-muted hover:text-text"}`}
                        >
                          {c.name}
                        </button>
                      </span>
                    ))}
                </nav>
              )}
              <button onClick={() => void goShellDir()} className={iconButton} title={t("files.shellDir")} aria-label={t("files.shellDir")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                  <path d="M4.5 6.5l2 1.5-2 1.5M8 10h3" />
                </svg>
              </button>
              <button onClick={() => void load(home)} className={iconButton} title={t("files.home", { home })} aria-label={t("files.homeLabel")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.5 7.5L8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5Z" />
                </svg>
              </button>
              <button onClick={refresh} className={iconButton} title={`${t("files.refresh")} (F5)`} aria-label={t("files.refresh")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />
                </svg>
              </button>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <button onClick={() => setNameBar({ kind: "dir", value: "" })} className={iconButton} title={`${t("files.newFolder")} (Ctrl+Shift+N)`} aria-label={t("files.newFolder")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5ZM8 7v4M6 9h4" />
                </svg>
              </button>
              <button onClick={() => setNameBar({ kind: "file", value: "" })} className={iconButton} title={t("files.newFile")} aria-label={t("files.newFile")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6ZM9 2v4h4M8 8v4M6 10h4" />
                </svg>
              </button>
              <button onClick={upload} className={iconButton} title={t("files.uploadHint")} aria-label={t("files.upload")}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" />
                </svg>
              </button>
              <button
                onClick={() => download()}
                disabled={!current && selected.size === 0}
                className={iconButton}
                title={t("files.downloadHint")}
                aria-label={t("files.download")}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10" />
                </svg>
              </button>
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "Enter") {
                    e.preventDefault();
                    focusList();
                    if (e.key === "Enter" && visible[0]) selectAt(0, "only");
                  }
                }}
                placeholder={t("files.filter")}
                aria-label={t("files.filter")}
                spellCheck={false}
                className="ml-1 hidden w-28 rounded border border-border bg-bg px-2 py-0.5 text-xs text-text outline-none placeholder:text-muted focus:border-accent @min-[600px]:block"
              />
            </div>

            {nameBar && (
              <form
                className="flex shrink-0 items-center gap-2 border-b border-border bg-accent/5 px-2.5 py-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitName();
                }}
              >
                <label className="shrink-0 text-xs text-muted" htmlFor="file-name-bar">
                  {nameBar.kind === "rename" ? t("files.renameLabel") : nameBar.kind === "dir" ? t("files.newFolder") : t("files.newFile")}
                </label>
                <input
                  id="file-name-bar"
                  autoFocus
                  value={nameBar.value}
                  onChange={(e) => setNameBar({ ...nameBar, value: e.target.value })}
                  onFocus={(e) => {
                    // Rename selects the name without its extension, like a file manager.
                    const v = e.currentTarget.value;
                    const dot = v.lastIndexOf(".");
                    e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
                  }}
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded border border-accent bg-bg px-2 py-0.5 font-mono text-xs text-text outline-none"
                />
                <button type="submit" disabled={!validName(nameBar.value)} className="rounded bg-accent px-2.5 py-0.5 text-xs font-medium text-on-accent disabled:opacity-40">
                  {nameBar.kind === "rename" ? t("files.rename") : t("files.create")}
                </button>
                <button type="button" onClick={() => setNameBar(null)} className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-hover">
                  {t("files.cancel")}
                </button>
              </form>
            )}

            <div className="flex min-h-0 flex-1">
              {(!details || wide) && (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* Column heads: click to sort. */}
                  <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] uppercase tracking-wide text-muted">
                    <SortHead label={t("files.col.name")} k="name" sort={sort} setSort={setSort} className="min-w-0 flex-1" />
                    <SortHead label={t("files.col.size")} k="size" sort={sort} setSort={setSort} className="w-16 text-right" />
                    {columns && <SortHead label={t("files.col.modified")} k="mtime" sort={sort} setSort={setSort} className="w-28" />}
                    {wide && !details && <span className="w-20">{t("files.col.mode")}</span>}
                  </div>
                  <div
                    ref={attachList}
                    tabIndex={0}
                    role="listbox"
                    aria-multiselectable="true"
                    aria-label={t("files.listLabel", { path: path ?? "" })}
                    aria-activedescendant={current ? `file-row-${cursor}` : undefined}
                    onKeyDown={onListKey}
                    onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                    onContextMenu={(e) => {
                      if ((e.target as HTMLElement).closest("[data-file-row]")) return;
                      backgroundMenu(e);
                    }}
                    className="relative min-h-0 flex-1 overflow-y-auto outline-none"
                  >
                    {error ? (
                      <div className="flex flex-col items-center gap-2 p-6 text-center text-xs">
                        <p className="text-coral">{error}</p>
                        <button onClick={() => void load(path ?? home)} className="rounded border border-border px-2.5 py-1 text-text hover:bg-surface-hover">
                          {t("files.retry")}
                        </button>
                      </div>
                    ) : visible.length === 0 && !loading ? (
                      <p className="p-6 text-center text-xs text-muted">{filter ? t("files.noMatch") : t("files.emptyFolder")}</p>
                    ) : (
                      <div style={{ height: visible.length * ROW }} className="relative">
                        {visible.slice(first, last).map((entry, i) => {
                          const index = first + i;
                          const isSelected = selected.has(entry.name);
                          const isCursor = index === cursor;
                          const cut = clipboard?.cut && clipboard.tunnelId === tunnelId && path && clipboard.paths.includes(joinPath(path, entry.name));
                          const dropping = dropDir !== null && path !== null && dropDir === joinPath(path, entry.name);
                          return (
                            <div
                              key={entry.name}
                              id={`file-row-${index}`}
                              role="option"
                              aria-selected={isSelected}
                              data-file-row={entry.name}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                selectAt(index, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only");
                              }}
                              onDoubleClick={() => open(entry)}
                              onContextMenu={(e) => rowMenu(e, entry, index)}
                              className={`absolute left-0 right-0 flex cursor-default items-center gap-2 px-3 text-xs ${
                                dropping
                                  ? "bg-accent/25 ring-1 ring-inset ring-accent"
                                  : isSelected
                                    ? "bg-accent/15 text-text"
                                    : "text-text hover:bg-surface-hover"
                              } ${isCursor ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""} ${cut ? "opacity-50" : ""}`}
                              style={{ top: index * ROW, height: ROW }}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-2">
                                <EntryIcon entry={entry} />
                                <span className={`truncate ${entry.name.startsWith(".") ? "text-muted" : ""}`}>{entry.name}</span>
                                {entry.kind === "symlink" && <span className="shrink-0 text-[10px] text-muted">↪</span>}
                              </span>
                              <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted">
                                {isDirLike(entry) ? "" : formatBytes(entry.size)}
                              </span>
                              {columns && (
                                <span className="w-28 shrink-0 truncate text-[11px] text-muted">
                                  {entry.mtime !== null ? formatTimestamp(entry.mtime) : ""}
                                </span>
                              )}
                              {wide && !details && (
                                <span className="w-20 shrink-0 font-mono text-[11px] text-muted">{modeString(entry.mode)}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {loading && (
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-accent" />
                    )}
                  </div>
                </div>
              )}
              {details && (
                <div className={`flex min-h-0 flex-col ${wide ? "w-72 shrink-0 border-l border-border" : "flex-1"}`}>
                  <FileDetails tunnelId={tunnelId} path={details} onClose={() => setDetails(null)} errorText={errorText} />
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer: what is selected, the clipboard, transfers. */}
        <div className="relative flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg/60 px-2.5 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate" role="status">
            {notice ??
              (selected.size > 1
                ? t("files.selectedCount", { count: selected.size })
                : t("files.itemCount", { count: visible.length }))}
          </span>
          {canPaste && clipboard && (
            <button onClick={() => void paste()} className="shrink-0 rounded px-1.5 text-accent hover:bg-accent/10" title={t("files.menu.paste")}>
              {t(clipboard.cut ? "files.clipCut" : "files.clipCopy", { count: clipboard.paths.length })}
            </button>
          )}
          <button
            onClick={() => setQueueOpen((v) => !v)}
            aria-expanded={queueOpen}
            className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 hover:bg-surface-hover ${running.length > 0 ? "text-accent" : "hover:text-text"}`}
          >
            <span aria-hidden="true">⇅</span>
            {running.length > 0 ? `${running.length} · ${Math.round((progress ?? 0) * 100)}%` : t("files.queue.title")}
          </button>
          {queueOpen && (
            <div className="absolute bottom-full right-1 z-10 mb-1 w-[min(26rem,calc(100%-0.5rem))] overflow-hidden rounded-md border border-border bg-surface shadow-xl">
              <TransferList transfers={transfers} byId={byId} onClear={onClearTransfers} />
            </div>
          )}
        </div>



        {dropDir && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-end justify-center bg-accent/10 p-3 ring-2 ring-inset ring-accent">
            <span className="max-w-full truncate rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent shadow-lg">
              {t("files.dropTo", { where, path: dropDir })}
            </span>
          </div>
        )}

        {confirm && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
            <div role="alertdialog" aria-modal="false" className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl">
              {confirm.kind === "delete" ? (
                <DeleteConfirm
                  confirm={confirm}
                  where={where}
                  onTyped={(typed) => setConfirm({ ...confirm, typed })}
                  onCancel={() => {
                    setConfirm(null);
                    focusList();
                  }}
                  onConfirm={() => void doDelete(confirm.paths)}
                />
              ) : (
                <>
                  <p className="text-sm text-text">{t("files.dirty.message", { where })}</p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button onClick={() => confirm.resolve("cancel")} className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
                      {t("files.cancel")}
                    </button>
                    <button onClick={() => confirm.resolve("discard")} className="rounded px-3 py-1.5 text-xs text-coral hover:bg-coral/10">
                      {t("files.dirty.discard")}
                    </button>
                    <button autoFocus onClick={() => confirm.resolve("save")} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent">
                      {t("files.view.save")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {!maximized &&
        !moving &&
        HANDLES.map((h) => (
          <div key={h} onPointerDown={startResize(h)} aria-hidden="true" className={gripCursor[h]} style={gripStyle(h)} />
        ))}
    </>
  );
});

function DeleteConfirm({
  confirm,
  where,
  onTyped,
  onCancel,
  onConfirm,
}: {
  confirm: Extract<Confirm, { kind: "delete" }>;
  where: string;
  onTyped: (typed: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("terminal");
  const { paths, count, typed } = confirm;
  const total = count ? count.files + count.dirs : 0;
  const needsTyping = count !== null && (total >= TYPE_TO_CONFIRM || count.more);
  const word = baseName(paths[0]);
  const ok = count !== null && (!needsTyping || typed.trim() === word);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onConfirm();
      }}
    >
      <h3 className="text-sm font-semibold text-text">{t("files.del.title", { where })}</h3>
      <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto rounded bg-bg px-2 py-1.5 font-mono text-[11px] text-text">
        {paths.slice(0, 6).map((p) => (
          <li key={p} className="truncate" title={p}>
            {p}
          </li>
        ))}
        {paths.length > 6 && <li className="text-muted">{t("files.del.andMore", { count: paths.length - 6 })}</li>}
      </ul>
      <p className="mt-2 text-xs text-muted">
        {count === null
          ? t("files.del.counting")
          : t(count.more ? "files.del.countMore" : "files.del.count", { files: count.files, dirs: count.dirs })}
      </p>
      <p className="mt-1 text-xs text-coral">{t("files.del.noTrash")}</p>
      {needsTyping && (
        <label className="mt-3 block text-xs text-muted">
          {t("files.del.typeName", { name: word })}
          <input
            autoFocus
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            spellCheck={false}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-text outline-none focus:border-coral"
          />
        </label>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
          {t("files.cancel")}
        </button>
        <button
          type="submit"
          autoFocus={!needsTyping}
          disabled={!ok}
          className="rounded bg-coral px-3 py-1.5 text-xs font-medium text-on-coral disabled:opacity-40"
        >
          {t("files.del.confirm")}
        </button>
      </div>
    </form>
  );
}

function SortHead({
  label,
  k,
  sort,
  setSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  setSort: (s: { key: SortKey; desc: boolean }) => void;
  className: string;
}) {
  const active = sort.key === k;
  return (
    <button
      onClick={() => setSort({ key: k, desc: active ? !sort.desc : false })}
      className={`${className} shrink-0 truncate text-left uppercase hover:text-text ${active ? "text-text" : ""}`}
    >
      {label}
      {active && <span className="ml-0.5">{sort.desc ? "↓" : "↑"}</span>}
    </button>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (isDirLike(entry)) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 text-accent" aria-hidden="true">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  const kind = viewKind(entry.name);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className={`shrink-0 ${kind === "image" ? "text-amber" : "text-muted"}`} aria-hidden="true">
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6ZM9 2v4h4" />
      {kind === "text" && <path d="M5.5 9h5M5.5 11h3.5" strokeLinecap="round" />}
    </svg>
  );
}

const KNOWN_ERRORS = new Set(["not-connected", "no-such-file", "permission-denied", "exists", "conflict", "timeout", "too-large"]);

const HIDDEN_KEY = "protunel.files.showHidden";
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Only a preference.
  }
}
