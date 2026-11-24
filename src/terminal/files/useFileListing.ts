import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { filesHome, filesList } from "../../api";
import type { FileEntry } from "../../types";
import { isCurrentRequest } from "./panelLogic";
import { resolvePath } from "./paths";
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
  const loadSeq = useRef(0);

  /** Lists `dir`; the newest request wins (a slow listing never lands late). */
  const load = useCallback(
    async (dir: string, keep?: { select?: string[] }) => {
      const { setSelected, setCursor, setFilter, anchor, savedScroll, setScrollTop, listRef } = reset;
      const seq = ++loadSeq.current;
      setLoading(true);
      setError(null);
      try {
        const listing = await filesList(tunnelId, dir);
        if (!isCurrentRequest(seq, loadSeq.current)) return;
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
        if (!isCurrentRequest(seq, loadSeq.current)) return;
        setError(errorText(e));
      } finally {
        if (isCurrentRequest(seq, loadSeq.current)) setLoading(false);
      }
    },
    // `reset` holds only stable setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tunnelId, errorText, onMemory],
  );

  // First open: where this pane's panel last was, else the shell's folder,
  // else the login folder.
  useEffect(() => {
    // Shares `loadSeq` with `load`: a listing the user's navigation (or the
    // fallback below) has superseded never lands, and unmounting invalidates.
    const seq = ++loadSeq.current;
    const alive = () => isCurrentRequest(seq, loadSeq.current);
    void (async () => {
      let homeDir = "/";
      try {
        homeDir = await filesHome(tunnelId);
      } catch (e) {
        if (!alive()) return;
        setError(errorText(e));
        setLoading(false);
        return;
      }
      if (!alive()) return;
      setHome(homeDir);
      const guess = memory?.path ?? shellDir();
      const start = guess ? resolvePath(guess, homeDir, homeDir) : homeDir;
      try {
        const listing = await filesList(tunnelId, start);
        if (!alive()) return;
        setPath(listing.path);
        setEntries(listing.entries);
        onMemory({ path: listing.path });
        reset.setScrollTop(0);
      } catch {
        if (alive()) await load(homeDir);
      } finally {
        if (alive()) setLoading(false);
      }
    })();
    return () => {
      loadSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId]);

  return { home, path, entries, loading, error, load };
}
