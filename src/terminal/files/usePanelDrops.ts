import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { filesCopyAcross, filesDragOut, filesExisting, filesPaste, filesUpload, terminalWrite } from "../../api";
import type { Conflict, CopyAcross, FileEntry } from "../../types";
import { dropDirFor, type DropPlan } from "./dropLogic";
import { canPasteClip, chooseConflicts, duplicateNames, type ClashChoices } from "./panelLogic";
import { getClipboard, setClipboard, type RelayHint } from "./panelStore";
import { baseName, isDirLike, joinPath, parentPath } from "./paths";
import { isWindows } from "../../platform";

/** The last part of a local path: either separator on Windows, only "/" elsewhere. */
const localName = (p: string) => p.split(isWindows ? /[\\/]/ : "/").filter((c) => c && c !== ".").pop() ?? p;
/** The last part of a server path (POSIX: a backslash is part of the name). */
const remoteName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
import { onRowDragLeaveWindow, registerRowReceiver, type RowDragPayload } from "./rowDrag";

interface Args {
  paneId: string;
  tunnelId: string;
  /** The host now reaches another server: nothing may land here. */
  stale: boolean;
  /** The server (`user@host:port`) this panel shows: every job is bound to it. */
  endpoint: string;
  /** Tells the other panels on this server these folders changed. */
  changed: (dirs: string[]) => void;
  /**
   * Bumped when the panel closes or reloads on another server: a check
   * still on its way then asks nothing and sends nothing.
   */
  generation: () => number;
  /** Asks what to do with each of `names`, taken in `dir` (`total` items arriving); null: cancelled. */
  askClash: (names: string[], dir: string, total: number) => Promise<ClashChoices | null>;
  /** Re-lists the folder on screen now; `select` applies only if it is `dir`. */
  refreshCurrent: (select?: string[], dir?: string) => void;
  path: string | null;
  entries: FileEntry[];
  viewing: string | null;
  error: string | null;
  refresh: () => void;
  errorText: (e: unknown) => string;
  t: TFunction;
  setNotice: (notice: string | null) => void;
  setQueueOpen: (open: boolean) => void;
  shellFor: (tunnelId: string, preferPaneId?: string) => string | null;
  shellAlive: (termId: string, tunnelId: string) => boolean;
  /** An OS drag is over the window here (window px), or null. */
  dropHover: { x: number; y: number } | null;
}

/**
 * Everything that moves files into the panel from elsewhere: paste, server to
 * server copy (and its key hint), rows dragged between panels or out to
 * Explorer, and OS drops.
 */
export function usePanelDrops({
  paneId,
  tunnelId,
  stale,
  endpoint,
  generation,
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
}: Args) {
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [relayHint, setRelayHint] = useState<RelayHint | null>(null);

  /**
   * Splits `items` by what each does when its name is taken in `dir` on this
   * server: one question lists every clash (Skip / Replace / Keep both).
   * Null when the user cancelled or the check failed.
   */
  const splitByConflict = async (
    items: string[],
    dir: string,
    nameOf: (p: string) => string,
    gen: number,
  ): Promise<Map<Conflict, string[]> | null> => {
    const names = items.map(nameOf);
    // Two items for one name (from different folders) would race for it.
    const twice = duplicateNames(names);
    if (twice.length > 0) {
      setNotice(t("files.clash.twice", { names: twice.join(", ") }));
      return null;
    }
    if (gen !== generation()) return null;
    let taken: string[];
    try {
      taken = await filesExisting(tunnelId, dir, names, endpoint);
    } catch (e) {
      if (gen === generation()) setNotice(errorText(e));
      return null;
    }
    if (gen !== generation()) return null;
    const groups = await chooseConflicts(names, new Set(taken), (clashing) => askClash(clashing, dir, names.length));
    if (!groups || gen !== generation()) return null;
    const modeOf = new Map<string, Conflict>();
    for (const [mode, ns] of groups) for (const n of ns) modeOf.set(n, mode);
    const parts = new Map<Conflict, string[]>();
    items.forEach((item, i) => {
      const mode = modeOf.get(names[i]) ?? "skip";
      parts.set(mode, [...(parts.get(mode) ?? []), item]);
    });
    return parts;
  };

  /** Local files or folders into `dir`, asking about names already there. */
  const uploadInto = async (localPaths: string[], dir: string, gen = generation()) => {
    const parts = await splitByConflict(localPaths, dir, localName, gen);
    if (!parts) return;
    try {
      for (const [mode, paths] of parts) {
        // Each group checks again: the panel may have closed between two.
        if (gen !== generation()) return;
        await filesUpload(tunnelId, paths, dir, mode, endpoint);
      }
      if (gen === generation()) setQueueOpen(true);
    } catch (e) {
      if (gen === generation()) setNotice(errorText(e));
    }
  };

  /** Server-to-server copy into `dir`; the queue shows progress, and a relayed one offers the key hint. */
  const copyAcross = async (from: string, fromEndpoint: string, fromPaneId: string, paths: string[], dir: string) => {
    const gen = generation();
    const parts = await splitByConflict(paths, dir, remoteName, gen);
    if (!parts) return;
    setNotice(t("files.copying"));
    try {
      let hint: RelayHint | null = null;
      for (const [mode, some] of parts) {
        // Reloaded on another server meanwhile: stop, and leave its notices alone.
        if (gen !== generation()) return;
        const out: CopyAcross = await filesCopyAcross(from, some, tunnelId, dir, mode, fromEndpoint, endpoint);
        if (out.route === "relay" && out.keyHint) {
          hint = { fromTunnelId: from, termId: shellFor(from, fromPaneId), command: out.keyHint };
        }
      }
      if (gen !== generation()) return;
      setNotice(null);
      setQueueOpen(true);
      setRelayHint(hint);
    } catch (e) {
      if (gen === generation()) setNotice(errorText(e));
    }
  };

  /** Same-server copy or move (`files_paste`) into `dir`. */
  const pasteHere = async (paths: string[], dir: string, cut: boolean, from: string) => {
    setNotice(t("files.pasting"));
    try {
      const out = await filesPaste(tunnelId, paths, dir, cut, from);
      setNotice(
        out.skipped.length > 0
          ? t("files.pasteSkipped", { count: out.skipped.length, names: out.skipped.map(baseName).join(", ") })
          : null,
      );
      // The folder on screen now, not the one shown when the paste began.
      refreshCurrent(out.done.map(baseName), dir);
      changed(cut ? [dir, ...new Set(paths.map(parentPath))] : [dir]);
      return true;
    } catch (e) {
      setNotice(errorText(e));
      refresh();
      changed(cut ? [dir, ...new Set(paths.map(parentPath))] : [dir]);
      return false;
    }
  };

  const paste = async () => {
    // Re-read the store: this panel's render may predate another panel's Copy/Cut.
    const clip = getClipboard();
    if (!path || !clip || !canPasteClip(clip, tunnelId)) return;
    if (clip.tunnelId !== tunnelId) return void (await copyAcross(clip.tunnelId, clip.endpoint, clip.paneId, clip.paths, path));
    if ((await pasteHere(clip.paths, path, clip.cut, clip.endpoint)) && clip.cut && getClipboard() === clip) {
      setClipboard(null);
    }
  };

  // ---- rows dragged between panels --------------------------------------------

  /** The folder a row drop at window point (x, y) goes to: a folder row, else the open folder. */
  const rowDropDir = (x: number, y: number): string | null => {
    if (!path || viewing || error || stale) return null;
    const name = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-row]")?.dataset.fileRow;
    return dropDirFor(path, name ? entries.find((e) => e.name === name) : undefined);
  };
  const receiveRows = async (payload: RowDragPayload, dir: string, plan: DropPlan) => {
    if (plan.kind === "across") return void (await copyAcross(payload.tunnelId, payload.endpoint, payload.paneId, payload.paths, dir));
    if (plan.kind === "none") return;
    // A move empties the source folder: `pasteHere` tells the panels showing it.
    await pasteHere(payload.paths, dir, plan.kind === "move", payload.endpoint);
  };
  const receiverApi = useRef({ rowDropDir, receiveRows, refresh });
  receiverApi.current = { rowDropDir, receiveRows, refresh };
  useEffect(
    () =>
      registerRowReceiver(paneId, {
        tunnelId,
        resolve: (x, y) => receiverApi.current.rowDropDir(x, y),
        drop: (payload, dir, plan) => void receiverApi.current.receiveRows(payload, dir, plan),
        refresh: () => receiverApi.current.refresh(),
      }),
    [paneId, tunnelId],
  );

  // ---- rows dragged out of the window (Windows: Explorer, virtual files) -----

  /** Paths being listed before the OS drag starts; their rows show it. */
  const [preparing, setPreparing] = useState<string[] | null>(null);
  const dragOutApi = useRef({ errorText, t });
  dragOutApi.current = { errorText, t };
  useEffect(() => {
    if (!isWindows) return;
    return onRowDragLeaveWindow(({ payload }) => {
      if (payload.paneId !== paneId) return;
      const { errorText: errText, t: tr } = dragOutApi.current;
      setPreparing(payload.paths);
      setNotice(tr("files.dragOut.preparing"));
      // Resolves once the OS drag has started, or at once if the button was released while listing.
      filesDragOut(payload.tunnelId, payload.paths, payload.endpoint)
        .then(() => setNotice(null))
        .catch((e) => {
          const code = String(e);
          if (code === "too-many") setNotice(tr("files.dragOut.tooMany"));
          else if (code.startsWith("path-too-long:")) setNotice(tr("files.dragOut.pathTooLong", { path: code.slice("path-too-long:".length) }));
          else setNotice(errText(e));
        })
        .finally(() => setPreparing(null));
      return true;
    });
  }, [paneId]);

  // The hint is bound to the shell resolved when it was made; it is typed only
  // while that same shell is alive and still on that tunnel.
  const hintShellAlive = !!relayHint?.termId && shellAlive(relayHint.termId, relayHint.fromTunnelId);
  const typeRelayHint = () => {
    if (!relayHint?.termId || !shellAlive(relayHint.termId, relayHint.fromTunnelId)) return;
    // No newline: the user reads the command and presses Enter in that shell.
    terminalWrite(relayHint.termId, relayHint.command).then(
      () => {
        setRelayHint(null);
        setNotice(t("files.relay.typed"));
      },
      (e) => setNotice(errorText(e)),
    );
  };

  /** The folder a drop at window point (x, y) goes to: a folder row, else the open folder. */
  const dirAt = (x: number, y: number): string | null => {
    // Never into the folder behind an editor, an error or a stale listing.
    if (!path || viewing || error || stale) return null;
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-row]");
    const name = row?.dataset.fileRow;
    const entry = name ? entries.find((e) => e.name === name) : undefined;
    return entry && isDirLike(entry) ? joinPath(path, entry.name) : path;
  };
  useEffect(() => {
    setDropDir(dropHover ? dirAt(dropHover.x, dropHover.y) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropHover?.x, dropHover?.y, path, viewing, error, stale]);

  /** Local paths dropped from the OS at window point (x, y). */
  const dropFiles = (paths: string[], x: number, y: number) => {
    const dir = dirAt(x, y);
    setDropDir(null);
    if (!dir || paths.length === 0) return;
    void uploadInto(paths, dir);
  };

  return { dropDir, relayHint, setRelayHint, preparing, paste, hintShellAlive, typeRelayHint, dropFiles, uploadInto };
}
