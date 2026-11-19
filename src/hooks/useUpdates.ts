import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { updateStatus } from "../api";
import type { UpdateSnapshot } from "../types";

/** Live state of the backend updater (`updates.rs`). */
export function useUpdates(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  useEffect(() => {
    updateStatus().then(setSnapshot).catch(() => {});
    const unlisten = listen<UpdateSnapshot>("update-status", (e) => setSnapshot(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  return snapshot;
}
