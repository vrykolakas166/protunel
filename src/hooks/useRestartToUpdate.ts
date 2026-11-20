import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { installUpdate } from "../api";
import type { TunnelRuntimeState } from "./useTunnelEvents";

/**
 * "Restart to update", from the banner, Settings › About or the tray. With
 * tunnels up it asks first (they drop, then come back after the restart);
 * with nothing running there is nothing to ask about.
 */
export function useRestartToUpdate(statuses: Record<string, TunnelRuntimeState>, onError: (text: string) => void) {
  /** The confirmation is open. */
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** Tunnels that a restart would drop. */
  const liveTunnels = Object.values(statuses).filter((s) => s.status !== "disconnected" && s.status !== "error").length;

  // The tray's item lands here so the user can be asked.
  useEffect(() => {
    const unlisten = listen("update-restart-requested", () => setConfirming(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const restart = async () => {
    setConfirming(false);
    setRestarting(true);
    try {
      await installUpdate(); // only returns if it failed
    } catch (err) {
      onErrorRef.current(String(err));
    }
    setRestarting(false);
  };

  return {
    confirming,
    restarting,
    liveTunnels,
    request: () => (liveTunnels > 0 ? setConfirming(true) : void restart()),
    confirm: () => void restart(),
    cancel: () => setConfirming(false),
  };
}
