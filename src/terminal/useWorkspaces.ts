import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { openMenu, type MenuEntry } from "../contextMenu";
import type { Tunnel, Workspace } from "../types";
import type { Naming } from "./TerminalDialogs";
import { computeLayout, paneIds, reviveLayout } from "./layout";
import { LAST_SESSION_ID, deleteWorkspace, saveWorkspace, useTerminalMemory } from "./memory";
import { makeTab, type Tab } from "./tabs";
import { workspaceShapeChanged } from "./tabTitle";

/**
 * Workspaces (named sets of tabs) and the remembered last session: opening,
 * saving, renaming, the "changed since saved" check, and the menus that
 * drive them (save button, tab and workspace right-click).
 */
export function useWorkspaces({
  tabs,
  byId,
  activeKey,
  activeTab,
  setActiveKey,
  setTabs,
  naming,
  setNaming,
  refocus,
  updateTab,
  closeTab,
  layoutEntries,
}: {
  tabs: Tab[];
  byId: Record<string, Tunnel>;
  activeKey: string | null;
  activeTab: Tab | null;
  setActiveKey: Dispatch<SetStateAction<string | null>>;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  naming: Naming | null;
  setNaming: (naming: Naming | null) => void;
  refocus: () => void;
  updateTab: (key: string, fn: (tab: Tab) => Tab) => void;
  closeTab: (key: string) => void;
  layoutEntries: (tab: Tab) => MenuEntry[];
}) {
  const { t } = useTranslation("terminal");
  const memory = useTerminalMemory();

  const namedWorkspaces = memory.workspaces.filter((w) => w.id !== LAST_SESSION_ID);
  const lastSession = memory.workspaces.find((w) => w.id === LAST_SESSION_ID) ?? null;

  /** Panes a workspace would open now (its deleted hosts left out). */
  const workspacePanes = (workspace: Workspace) =>
    workspace.tabs
      .map((root) => reviveLayout(root, (id) => !!byId[id]))
      .reduce((n, root) => n + (root ? paneIds(root).length : 0), 0);

  /** Opens a workspace's tabs after the open ones, each pane a new shell.
   * Already open: shows its tab instead (the active one if it is linked,
   * else the first) — never a second copy of the same shells. */
  const openWorkspace = (workspace: Workspace) => {
    const open = tabs.filter((tab) => tab.workspaceId === workspace.id);
    if (open.length > 0) {
      setActiveKey(open.some((tab) => tab.key === activeKey) ? activeKey : open[0].key);
      refocus();
      return;
    }
    const added = workspace.tabs
      .map((root) => reviveLayout(root, (id) => !!byId[id]))
      .filter((root) => root !== null)
      .map((root) => ({ ...makeTab(root), workspaceId: workspace.id }));
    if (added.length === 0) return;
    setTabs((prev) => [...prev, ...added]);
    setActiveKey(added[0].key);
    refocus();
  };

  const commitWorkspace = () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name || tabs.length === 0) return;
    // Saving under an existing name updates that workspace.
    const existing = naming.id ?? namedWorkspaces.find((w) => w.name.toLowerCase() === name.toLowerCase())?.id;
    const id = existing ?? crypto.randomUUID();
    saveWorkspace({ id, name, tabs: tabs.map((tab) => tab.root) });
    // From now on these tabs are that workspace: their changes can be saved back.
    setTabs((prev) => prev.map((tab) => ({ ...tab, workspaceId: id })));
    setNaming(null);
    refocus();
  };

  /** The named workspace a tab belongs to, if it still exists. */
  const workspaceOf = (tab: Tab | null) =>
    (tab?.workspaceId && namedWorkspaces.find((w) => w.id === tab.workspaceId)) || null;

  /** Open tabs of a workspace, in tab order. */
  const linkedTabs = (workspace: Workspace) => tabs.filter((tab) => tab.workspaceId === workspace.id);

  /** Panes split, closed, moved or resized (or tabs added/closed) since it was saved. */
  const workspaceChanged = (workspace: Workspace) => {
    const open = linkedTabs(workspace);
    if (open.length === 0) return false;
    return workspaceShapeChanged(open.map((tab) => tab.root), workspace.tabs);
  };

  /** Saves a workspace as its open tabs now look; a closed tab leaves it. */
  const saveWorkspaceChanges = (workspace: Workspace) => {
    const open = linkedTabs(workspace);
    if (open.length > 0) saveWorkspace({ ...workspace, tabs: open.map((tab) => tab.root) });
    refocus();
  };

  const activeWorkspace = workspaceOf(activeTab);
  const activeWorkspaceChanged = activeWorkspace ? workspaceChanged(activeWorkspace) : false;

  const onSaveButton = (e: ReactMouseEvent) => {
    if (!activeWorkspace) {
      setNaming({ name: "", id: null });
      return;
    }
    openMenu(e, [
      {
        label: t("workspace.saveChanges", { name: activeWorkspace.name }),
        enabled: activeWorkspaceChanged,
        action: () => saveWorkspaceChanges(activeWorkspace),
      },
      { label: t("workspace.saveAsNew"), action: () => setNaming({ name: "", id: null }) },
    ]);
  };

  /** Right-click on a tab: put it in a workspace, or take it out. */
  const tabMenu = (e: ReactMouseEvent, tab: Tab) => {
    const own = workspaceOf(tab);
    openMenu(e, [
      ...(paneIds(tab.root).length > 1 ? [...layoutEntries(tab), "separator" as const] : []),
      ...namedWorkspaces
        .filter((w) => w.id !== own?.id)
        .map((w) => ({
          label: t("workspace.addTab", { name: w.name }),
          action: () => updateTab(tab.key, (x) => ({ ...x, workspaceId: w.id })),
        })),
      ...(own
        ? [{ label: t("workspace.removeTab", { name: own.name }), action: () => updateTab(tab.key, (x) => ({ ...x, workspaceId: null })) }]
        : []),
      ...(namedWorkspaces.length > 0 ? (["separator"] as const) : []),
      { label: t("closeTab"), action: () => closeTab(tab.key) },
    ]);
  };

  /** "user@host" when the last session was a single shell; nothing for more. */
  const lastSessionTarget = (() => {
    if (!lastSession) return null;
    const roots = lastSession.tabs.map((root) => reviveLayout(root, (id) => !!byId[id])).filter((r) => r !== null);
    const panes = roots.flatMap((root) => computeLayout(root).panes);
    if (panes.length !== 1) return null;
    const tun = byId[panes[0].tunnelId];
    return tun ? `${tun.username}@${tun.host}` : null;
  })();

  const workspaceMenu = (e: ReactMouseEvent, workspace: Workspace) =>
    openMenu(e, [
      { label: t("workspace.open"), action: () => openWorkspace(workspace) },
      {
        label: t("workspace.saveChanges", { name: workspace.name }),
        enabled: workspaceChanged(workspace),
        action: () => saveWorkspaceChanges(workspace),
      },
      {
        label: t("workspace.update"),
        enabled: tabs.length > 0,
        action: () => {
          saveWorkspace({ ...workspace, tabs: tabs.map((tab) => tab.root) });
          setTabs((prev) => prev.map((tab) => ({ ...tab, workspaceId: workspace.id })));
        },
      },
      { label: t("workspace.rename"), action: () => setNaming({ name: workspace.name, id: workspace.id }) },
      "separator",
      { label: t("workspace.delete"), action: () => deleteWorkspace(workspace.id) },
    ]);

  return {
    namedWorkspaces,
    lastSession,
    lastSessionTarget,
    workspacePanes,
    openWorkspace,
    commitWorkspace,
    workspaceOf,
    linkedTabs,
    activeWorkspace,
    activeWorkspaceChanged,
    onSaveButton,
    tabMenu,
    workspaceMenu,
  };
}
