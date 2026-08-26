import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listTunnelStatuses } from "../api";
import type { HostKeyPending, StatusEvent, TunnelStats, TunnelStatus } from "../types";

export interface TunnelRuntimeState {
  status: TunnelStatus;
  message: string | null;
}

/** Per-second up/down byte deltas, most recent last — what the connector
 * waveform actually plots. Bounded so a tunnel open for hours doesn't grow
 * this forever. */
export interface Throughput {
  up: number[];
  down: number[];
}

const THROUGHPUT_HISTORY_LEN = 24;

export function useTunnelEvents(onError?: (tunnelId: string, message: string) => void) {
  const [statuses, setStatuses] = useState<Record<string, TunnelRuntimeState>>({});
  const [stats, setStats] = useState<Record<string, TunnelStats>>({});
  const [throughput, setThroughput] = useState<Record<string, Throughput>>({});
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPending[]>([]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Cumulative totals are all the backend sends; the waveform needs
  // per-tick deltas, so the previous cumulative total has to be remembered
  // somewhere that doesn't itself trigger a re-render.
  const prevBytesRef = useRef<Record<string, { up: number; down: number }>>({});

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
        setThroughput((prev) => {
          if (!(tunnelId in prev)) return prev;
          const next = { ...prev };
          delete next[tunnelId];
          return next;
        });
        delete prevBytesRef.current[tunnelId];
      }
      if (status === "error" && message) {
        onErrorRef.current?.(tunnelId, message);
      }
    });

    const unlistenStats = listen<TunnelStats>("tunnel-stats", (event) => {
      const s = event.payload;
      setStats((prev) => ({ ...prev, [s.tunnelId]: s }));

      const prevBytes = prevBytesRef.current[s.tunnelId];
      // No previous sample (first tick after connect) or a lower cumulative
      // total than last time (counters reset on reconnect) both mean "no
      // delta to show yet" rather than a bogus spike or negative value.
      const deltaUp = prevBytes ? Math.max(0, s.bytesUp - prevBytes.up) : 0;
      const deltaDown = prevBytes ? Math.max(0, s.bytesDown - prevBytes.down) : 0;
      prevBytesRef.current[s.tunnelId] = { up: s.bytesUp, down: s.bytesDown };

      setThroughput((prev) => {
        const existing = prev[s.tunnelId] ?? { up: [], down: [] };
        return {
          ...prev,
          [s.tunnelId]: {
            up: [...existing.up, deltaUp].slice(-THROUGHPUT_HISTORY_LEN),
            down: [...existing.down, deltaDown].slice(-THROUGHPUT_HISTORY_LEN),
          },
        };
      });
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

  return { statuses, stats, throughput, hostKeyQueue, dismissHostKey };
}
