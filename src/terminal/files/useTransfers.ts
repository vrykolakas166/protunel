import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { filesClearTransfers, filesTransfers } from "../../api";
import type { FileTransfer } from "../../types";

export const isActive = (t: FileTransfer) => t.state === "queued" || t.state === "running";

/** The transfer queue (Rust owns it): seeded once, then kept live by events. */
export function useTransfers(): { transfers: FileTransfer[]; clearFinished: () => void } {
  const [list, setList] = useState<FileTransfer[]>([]);
  useEffect(() => {
    let alive = true;
    const merge = (t: FileTransfer) =>
      setList((prev) => {
        const i = prev.findIndex((x) => x.id === t.id);
        if (i < 0) return [...prev, t];
        const next = prev.slice();
        next[i] = t;
        return next;
      });
    const unlisten = listen<FileTransfer>("file-transfer", (e) => merge(e.payload));
    filesTransfers()
      .then((seed) => {
        if (!alive) return;
        // Events that arrived meanwhile are newer than the snapshot.
        setList((prev) => [...seed.filter((s) => !prev.some((p) => p.id === s.id)), ...prev]);
      })
      .catch(() => {});
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, []);
  const clearFinished = () => {
    setList((prev) => prev.filter(isActive));
    void filesClearTransfers().catch(() => {});
  };
  return { transfers: list, clearFinished };
}

/** Done/total over the active transfers, 0..1, or null when nothing runs. */
export function overallProgress(list: FileTransfer[]): number | null {
  const active = list.filter(isActive);
  if (active.length === 0) return null;
  const total = active.reduce((n, t) => n + t.total, 0);
  return total > 0 ? active.reduce((n, t) => n + t.done, 0) / total : 0;
}
