import { useCallback, useEffect, useRef, useState } from "react";
import { ROW } from "./panelStore";

/**
 * The virtual list's scroll bookkeeping. The list unmounts while a file is open
 * (and behind narrow details): on every mount it gets its scroll back and its
 * size measured again, so the virtual window never points at rows from a stale
 * position.
 */
export function useListScroll() {
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The list's scroll position, kept while it is unmounted (file open, narrow details). */
  const savedScroll = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(300);

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

  const scrollIntoView = (index: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = index * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  };

  return { listRef, savedScroll, scrollTop, setScrollTop, listHeight, attachList, scrollIntoView };
}
