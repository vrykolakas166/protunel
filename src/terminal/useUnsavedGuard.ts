import { useState, type RefObject } from "react";
import type { Tunnel } from "../types";
import { findPane } from "./layout";
import type { FilePanelHandle } from "./files/FilePanel";
import type { Unsaved } from "./files/unsaved";
import type { Tab } from "./tabs";

export interface PendingUnsaved {
  items: Unsaved[];
  /** A save was tried and did not go through (conflict, lost session…). */
  failed: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * The "unsaved editor changes" confirmation: `guardUnsaved` runs an action
 * now, or after the user chose Save or Discard in the dialog the caller
 * renders from `pendingUnsaved`.
 */
export function useUnsavedGuard({
  filesRefs,
  tabsRef,
  byId,
  unsavedAmong,
  setActiveKey,
  raiseFiles,
  refocus,
}: {
  filesRefs: RefObject<Map<string, FilePanelHandle>>;
  tabsRef: RefObject<Tab[]>;
  byId: Record<string, Tunnel>;
  unsavedAmong: (ids: string[]) => Unsaved[];
  setActiveKey: (key: string) => void;
  raiseFiles: (paneId: string) => void;
  refocus: () => void;
}) {
  const [pendingUnsaved, setPendingUnsaved] = useState<PendingUnsaved | null>(null);

  /** user@host of the shell a pane belongs to. */
  const whereOf = (paneId: string): string => {
    const node = tabsRef.current.map((tab) => findPane(tab.root, paneId)).find(Boolean);
    const tunnel = node ? byId[node.tunnelId] : undefined;
    return tunnel ? `${tunnel.username}@${tunnel.host}` : paneId;
  };

  /** Runs `proceed` now when none of `ids` has unsaved edits, else after the
   * user chose Save or Discard; Cancel (or a failed save) keeps everything. */
  const guardUnsaved = (ids: string[], proceed: () => void) => {
    const items = unsavedAmong(ids);
    if (items.length === 0) {
      proceed();
      return;
    }
    if (pendingUnsaved) return;
    void new Promise<boolean>((resolve) => setPendingUnsaved({ items, failed: false, resolve })).then((ok) => {
      if (ok) proceed();
      else refocus();
    });
  };

  const saveAllUnsaved = async (pending: PendingUnsaved) => {
    for (const item of pending.items) {
      const ok = (await filesRefs.current.get(item.paneId)?.saveUnsaved()) ?? true;
      if (!ok) {
        // Show the panel that could not save: it carries the conflict banner.
        const tab = tabsRef.current.find((x) => findPane(x.root, item.paneId));
        if (tab) setActiveKey(tab.key);
        raiseFiles(item.paneId);
        setPendingUnsaved({ ...pending, failed: true });
        return;
      }
    }
    setPendingUnsaved(null);
    pending.resolve(true);
  };

  return { pendingUnsaved, setPendingUnsaved, whereOf, guardUnsaved, saveAllUnsaved };
}
