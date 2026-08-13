import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listTunnelStatuses } from "../api";
import type { HostKeyPending, StatusEvent, TunnelStats, TunnelStatus } from "../types";

export interface TunnelRuntimeState {
  status: TunnelStatus;
  message: string | null;
}

export function useTunnelEvents(onError?: (tunnelId: string, message: string) => void) {
  const [statuses, setStatuses] = useState<Record<string, TunnelRuntimeState>>({});
  const [stats, setStats] = useState<Record<string, TunnelStats>>({});
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPending[]>([]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const unlistenStatus = listen<StatusEvent>("tunnel-status", (event) => {
      const { tunnelId, status, message } = event.payload;
      setStatuses((prev) => ({ ...prev, [tunnelId]: { status, message } }));
      if (status !== "connected") {
        setStats((prev) => {
          if (!(tunnelId in prev)) return prev;
          const next = { ...prev };
          delete next[tunnelId];
          return next;
        });
      }
      if (status === "error" && message) {
        onErrorRef.current?.(tunnelId, message);
      }
    });

    const unlistenStats = listen<TunnelStats>("tunnel-stats", (event) => {
      setStats((prev) => ({ ...prev, [event.payload.tunnelId]: event.payload }));
    });

    const unlistenHostKey = listen<HostKeyPending>("host-key-pending", (event) => {
      setHostKeyQueue((prev) => [...prev, event.payload]);
    });

    // Status arrives as events, so a reload (or a window opened after tunnels
    // were already up) starts blind. Seed from the backend's snapshot, without
    // clobbering any event that landed while this was in flight.
    listTunnelStatuses()
      .then((snapshot) => {
        setStatuses((prev) => {
          const next = { ...prev };
          for (const { tunnelId, status, message } of snapshot) {
            if (!(tunnelId in next)) next[tunnelId] = { status, message };
          }
          return next;
        });
      })
      .catch(() => {});

    return () => {
      unlistenStatus.then((f) => f());
      unlistenStats.then((f) => f());
      unlistenHostKey.then((f) => f());
    };
  }, []);

  const dismissHostKey = (requestId: string) => {
    setHostKeyQueue((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  return { statuses, stats, hostKeyQueue, dismissHostKey };
}
