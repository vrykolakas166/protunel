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
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  filesCount,
  filesCreate,
  filesDelete,
  filesDownload,
  filesPickDownload,
  filesOpenLocal,
  filesPickUpload,
  filesRename,
  editTunnelBookmark,
} from "../../api";
import { openMenu, openMenuBelow, type MenuEntry } from "../../contextMenu";
import type { FileEntry, FileTransfer, Tunnel } from "../../types";
import { dropLabelKey } from "./dropLogic";
import { FileDetails } from "./FileDetails";
import { FileRows } from "./FileRows";
import { FileView, type FileViewHandle } from "./FileView";
import { HANDLES, type Box, type Placement, type Size } from "./geometry";
import { NameBarForm } from "./NameBarForm";
import { PanelConfirm } from "./PanelConfirm";
import { PanelFooter, RelayHintBar } from "./PanelFooter";
import { PanelHeader } from "./PanelHeader";
import { PanelToolbar } from "./PanelToolbar";
import { applySelection } from "./selection";
import { recentFolders } from "./history";
import {
  COLUMNS_MIN,
  DETAILS_MIN,
  HIDDEN_KEY,
  ROW,
  getClipboard,
  invalidateDirs,
  onInvalidate,
  readFlag,
  setClipboard,
  subscribeClipboard,
  writeFlag,
  type Confirm,
  type NameBarState,
} from "./panelStore";
import { canPasteClip, knownErrorCode, pathsIn, type ClashChoices } from "./panelLogic";
import { handleListKey } from "./panelKeys";
import { backgroundMenuEntries, rowMenuEntries } from "./panelMenus";
import { baseName, isDirLike, joinPath, parentPath, resolvePath, sortEntries, validName, type SortKey } from "./paths";
import {
  beginRowDrag,
  cancelRowDragFrom,
  getRowDrag,
  subscribeRowDrag,
} from "./rowDrag";
import { usePanelDrops } from "./usePanelDrops";
import { useFileListing } from "./useFileListing";
import { useListScroll } from "./useListScroll";
import { gripCursor, usePanelGeometry } from "./usePanelGeometry";
import { involves, isActive, overallProgress } from "./useTransfers";

export interface FilePanelHandle {
  /** Path of the file open in the editor with unsaved changes, else null. */
  unsaved: () => string | null;
  /** Saves that file; false when it could not (conflict, lost session…). */
  saveUnsaved: () => Promise<boolean>;
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
  /** A live shell (terminal id) on `tunnelId`, the preferred pane first; null when none. */
  shellFor: (tunnelId: string, preferPaneId?: string) => string | null;
  /** The terminal id is still a live shell on that tunnel. */
  shellAlive: (termId: string, tunnelId: string) => boolean;
  transfers: FileTransfer[];
  byId: Record<string, Tunnel>;
  /** Clears this server's finished rows only. */
  onClearTransfers: (tunnelId: string) => void;
  /** An OS drag is over the window here (window px), or null. */
  dropHover: { x: number; y: number } | null;
  onClose: () => void;
  onFocusShell: () => void;
  /** The editor gained or lost unsaved changes (false when the panel goes). */
  onUnsaved?: (dirty: boolean) => void;
}


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
    shellFor,
    shellAlive,
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
  // The server this panel's listing and editor belong to. When the host is
  // edited to reach another one, everything here is inert until the user
  // reloads on the new server: a delete or save meant for the old one must
  // never land on the new one at the same path.
  const endpointNow = `${tunnel.username}@${tunnel.host}:${tunnel.port}`;
  const [bound, setBound] = useState(endpointNow);
  const stale = endpointNow !== bound;
  const titleId = `file-panel-title-${paneId}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const { listRef, savedScroll, scrollTop, setScrollTop, listHeight, attachList, scrollIntoView } = useListScroll();
  const viewRef = useRef<FileViewHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const anchor = useRef(0);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [showHidden, setShowHidden] = useState(() => readFlag(HIDDEN_KEY));
  const [filter, setFilter] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [nameBar, setNameBar] = useState<NameBarState | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const clipboard = useSyncExternalStore(subscribeClipboard, getClipboard);
  const rowDrag = useSyncExternalStore(subscribeRowDrag, getRowDrag);
  const rowHover = rowDrag?.hover && rowDrag.hover.paneId === paneId ? rowDrag.hover : null;

  const { moving, snapGhost, startMove, startResize, positionMenu, gripStyle } = usePanelGeometry({
    rootRef,
    box,
    owner,
    bounds,
    placement,
    onPlacement,
    maximized,
    z,
    t,
  });

  const wide = box.w >= DETAILS_MIN;
  const columns = box.w >= COLUMNS_MIN;

  const errorText = useCallback(
    (e: unknown) => {
      const code = knownErrorCode(e);
      return code ? t(`files.err.${code}`, { where }) : String(e);
    },
    [t, where],
  );

  // ---- loading ----------------------------------------------------------

  const { home, path, entries, loading, error, load, refreshCurrent, retry, restart, go, canGo } = useFileListing({
    tunnelId,
    errorText,
    onMemory,
    memory,
    shellDir,
    reset: { setSelected, setCursor, setFilter, anchor, savedScroll, setScrollTop, listRef },
  });

  const visible = useMemo(
    () => sortEntries(entries, sort.key, sort.desc, showHidden, filter),
    [entries, sort, showHidden, filter],
  );

  const refresh = useCallback(() => refreshCurrent([...selected]), [refreshCurrent, selected]);

  /** Tells the other panels on this server that these folders changed. */
  const changed = useCallback(
    (dirs: string[]) => invalidateDirs({ tunnelId, dirs, fromPaneId: paneId }),
    [tunnelId, paneId],
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pathNow = useRef(path);
  pathNow.current = path;
  useEffect(
    () =>
      onInvalidate((change) => {
        if (change.tunnelId !== tunnelId || change.fromPaneId === paneId) return;
        if (pathNow.current && change.dirs.includes(pathNow.current)) refreshRef.current();
      }),
    [tunnelId, paneId],
  );

  // Opening the panel is asking for it: the keyboard moves in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // A finished upload into the folder on screen shows up without a refresh.
  const seenDone = useRef(new Set<string>());
  useEffect(() => {
    let changed = false;
    for (const x of transfers) {
      if (x.state !== "done") continue;
      const uploadedHere = x.direction === "upload" && x.tunnelId === tunnelId;
      const copiedHere = x.direction === "copy" && x.destTunnelId === tunnelId;
      if (!uploadedHere && !copiedHere) continue;
      if (seenDone.current.has(x.id)) continue;
      seenDone.current.add(x.id);
      // An upload's remotePath is the new file; a copy's localPath is the folder.
      if (path && (copiedHere ? x.localPath === path : parentPath(x.remotePath) === path)) changed = true;
    }
    if (changed) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers]);

  // ---- list measurements --------------------------------------------------

  // A gesture started in this panel must not outlive it.
  useEffect(() => () => cancelRowDragFrom(paneId), [paneId]);

  // Clamped: a shorter list (filter, reload) can leave a stale position.
  const top = Math.min(scrollTop, Math.max(0, visible.length * ROW - listHeight));
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(visible.length, Math.ceil((top + listHeight) / ROW) + 5);

  // ---- actions ------------------------------------------------------------

  const pathsOf = (names: Iterable<string>) => pathsIn(path, names);
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
    void filesDownload(tunnelId, paths, bound)
      .then(() => {
        setQueueOpen(true);
      })
      .catch((e) => setNotice(errorText(e)));
  };

  const downloadTo = (paths = targets()) => {
    if (paths.length === 0) return;
    void filesPickDownload(tunnelId, paths, bound)
      .then((ids) => {
        if (ids.length > 0) setQueueOpen(true);
      })
      .catch((e) => setNotice(errorText(e)));
  };

  const openLocal = (p: string) => {
    void filesOpenLocal(tunnelId, p, bound).catch((e) => setNotice(errorText(e)));
    setNotice(t("files.openingLocal", { name: baseName(p) }));
  };

  const upload = () => {
    if (!path) return;
    const dir = path;
    // Taken before the picker: a panel closed or reloaded meanwhile sends nothing.
    const gen = generationRef.current;
    void filesPickUpload()
      .then((paths) => {
        if (paths.length > 0 && gen === generationRef.current) return uploadInto(paths, dir, gen);
      })
      .catch((e) => setNotice(errorText(e)));
  };

  const copyToClipboard = (cut: boolean) => {
    const paths = targets();
    if (paths.length === 0) return;
    setClipboard({ tunnelId, endpoint: bound, paneId, paths, cut });
    setNotice(t(cut ? "files.cutCount" : "files.copiedCount", { count: paths.length }));
  };

  // Cut stays on one server; a copy can be pasted on any other server.
  const canPaste = canPasteClip(clipboard, tunnelId);

  // One question at a time: an arrival while another question is up is
  // refused (said in the notice), never queued behind it or put over it.
  const confirmRef = useRef<Confirm | null>(null);
  confirmRef.current = confirm;
  const askClash = (names: string[], dir: string, total: number) =>
    new Promise<ClashChoices | null>((resolve) => {
      if (confirmRef.current) {
        setNotice(t("files.clash.busy"));
        return resolve(null);
      }
      let settled = false;
      const next: Confirm = {
        kind: "clash",
        names,
        dir,
        total,
        resolve: (choices) => {
          if (settled) return;
          settled = true;
          confirmRef.current = null;
          setConfirm(null);
          resolve(choices);
          focusList();
        },
      };
      confirmRef.current = next;
      setConfirm(next);
    });
  /** Closes whatever question is up, answering it "cancel". */
  const dismissConfirm = () => {
    const open = confirmRef.current;
    if (open?.kind === "dirty") open.resolve("cancel");
    else if (open?.kind === "clash") open.resolve(null);
    confirmRef.current = null;
    setConfirm(null);
  };
  const dismissRef = useRef(dismissConfirm);
  dismissRef.current = dismissConfirm;
  // See `usePanelDrops` `generation`.
  const generationRef = useRef(0);
  // A panel closing never leaves an operation waiting on its question.
  useEffect(
    () => () => {
      generationRef.current++;
      dismissRef.current();
    },
    [],
  );

  const { dropDir, relayHint, setRelayHint, preparing, paste, hintShellAlive, typeRelayHint, dropFiles, uploadInto } = usePanelDrops({
    paneId,
    tunnelId,
    stale,
    endpoint: bound,
    generation: () => generationRef.current,
    changed,
    askClash,
    refreshCurrent,
    path,
    entries,
    viewing,
    error,
    refresh,
    errorText,
    t,
    setNotice,
    setQueueOpen,
    shellFor,
    shellAlive,
    dropHover,
  });

  const askDelete = (paths = targets()) => {
    if (paths.length === 0) return;
    if (confirmRef.current) return setNotice(t("files.clash.busy"));
    const next: Confirm = { kind: "delete", paths, count: null, typed: "" };
    confirmRef.current = next;
    setConfirm(next);
    filesCount(tunnelId, paths)
      .then((count) =>
        setConfirm((c) => (c?.kind === "delete" && c.paths === paths ? { ...c, count } : c)),
      )
      .catch((e) => {
        // Only this question: never one that took its place meanwhile.
        if (confirmRef.current !== next && !(confirmRef.current?.kind === "delete" && confirmRef.current.paths === paths)) return;
        confirmRef.current = null;
        setConfirm(null);
        setNotice(errorText(e));
      });
  };

  const doDelete = async (paths: string[]) => {
    setConfirm(null);
    setNotice(t("files.deleting"));
    try {
      await filesDelete(tunnelId, paths, bound);
      setNotice(null);
    } catch (e) {
      setNotice(errorText(e));
    }
    // Partly done or not, the folders may have changed.
    changed([...new Set(paths.map(parentPath))]);
    refresh();
    focusList();
  };

  // A name typed for one folder never applies in another: navigating away
  // closes the bar (a rename of "config" in A must not rename B's "config").
  useEffect(() => setNameBar(null), [path]);

  const submitName = async () => {
    if (!nameBar || !path || !validName(nameBar.value)) return;
    const name = nameBar.value.trim();
    try {
      if (nameBar.kind === "rename") {
        if (name !== nameBar.from) await filesRename(tunnelId, joinPath(path, nameBar.from), joinPath(path, name), bound);
      } else {
        await filesCreate(tunnelId, joinPath(path, name), nameBar.kind === "dir", bound);
      }
      setNameBar(null);
      changed([path]);
      await load(path, { select: [name], background: true });
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

  /** Bookmarks (saved with the host) and the host's recent folders. */
  const foldersMenu = (e: ReactMouseEvent) => {
    if (!path) return;
    const marks = tunnel.bookmarks ?? [];
    const marked = marks.includes(path);
    const recent = recentFolders(tunnelId).filter((p) => p !== path && !marks.includes(p));
    const goTo = (dir: string) => () => {
      void load(dir);
      focusList();
    };
    openMenuBelow(e.currentTarget, [
      {
        label: marked ? t("files.folders.remove") : t("files.folders.add"),
        action: () =>
          void editTunnelBookmark(tunnelId, path, !marked).catch((err: unknown) =>
            setNotice(String(err) === "too-many-bookmarks" ? t("files.folders.tooMany") : errorText(err)),
          ),
      },
      { label: t("files.homeLabel"), action: goTo(home) },
      { label: t("files.shellDir"), action: () => void goShellDir() },
      ...(marks.length > 0
        ? (["separator", { label: t("files.folders.bookmarks"), action: () => {}, enabled: false }] as MenuEntry[])
        : []),
      ...marks.map((dir) => ({ label: dir, action: goTo(dir), enabled: dir !== path })),
      ...(recent.length > 0
        ? (["separator", { label: t("files.folders.recent"), action: () => {}, enabled: false }] as MenuEntry[])
        : []),
      ...recent.map((dir) => ({ label: dir, action: goTo(dir) })),
    ]);
  };

  // ---- closing ------------------------------------------------------------

  /** Unsaved edits: Save / Discard / Cancel. True when it is fine to leave. */
  const settleDirty = async (): Promise<boolean> => {
    if (!viewRef.current?.dirty()) return true;
    // Stale: saving would reach the wrong server; the edits go to a local draft.
    if (stale) return viewRef.current.saveDraft();
    if (confirmRef.current?.kind === "clash") confirmRef.current.resolve(null);
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

  /** Reload on the server the host reaches now; unsaved edits are kept as a local file first. */
  const reloadOnNewServer = async () => {
    if (viewRef.current?.dirty() && !(await viewRef.current.saveDraft())) return;
    setViewing(null);
    setDetails(null);
    setNameBar(null);
    generationRef.current++;
    dismissConfirm();
    // A notice from work on the old server ("Copying…") is not this one's.
    setNotice(null);
    setBound(endpointNow);
    restart();
  };

  useImperativeHandle(ref, () => ({
    unsaved: () => (viewing && viewRef.current?.dirty() ? viewing : null),
    // Stale: the host reaches another server now, so "save" keeps a local draft.
    saveUnsaved: async () => (stale ? viewRef.current?.saveDraft() : viewRef.current?.save()) ?? true,
    focus: () => {
      if (rootRef.current?.contains(document.activeElement)) return;
      if (viewing) rootRef.current?.querySelector<HTMLElement>(".cm-content")?.focus();
      else listRef.current?.focus();
    },
    drop: (paths, x, y) => {
      if (!stale) dropFiles(paths, x, y);
    },
  }));

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
    openMenu(
      e,
      rowMenuEntries(t, {
        entry,
        many,
        full,
        canPaste,
        open: () => open(entry),
        download: () => download(paths),
        downloadTo: () => downloadTo(paths),
        openLocal: () => openLocal(full),
        copy: () => setClipboard({ tunnelId, endpoint: bound, paneId, paths, cut: false }),
        cut: () => setClipboard({ tunnelId, endpoint: bound, paneId, paths, cut: true }),
        paste: () => void paste(),
        rename: () => setNameBar({ kind: "rename", from: entry.name, value: entry.name }),
        copyPath: () => copyPath(full),
        properties: () => setDetails(full),
        del: () => askDelete(paths),
      }),
    );
  };

  const backgroundMenu = (e: ReactMouseEvent) => {
    openMenu(
      e,
      backgroundMenuEntries(t, {
        path,
        canPaste,
        showHidden,
        newDir: () => setNameBar({ kind: "dir", value: "" }),
        newFile: () => setNameBar({ kind: "file", value: "" }),
        paste: () => void paste(),
        upload,
        refresh,
        toggleHidden,
        copyPath,
      }),
    );
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
    const startAnchor = anchor.current;
    const names = visible.map((x) => x.name);
    setSelected((prev) => applySelection(names, prev, startAnchor, index, mode).selected);
    // Same rule as applySelection: only/toggle move the anchor, range keeps it.
    if (mode !== "range") anchor.current = index;
    scrollIntoView(index);
  };

  // ---- keyboard -------------------------------------------------------------

  const onListKey = (e: ReactKeyboardEvent) =>
    handleListKey(e, {
      visible,
      cursor,
      current,
      path,
      listHeight,
      filterRef,
      selectAt,
      open,
      goUp,
      go,
      refresh,
      askDelete: () => askDelete(),
      paste,
      copyToClipboard,
      setDetails,
      setNameBar,
      selectAll: () => setSelected(new Set(visible.map((x) => x.name))),
      setPathEdit,
    });

  /** Esc unwinds one layer at a time; the panel closes last. */
  const onRootKey = (e: ReactKeyboardEvent) => {
    // Back / Forward from anywhere in the panel but text being edited (the
    // list handles its own; the toolbar buttons show the keys).
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      const el = e.target as HTMLElement;
      if (!e.defaultPrevented && !confirm && !viewing && !el.closest("input, textarea, .cm-editor")) {
        e.preventDefault();
        go(e.key === "ArrowLeft" ? -1 : 1);
      }
      return;
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (confirm) {
      if (confirm.kind === "dirty") confirm.resolve("cancel");
      else if (confirm.kind === "clash") confirm.resolve(null);
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

  // Only this server's transfers (from or to it): other panels' uploads and
  // downloads are none of this panel's business.
  const activeHere = transfers.filter((x) => involves(x, tunnelId));
  const running = activeHere.filter(isActive);
  const progress = overallProgress(activeHere);

  const onRowPointerDown = (e: React.PointerEvent<HTMLElement>, entry: FileEntry, index: number, isSelected: boolean) => {
    if (e.button !== 0 || e.shiftKey || !path) return;
    // The rows that travel: the selection when this row is in it.
    const names = isSelected ? [...selected] : [entry.name];
    beginRowDrag(e, { paneId, tunnelId, endpoint: bound, dir: path, paths: pathsOf(names) }, () => {
      if (e.ctrlKey || e.metaKey) selectAt(index, "toggle");
      else if (isSelected && selected.size > 1) selectAt(index, "only");
    });
  };
  const onRowMouseDown = (e: ReactMouseEvent, index: number, isSelected: boolean) => {
    if (e.button !== 0) return;
    // Ctrl/Meta: toggled on release without a drag (onPlainClick), so a Ctrl-drag never changes the selection.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return;
    // Pressing inside a multi-selection keeps it: it may be about to be dragged.
    if (isSelected && selected.size > 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      setCursor(index);
      return;
    }
    selectAt(index, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only");
  };

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
        data-tour="term-file-panel"
        onKeyDown={onRootKey}
        onPointerDownCapture={onRaise}
        onFocusCapture={onRaise}
        className={`@container fixed z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl outline-none focus-within:border-accent ${
          moving ? "opacity-95" : ""
        }`}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z }}
      >
        <PanelHeader
          titleId={titleId}
          where={where}
          tunnel={tunnel}
          target={target}
          maximized={maximized}
          onPointerDown={startMove}
          onToggleMaximize={onToggleMaximize}
          onPositionMenu={positionMenu}
          onFocusShell={onFocusShell}
          onCloseClick={() => void settleDirty().then((ok) => ok && onClose())}
        />

        {stale && (
          <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-amber/15 px-3 py-2 text-xs text-text">
            <span className="min-w-0 flex-1">{t("files.stale", { now: endpointNow.replace(/:22$/, ""), was: bound.replace(/:22$/, "") })}</span>
            <button
              onClick={() => void reloadOnNewServer()}
              className="rounded bg-amber px-2.5 py-1 text-xs font-medium text-on-amber hover:opacity-90"
            >
              {t("files.staleReload", { now: endpointNow.replace(/:22$/, "") })}
            </button>
          </div>
        )}

        <div inert={stale} className="contents">

        {viewing ? (
          <FileView
            ref={viewRef}
            tunnelId={tunnelId}
            path={viewing}
            endpoint={bound}
            where={where}
            onBack={() => void closeView()}
            onDownload={() => download([viewing])}
            onOpenLocal={() => openLocal(viewing)}
            onSaved={() => setNotice(t("files.view.saved"))}
            onDirty={props.onUnsaved}
            errorText={errorText}
          />
        ) : (
          <>
            <PanelToolbar
              path={path}
              home={home}
              pathEdit={pathEdit}
              setPathEdit={setPathEdit}
              pathInputRef={pathInputRef}
              filterRef={filterRef}
              filter={filter}
              onFilter={(v) => {
                setFilter(v);
                setCursor(0);
              }}
              onFilterEnter={() => {
                if (visible[0]) selectAt(0, "only");
              }}
              canDownload={!!current || selected.size > 0}
              load={load}
              goUp={goUp}
              go={go}
              canGo={canGo}
              bookmarked={!!path && (tunnel.bookmarks ?? []).includes(path)}
              onFolders={foldersMenu}
              goShellDir={goShellDir}
              refresh={refresh}
              upload={upload}
              download={() => download()}
              downloadTo={() => downloadTo()}
              newDir={() => setNameBar({ kind: "dir", value: "" })}
              newFile={() => setNameBar({ kind: "file", value: "" })}
              focusList={focusList}
            />

            {nameBar && <NameBarForm nameBar={nameBar} setNameBar={setNameBar} onSubmit={() => void submitName()} />}

            <div className="flex min-h-0 flex-1">
              {(!details || wide) && (
                <FileRows
                  attachList={attachList}
                  visible={visible}
                  first={first}
                  last={last}
                  path={path}
                  home={home}
                  tunnelId={tunnelId}
                  loading={loading}
                  error={error}
                  filter={filter}
                  selected={selected}
                  cursor={cursor}
                  clipboard={clipboard}
                  hoverDir={rowHover?.dir ?? dropDir}
                  preparing={preparing}
                  sort={sort}
                  setSort={setSort}
                  columns={columns}
                  wide={wide}
                  details={details}
                  onKeyDown={onListKey}
                  onScroll={setScrollTop}
                  onBackgroundMenu={backgroundMenu}
                  onRetry={retry}
                  onRowPointerDown={onRowPointerDown}
                  onRowMouseDown={onRowMouseDown}
                  onRowOpen={open}
                  onRowMenu={rowMenu}
                />
              )}
              {details && (
                <div className={`flex min-h-0 flex-col ${wide ? "w-72 shrink-0 border-l border-border" : "flex-1"}`}>
                  <FileDetails tunnelId={tunnelId} path={details} onClose={() => setDetails(null)} errorText={errorText} />
                </div>
              )}
            </div>
          </>
        )}

        <PanelFooter
          notice={notice}
          selectedCount={selected.size}
          itemCount={visible.length}
          canPaste={canPaste}
          clipboard={clipboard}
          onPaste={() => void paste()}
          running={running.length}
          progress={progress}
          queueOpen={queueOpen}
          toggleQueue={() => setQueueOpen((v) => !v)}
          transfers={activeHere}
          byId={byId}
          onClearTransfers={() => onClearTransfers(tunnelId)}
        />

        {relayHint && (
          <RelayHintBar
            relayHint={relayHint}
            where={where}
            byId={byId}
            shellAlive={hintShellAlive}
            onType={typeRelayHint}
            onCopied={() => setNotice(t("files.pathCopied"))}
            onDismiss={() => setRelayHint(null)}
          />
        )}

        {(rowHover || dropDir) && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-end justify-center bg-accent/10 p-3 ring-2 ring-inset ring-accent">
            <span className="max-w-full truncate rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent shadow-lg">
              {rowHover
                ? t(dropLabelKey(rowHover.plan) ?? "files.dropCopy", { where, path: rowHover.dir })
                : t("files.dropTo", { where, path: dropDir })}
            </span>
          </div>
        )}

        {rowDrag &&
          rowDrag.payload.paneId === paneId &&
          createPortal(
            <div
              className="pointer-events-none fixed z-[80] rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-xl"
              style={{ left: rowDrag.x + 12, top: rowDrag.y + 10 }}
            >
              {t("files.dragLabel", { count: rowDrag.payload.paths.length })}
            </div>,
            document.body,
          )}

        {confirm && (
          <PanelConfirm
            confirm={confirm}
            where={where}
            setConfirm={setConfirm}
            onDelete={(paths) => void doDelete(paths)}
            focusList={focusList}
          />
        )}
        </div>
      </div>
      {!maximized &&
        !moving &&
        HANDLES.map((h) => (
          <div key={h} onPointerDown={startResize(h)} aria-hidden="true" className={gripCursor[h]} style={gripStyle(h)} />
        ))}
    </>
  );
});
