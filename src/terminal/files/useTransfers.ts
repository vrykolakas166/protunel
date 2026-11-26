import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { filesClearTransfers, filesTransfers } from "../../api";
import type { FileTransfer } from "../../types";

export const isActive = (t: FileTransfer) => t.state === "queued" || t.state === "running";

/** A transfer belongs to a server's panel when it reads from or writes to it. */
export const involves = (t: FileTransfer, tunnelId: string) => t.tunnelId === tunnelId || t.destTunnelId === tunnelId;

/** The transfer queue (Rust owns it): seeded once, then kept live by events. */
export function useTransfers(): { transfers: FileTransfer[]; clearFinished: (tunnelId?: string) => void } {
  const [list, setList] = useState<FileTransfer[]>([]);
  useEffect(() => {
    let alive = true;
    // Rows removed while the snapshot is on its way must not come back with it.
    const removed = new Set<string>();
    const merge = (t: FileTransfer) => {
      // A late update for a row already removed (retried) never brings it back.
      if (removed.has(t.id)) return;
      setList((prev) => {
        const i = prev.findIndex((x) => x.id === t.id);
        if (i < 0) return [...prev, t];
        const next = prev.slice();
        next[i] = t;
        return next;
      });
    };
    const listeners = Promise.all([
      listen<FileTransfer>("file-transfer", (e) => merge(e.payload)),
      // A retried row is replaced by its new one.
      listen<string>("file-transfer-removed", (e) => {
        removed.add(e.payload);
        setList((prev) => prev.filter((x) => x.id !== e.payload));
      }),
    ]);
    // Listening first, then the snapshot: nothing falls between the two.
    void listeners
      .then(() => filesTransfers())
      .then((seed) => {
        if (!alive) return;
        // Events that arrived meanwhile are newer than the snapshot.
        setList((prev) => [...seed.filter((s) => !removed.has(s.id) && !prev.some((p) => p.id === s.id)), ...prev]);
      })
      .catch(() => {});
    return () => {
      alive = false;
      void listeners.then((fs) => fs.forEach((f) => f()));
    };
  }, []);
  const clearFinished = (tunnelId?: string) => {
    setList((prev) => prev.filter((x) => isActive(x) || (tunnelId !== undefined && !involves(x, tunnelId))));
    void filesClearTransfers(tunnelId).catch(() => {});
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
