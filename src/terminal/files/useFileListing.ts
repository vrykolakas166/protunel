import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { filesHome, filesList } from "../../api";
import type { FileEntry } from "../../types";
import { isCurrentRequest } from "./panelLogic";
import { resolvePath } from "./paths";
import { EMPTY_HISTORY, moveTo, recentFolders, rememberFolder, step, visit, type History } from "./history";
import type { PaneFiles } from "./FilePanel";

/** What a finished listing resets in the view (all stable setters/refs). */
export interface ListingReset {
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setCursor: Dispatch<SetStateAction<number>>;
  setFilter: Dispatch<SetStateAction<string>>;
  anchor: MutableRefObject<number>;
  savedScroll: MutableRefObject<number>;
  setScrollTop: Dispatch<SetStateAction<number>>;
  listRef: MutableRefObject<HTMLDivElement | null>;
}

interface Args {
  tunnelId: string;
  errorText: (e: unknown) => string;
  onMemory: (memory: PaneFiles) => void;
  memory: PaneFiles | undefined;
  shellDir: () => string | null;
  reset: ListingReset;
}

/** How a listing is asked for. */
export interface LoadOptions {
  /** Names to select once listed. */
  select?: string[];
  /**
   * A refresh nobody navigated for (a transfer finished, another panel
   * changed the folder): skipped while a navigation is pending, so it never
   * undoes one, and it keeps the filter and scroll position.
   */
  background?: boolean;
  /** Back/Forward: the history position this listing lands on. */
  historyIndex?: number;
}

/**
 * The folder on screen: listing, the `loadSeq` stale-listing guard (the newest
 * request wins, a slow listing never lands late) and the first-open lookup.
 */
export function useFileListing({ tunnelId, errorText, onMemory, memory, shellDir, reset }: Args) {
  const [home, setHome] = useState("/");
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The listing that failed (folder and history step), for Retry. */
  const failed = useRef<{ dir: string; keep?: LoadOptions } | null>(null);
  const loadSeq = useRef(0);
  /** The seq of a navigation still in flight, else 0. */
  const navigating = useRef(0);
  /** The login folder was found (a first open while disconnected has not). */
  const homeKnown = useRef(false);
  const pathRef = useRef<string | null>(null);
  pathRef.current = path;
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);

  /** A folder now on screen by navigation: history and the host's recent list. */
  const arrived = (listed: string, historyIndex?: number) => {
    setHistory((h) => (historyIndex === undefined ? visit(h, listed) : moveTo(h, historyIndex, listed)));
    rememberFolder(tunnelId, listed);
  };

  /** Lists `dir`; the newest request wins (a slow listing never lands late). */
  const load = useCallback(
    async (dir: string, keep?: LoadOptions) => {
      const { setSelected, setCursor, setFilter, anchor, savedScroll, setScrollTop, listRef } = reset;
      const background = !!keep?.background;
      if (background && navigating.current) return;
      const seq = ++loadSeq.current;
      if (!background) {
        navigating.current = seq;
        setLoading(true);
        setError(null);
      }
      try {
        const listing = await filesList(tunnelId, dir);
        if (!isCurrentRequest(seq, loadSeq.current)) return;
        const samePlace = background && listing.path === pathRef.current;
        if (!background) arrived(listing.path, keep?.historyIndex);
        setPath(listing.path);
        setEntries(listing.entries);
        setError(null);
        onMemory({ path: listing.path });
        const keepNames = new Set(keep?.select ?? []);
        setSelected(keepNames);
        if (!samePlace) {
          setCursor(0);
          anchor.current = 0;
          setFilter("");
          savedScroll.current = 0;
          setScrollTop(0);
          if (listRef.current) listRef.current.scrollTop = 0;
        }
      } catch (e) {
        if (!isCurrentRequest(seq, loadSeq.current)) return;
        if (!background) {
          failed.current = { dir, keep: keep?.historyIndex === undefined ? undefined : { historyIndex: keep.historyIndex } };
          setError(errorText(e));
        }
      } finally {
        if (isCurrentRequest(seq, loadSeq.current)) {
          navigating.current = 0;
          setLoading(false);
        }
      }
    },
    // `reset` holds only stable setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tunnelId, errorText, onMemory],
  );

  /** Re-lists the folder on screen now (not one captured earlier), quietly.
   *  `select` applies only when that folder is `onlyIn` (if given). */
  const refreshCurrent = useCallback(
    (select?: string[], onlyIn?: string) => {
      const dir = pathRef.current;
      if (!dir) return;
      const names = onlyIn === undefined || onlyIn === dir ? select : [];
      void load(dir, { select: names, background: true });
    },
    [load],
  );

  // First open: where this pane's panel last was, else the shell's folder,
  // else the login folder. Run again by Retry while the login folder is
  // still unknown (opened while disconnected).
  const init = useCallback(() => {
    // Shares `loadSeq` with `load`: a listing the user's navigation (or the
    // fallback below) has superseded never lands, and unmounting invalidates.
    const seq = ++loadSeq.current;
    navigating.current = seq;
    const alive = () => isCurrentRequest(seq, loadSeq.current);
    setLoading(true);
    setError(null);
    void (async () => {
      let homeDir = "/";
      try {
        homeDir = await filesHome(tunnelId);
      } catch (e) {
        if (!alive()) return;
        navigating.current = 0;
        setError(errorText(e));
        setLoading(false);
        return;
      }
      if (!alive()) return;
      homeKnown.current = true;
      setHome(homeDir);
      const guess = pathRef.current ?? memory?.path ?? shellDir() ?? recentFolders(tunnelId)[0] ?? null;
      const start = guess ? resolvePath(guess, homeDir, homeDir) : homeDir;
      try {
        const listing = await filesList(tunnelId, start);
        if (!alive()) return;
        arrived(listing.path);
        setPath(listing.path);
        setEntries(listing.entries);
        onMemory({ path: listing.path });
        reset.setScrollTop(0);
      } catch {
        if (alive()) {
          navigating.current = 0;
          await load(homeDir);
        }
      } finally {
        if (alive()) {
          navigating.current = 0;
          setLoading(false);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId, errorText, onMemory, load]);

  useEffect(() => {
    homeKnown.current = false;
    init();
    return () => {
      loadSeq.current++;
      navigating.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId]);

  /** Starts over (the tunnel now reaches another server): the first-open lookup again. */
  const restart = useCallback(() => {
    homeKnown.current = false;
    setHistory(EMPTY_HISTORY);
    init();
  }, [init]);

  /** Retry after an error: the whole first-open lookup when it never finished. */
  const retry = useCallback(
    (dir: string) => {
      if (!homeKnown.current) return init();
      // The folder that failed (a Back, a bookmark), not the one left behind.
      const again = failed.current;
      failed.current = null;
      void (again ? load(again.dir, again.keep) : load(dir));
    },
    [init, load],
  );

  /** Back (-1) / Forward (+1) through this panel's folders. */
  const go = useCallback(
    (delta: -1 | 1) => {
      const to = step(history, delta);
      if (to) void load(to.path, { historyIndex: to.index });
    },
    [history, load],
  );
  const canGo = { back: !!step(history, -1), forward: !!step(history, 1) };

  return { home, path, entries, loading, error, load, refreshCurrent, retry, restart, go, canGo };
}
