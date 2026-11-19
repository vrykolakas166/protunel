import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listHostKeyMismatches } from "../api";
import type { HostKeyMismatch, Tunnel } from "../types";

/** How the backend names a host in known hosts. */
export const hostKeyId = (tunnel: Pick<Tunnel, "host" | "port">) => `${tunnel.host}:${tunnel.port}`;

/**
 * Servers that offered a different host key than the trusted one, by
 * `host:port`. Seeded from the backend (a reloaded webview) and kept live by
 * `host-key-mismatch` events; `dismiss` drops one once its key is forgotten.
 */
export function useHostKeyMismatches() {
  const [mismatches, setMismatches] = useState<Record<string, HostKeyMismatch>>({});

  useEffect(() => {
    listHostKeyMismatches()
      .then((list) => setMismatches((prev) => ({ ...Object.fromEntries(list.map((m) => [m.keyId, m])), ...prev })))
      .catch(() => {});
    const unlisten = listen<HostKeyMismatch>("host-key-mismatch", (e) =>
      setMismatches((prev) => ({ ...prev, [e.payload.keyId]: e.payload })),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const dismiss = useCallback(
    (keyId: string) =>
      setMismatches((prev) => {
        const next = { ...prev };
        delete next[keyId];
        return next;
      }),
    [],
  );

  return { mismatches, dismiss };
}
