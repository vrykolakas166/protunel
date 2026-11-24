import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSettings, listTunnels } from "../api";
import type { Settings, Tunnel } from "../types";
import type { SessionInfo } from "./TerminalView";
import { LAST_SESSION_ID, flushMemory, loadMemory, saveWorkspace } from "./memory";
import type { Tab } from "./tabs";
import type { LayoutUndo } from "./useLayoutUndo";

/**
 * Initial load (settings, hosts, memory) and the backend events the window
 * follows: `tunnels-changed`, `settings-changed`, `terminal-hidden` (drop
 * every tab; what was open becomes "restore last session") and
 * `terminal-close-requested` (the page decides whether the window may hide).
 */
export function useTerminalWindowEvents({
  tabsRef,
  terminalIds,
  later,
  setSettings,
  setTunnels,
  setLoaded,
  setTabs,
  setLayoutUndo,
  resetWatch,
  setActiveKey,
  setInfos,
  setQuery,
}: {
  tabsRef: RefObject<Tab[]>;
  terminalIds: RefObject<Map<string, string>>;
  later: RefObject<{ windowClose: () => void }>;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  setTunnels: Dispatch<SetStateAction<Tunnel[]>>;
  setLoaded: Dispatch<SetStateAction<boolean>>;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setLayoutUndo: Dispatch<SetStateAction<LayoutUndo | null>>;
  resetWatch: () => void;
  setActiveKey: Dispatch<SetStateAction<string | null>>;
  setInfos: Dispatch<SetStateAction<Record<string, SessionInfo>>>;
  setQuery: Dispatch<SetStateAction<string>>;
}) {
  useEffect(() => {
    void loadMemory();
    getSettings().then(setSettings).catch(() => {});
    const load = () =>
      listTunnels()
        .then((list) => {
          setTunnels(list);
          setLoaded(true);
        })
        .catch(() => {});
    void load();
    // Hosts are tunnels; the main window can add, rename or delete them.
    const unlisten = listen("tunnels-changed", load);
    // Theme and language are chosen in the main window's settings.
    const unlistenSettings = listen<Settings>("settings-changed", (e) => setSettings(e.payload));
    // Closing the window only hides it (reopening is then instant); its shells
    // end as if it had closed. Dropping every tab unmounts the panes, which
    // closes whatever the backend has not closed already.
    const unlistenHidden = listen("terminal-hidden", () => {
      // What was open becomes "restore last session" next time.
      if (tabsRef.current.length > 0) {
        saveWorkspace({ id: LAST_SESSION_ID, name: "", tabs: tabsRef.current.map((tab) => tab.root) });
        flushMemory();
      }
      setTabs([]);
      setLayoutUndo(null);
      resetWatch();
      setActiveKey(null);
      setInfos({});
      setQuery("");
      terminalIds.current.clear();
    });
    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenHidden.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("terminal-close-requested", () => later.current.windowClose());
    return () => void unlisten.then((f) => f());
  }, []);
}
