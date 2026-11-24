import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { filesCopyAcross, filesDragOut, filesPaste, filesUpload, terminalWrite } from "../../api";
import type { CopyAcross, FileEntry } from "../../types";
import { dropDirFor, type DropPlan } from "./dropLogic";
import { canPasteClip } from "./panelLogic";
import { getClipboard, setClipboard, type RelayHint } from "./panelStore";
import { baseName, isDirLike, joinPath } from "./paths";
import { isWindows } from "../../platform";
import { onRowDragLeaveWindow, registerRowReceiver, rowReceiver, type RowDragPayload } from "./rowDrag";

interface Args {
  paneId: string;
  tunnelId: string;
  path: string | null;
  entries: FileEntry[];
  viewing: string | null;
  error: string | null;
  load: (dir: string, keep?: { select?: string[] }) => unknown;
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
  path,
  entries,
  viewing,
  error,
  load,
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

  /** Server-to-server copy into `dir`; the queue shows progress, and a relayed one offers the key hint. */
  const copyAcross = async (from: string, fromPaneId: string, paths: string[], dir: string) => {
    setNotice(t("files.copying"));
    try {
      const out: CopyAcross = await filesCopyAcross(from, paths, tunnelId, dir, false);
      setNotice(null);
      setQueueOpen(true);
      setRelayHint(out.route === "relay" && out.keyHint ? { fromTunnelId: from, termId: shellFor(from, fromPaneId), command: out.keyHint } : null);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Same-server copy or move (`files_paste`) into `dir`. */
  const pasteHere = async (paths: string[], dir: string, cut: boolean) => {
    setNotice(t("files.pasting"));
    try {
      const out = await filesPaste(tunnelId, paths, dir, cut);
      setNotice(
        out.skipped.length > 0
          ? t("files.pasteSkipped", { count: out.skipped.length, names: out.skipped.map(baseName).join(", ") })
          : null,
      );
      if (path) void load(path, { select: dir === path ? out.done.map(baseName) : [] });
      return true;
    } catch (e) {
      setNotice(errorText(e));
      refresh();
      return false;
    }
  };

  const paste = async () => {
    // Re-read the store: this panel's render may predate another panel's Copy/Cut.
    const clip = getClipboard();
    if (!path || !clip || !canPasteClip(clip, tunnelId)) return;
    if (clip.tunnelId !== tunnelId) return void (await copyAcross(clip.tunnelId, clip.paneId, clip.paths, path));
    if ((await pasteHere(clip.paths, path, clip.cut)) && clip.cut && getClipboard() === clip) {
      setClipboard(null);
    }
  };

  // ---- rows dragged between panels --------------------------------------------

  /** The folder a row drop at window point (x, y) goes to: a folder row, else the open folder. */
  const rowDropDir = (x: number, y: number): string | null => {
    if (!path || viewing || error) return null;
    const name = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-row]")?.dataset.fileRow;
    return dropDirFor(path, name ? entries.find((e) => e.name === name) : undefined);
  };
  const receiveRows = async (payload: RowDragPayload, dir: string, plan: DropPlan) => {
    if (plan.kind === "across") return void (await copyAcross(payload.tunnelId, payload.paneId, payload.paths, dir));
    if (plan.kind === "none") return;
    const ok = await pasteHere(payload.paths, dir, plan.kind === "move");
    // A move empties the source folder; another panel may be showing it.
    if (ok && plan.kind === "move" && payload.paneId !== paneId) rowReceiver(payload.paneId)?.refresh();
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
      filesDragOut(payload.tunnelId, payload.paths)
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

  /** Local paths dropped from the OS at window point (x, y). */
  const dropFiles = (paths: string[], x: number, y: number) => {
    const dir = dirAt(x, y) ?? path;
    setDropDir(null);
    if (!dir || paths.length === 0) return;
    void filesUpload(tunnelId, paths, dir, false)
      .then(() => setQueueOpen(true))
      .catch((e) => setNotice(errorText(e)));
  };

  return { dropDir, relayHint, setRelayHint, preparing, paste, hintShellAlive, typeRelayHint, dropFiles };
}
