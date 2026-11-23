import { useEffect, useMemo, useRef, useState } from "react";
import type { Tunnel } from "../types";

/**
 * The tunnel list's search: Ctrl+F drops the box in, Escape (or closing it)
 * takes it back out and clears the filter, so a closed box never leaves the
 * list silently filtered with no visible reason why. Matches name, host or group.
 */
export function useTunnelSearch(tunnels: Tunnel[]) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tunnels;
    // A group's name matches every host in it.
    return tunnels.filter(
      (tun) =>
        tun.name.toLowerCase().includes(q) ||
        tun.host.toLowerCase().includes(q) ||
        (tun.group ?? "").toLowerCase().includes(q),
    );
  }, [tunnels, query]);

  return {
    query,
    setQuery,
    open,
    inputRef,
    filtered,
    close,
    toggle: () => (open ? close() : setOpen(true)),
  };
}
