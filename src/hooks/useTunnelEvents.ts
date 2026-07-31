import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { HostKeyPending, StatusEvent, TunnelStatus } from "../types";

export interface TunnelRuntimeState {
  status: TunnelStatus;
  message: string | null;
}

export function useTunnelEvents(onError?: (tunnelId: string, message: string) => void) {
  const [statuses, setStatuses] = useState<Record<string, TunnelRuntimeState>>({});
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPending[]>([]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const unlistenStatus = listen<StatusEvent>("tunnel-status", (event) => {
      const { tunnelId, status, message } = event.payload;
      setStatuses((prev) => ({ ...prev, [tunnelId]: { status, message } }));
      if (status === "error" && message) {
        onErrorRef.current?.(tunnelId, message);
      }
    });

    const unlistenHostKey = listen<HostKeyPending>("host-key-pending", (event) => {
      setHostKeyQueue((prev) => [...prev, event.payload]);
    });

    return () => {
      unlistenStatus.then((f) => f());
      unlistenHostKey.then((f) => f());
    };
  }, []);

  const dismissHostKey = (requestId: string) => {
    setHostKeyQueue((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  return { statuses, hostKeyQueue, dismissHostKey };
}
