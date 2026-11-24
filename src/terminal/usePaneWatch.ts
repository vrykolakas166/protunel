import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { terminalNotify } from "../api";
import type { MenuEntry } from "../contextMenu";
import type { Tunnel } from "../types";
import { findPane, paneIds } from "./layout";
import { mayNotify, type WatchMode } from "./paneWatch";
import type { Tab } from "./tabs";
import { withId, without } from "./tabTitle";

/**
 * What the window tells you about panes out of sight: "finished while away"
 * dots, new-output rings, watches (output / silence) and their desktop
 * notifications. All of it is session-only.
 */
export function usePaneWatch({
  tabs,
  activeKey,
  focusSignal,
  tabsRef,
  activeKeyRef,
  byId,
  refocus,
}: {
  tabs: Tab[];
  activeKey: string | null;
  focusSignal: number;
  tabsRef: RefObject<Tab[]>;
  activeKeyRef: RefObject<string | null>;
  byId: Record<string, Tunnel>;
  refocus: () => void;
}) {
  const { t } = useTranslation("terminal");
  /** Panes whose long command finished out of sight; their tab shows a dot. */
  const [attention, setAttention] = useState<Set<string>>(new Set());
  /** Panes with output you have not looked at yet (`paneWatch.ts`). */
  const [unread, setUnread] = useState<Set<string>>(new Set());
  /** Panes watched for output or silence, and those whose watch has fired. */
  const [watches, setWatches] = useState<Record<string, WatchMode>>({});
  const [alerted, setAlerted] = useState<Set<string>>(new Set());
  const watchesRef = useRef(watches);
  watchesRef.current = watches;
  /** Pane id → when its watch last raised a desktop notification. */
  const lastNotified = useRef(new Map<string, number>());

  // Looking at a tab clears its "finished while you were away" dot.
  useEffect(() => {
    const tab = tabs.find((x) => x.key === activeKey);
    if (!tab) return;
    const ids = paneIds(tab.root);
    setAttention((prev) => without(prev, ids));
  }, [activeKey, tabs]);

  // Looking at a pane (focused, in the active tab, window in front) clears
  // its "new output" dot and fired watch.
  useEffect(() => {
    const tab = tabs.find((x) => x.key === activeKey);
    if (!tab || !document.hasFocus()) return;
    // Panes on screen that broadcast types into count as looked at too.
    const typedInto = tab.broadcast && !tab.zoomed ? paneIds(tab.root).filter((id) => !tab.excluded.includes(id)) : [];
    setUnread((prev) => without(prev, [tab.focused, ...typedInto]));
    setAlerted((prev) => without(prev, [tab.focused]));
  }, [activeKey, tabs, focusSignal]);

  /** Arms a watch on a pane, or disarms it when it was the one armed. */
  const toggleWatch = (paneId: string, mode: WatchMode) => {
    setWatches((prev) => {
      const next = { ...prev };
      if (next[paneId] === mode) delete next[paneId];
      else next[paneId] = mode;
      return next;
    });
    setAlerted((prev) => without(prev, [paneId]));
    refocus();
  };

  const watchEntries = (paneId: string, focusedPane: boolean): MenuEntry[] => [
    {
      label: t(focusedPane ? "watch.focusedOutput" : "watch.output"),
      checked: watches[paneId] === "output",
      action: () => toggleWatch(paneId, "output"),
    },
    {
      label: t(focusedPane ? "watch.focusedSilence" : "watch.silence"),
      checked: watches[paneId] === "silence",
      action: () => toggleWatch(paneId, "silence"),
    },
  ];

  /** Whether a pane is on screen now (its tab active, not hidden by a zoom). */
  const paneShown = (tab: Tab, paneId: string) =>
    tab.key === activeKeyRef.current && (!tab.zoomed || tab.zoomed === paneId);

  /**
   * A watch fired: the header eye turns amber; a desktop notification goes
   * out only when the pane is out of sight, at most once a minute per pane,
   * and names the host and event only — terminal output stays off the
   * lock screen.
   */
  const fireWatch = (tab: Tab, paneId: string, kind: WatchMode) => {
    setAlerted((prev) => withId(prev, paneId));
    if (paneShown(tab, paneId) && document.hasFocus()) return;
    const now = Date.now();
    if (!mayNotify(lastNotified.current.get(paneId), now)) return;
    lastNotified.current.set(paneId, now);
    const host = byId[findPane(tab.root, paneId)?.tunnelId ?? ""]?.name ?? "";
    const title = t(kind === "output" ? "watch.notifyOutputTitle" : "watch.notifySilenceTitle", { host });
    const body = t(kind === "output" ? "watch.notifyOutputBody" : "watch.notifySilenceBody");
    void terminalNotify(title, body).catch(() => {});
  };

  /** Output after a quiet spell (`paneWatch.ts`). */
  const onBurst = (tabKey: string, paneId: string) => {
    const tab = tabsRef.current.find((x) => x.key === tabKey);
    if (!tab) return;
    const inFront = paneShown(tab, paneId) && document.hasFocus();
    const looking = inFront && tab.focused === paneId;
    // Broadcast panes on screen are being typed into: their output is the
    // answer to that typing, not news.
    const typedInto = inFront && tab.broadcast && !tab.zoomed && !tab.excluded.includes(paneId);
    if (!looking && !typedInto) setUnread((prev) => withId(prev, paneId));
    if (watchesRef.current[paneId] === "output" && !looking) fireWatch(tab, paneId, "output");
  };

  const onSilence = (paneId: string) => {
    const tab = tabsRef.current.find((x) => findPane(x.root, paneId));
    if (tab && watchesRef.current[paneId] === "silence") fireWatch(tab, paneId, "silence");
  };

  /** Forgets what is known about these panes (closed, or their host deleted). */
  const forgetWatch = (ids: string[]) => {
    for (const id of ids) lastNotified.current.delete(id);
    setAttention((prev) => without(prev, ids));
    setUnread((prev) => without(prev, ids));
    setAlerted((prev) => without(prev, ids));
    setWatches((prev) => {
      if (!ids.some((id) => id in prev)) return prev;
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  /** Everything dropped: the window was hidden and its tabs with it. */
  const resetWatch = () => {
    setAttention(new Set());
    setUnread(new Set());
    setAlerted(new Set());
    setWatches({});
    lastNotified.current.clear();
  };

  return {
    attention,
    setAttention,
    unread,
    watches,
    alerted,
    watchEntries,
    onBurst,
    onSilence,
    forgetWatch,
    resetWatch,
  };
}
