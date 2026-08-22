import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { routerSnapshot } from "../api";
import type { RouterStats, RouterStatus, RouterStatusEvent } from "../types";

export interface RouterRuntimeState {
  status: RouterStatus;
  port: number | null;
  message: string | null;
  stats: RouterStats | null;
  pacUrl: string | null;
  compileErrors: string[];
}

const INITIAL: RouterRuntimeState = {
  status: "stopped",
  port: null,
  message: null,
  stats: null,
  pacUrl: null,
  compileErrors: [],
};

export function useRouterEvents(): RouterRuntimeState {
  const [state, setState] = useState<RouterRuntimeState>(INITIAL);

  useEffect(() => {
    // The PAC URL and compile errors aren't in the status event (the PAC port is
    // ephemeral and only known once bound), so every transition refetches them.
    const loadSnapshot = () =>
      routerSnapshot()
        .then((snapshot) =>
          setState((prev) => ({
            ...prev,
            port: snapshot.port ?? prev.port,
            pacUrl: snapshot.pacUrl,
            compileErrors: snapshot.compileErrors,
            status: snapshot.running ? "running" : prev.status,
          })),
        )
        .catch(() => {});

    const unlistenStatus = listen<RouterStatusEvent>("router-status", (event) => {
      const { status, port, message } = event.payload;
      setState((prev) => ({
        ...prev,
        status,
        port,
        message,
        // A stopped router has no live traffic to report; leaving the last
        // numbers up would read as though it were still proxying.
        stats: status === "running" ? prev.stats : null,
        pacUrl: status === "running" ? prev.pacUrl : null,
      }));
      if (status === "running") void loadSnapshot();
    });

    const unlistenStats = listen<RouterStats>("router-stats", (event) => {
      setState((prev) => ({ ...prev, stats: event.payload }));
    });

    // Same reasoning as useTunnelEvents: status is pushed, so a reload starts
    // blind and needs the backend's current view to seed itself.
    void loadSnapshot();

    return () => {
      unlistenStatus.then((f) => f());
      unlistenStats.then((f) => f());
    };
  }, []);

  return state;
}
