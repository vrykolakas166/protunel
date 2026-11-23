import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { Tunnel, TunnelStatus } from "../types";
import type { DragSource } from "./tabs";
import { groupOf, groupSections, hasGroups, sectionKey } from "../groups";

const STATUS_DOT: Record<TunnelStatus, string> = {
  connected: "bg-accent",
  connecting: "bg-amber animate-pulse",
  reconnecting: "bg-amber animate-pulse",
  error: "bg-coral",
  disconnected: "bg-slate",
};

export interface HostRow {
  tunnel: Tunnel;
  depth: number;
  childCount: number;
  /** Its jump host's name when the row is not drawn under it (another group, or a search). */
  via: string | null;
}

/** A group's header in the tree: where its rows start, and all its hosts. */
export interface HostSection {
  name: string | null;
  /** Every host in the group, in tree order, whatever the search or collapse. */
  ids: string[];
  /** Index of its first row in `rows`, and how many rows it shows. */
  start: number;
  count: number;
  collapsed: boolean;
}

const matches = (tun: Tunnel, q: string) =>
  tun.name.toLowerCase().includes(q) ||
  tun.host.toLowerCase().includes(q) ||
  tun.username.toLowerCase().includes(q) ||
  (tun.group ?? "").toLowerCase().includes(q);

/**
 * `tunnels` as tree rows: a host sits under the host it jumps through when
 * both are in `tunnels` and `sameSection` holds; collapsed hosts hide their
 * subtree. Order is the tunnels' saved order.
 */
function treeRows(
  tunnels: Tunnel[],
  collapsed: Set<string>,
  byIdAll: Map<string, Tunnel>,
): HostRow[] {
  const ids = new Set(tunnels.map((tun) => tun.id));
  const parentOf = (tun: Tunnel) => (tun.jumpTunnelId && ids.has(tun.jumpTunnelId) ? tun.jumpTunnelId : null);
  const children = new Map<string, Tunnel[]>();
  for (const tun of tunnels) {
    const parent = parentOf(tun);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), tun]);
  }
  const rows: HostRow[] = [];
  const seen = new Set<string>();
  const walk = (tun: Tunnel, depth: number) => {
    if (seen.has(tun.id)) return; // a jump cycle in bad data
    seen.add(tun.id);
    const kids = children.get(tun.id) ?? [];
    const via = depth === 0 && tun.jumpTunnelId ? (byIdAll.get(tun.jumpTunnelId)?.name ?? null) : null;
    rows.push({ tunnel: tun, depth, childCount: kids.length, via });
    if (!collapsed.has(tun.id)) for (const kid of kids) walk(kid, depth + 1);
  };
  tunnels.filter((tun) => !parentOf(tun)).forEach((root) => walk(root, 0));
  return rows;
}

/**
 * Hosts as the visible rows of a tree: a host that jumps through another sits
 * under it, like in the main window. Collapsed hosts hide their subtree. A
 * search query flattens the tree to the matching hosts. Order is the
 * tunnels' saved order (drag-and-drop in the main window), not alphabetical.
 */
export function hostRows(tunnels: Tunnel[], query: string, collapsed: Set<string>): HostRow[] {
  return hostTree(tunnels, query, collapsed, new Set()).rows;
}

/**
 * The tree split by group (`groups.ts`): one section per group, the
 * ungrouped last, each with its own jump tree (a host nests under its jump
 * host only in the same group, otherwise it shows "via …"). Without any
 * group, `sections` is null and the tree is as it always was. A search
 * flattens each section to its matches and drops empty ones; it ignores
 * collapsed groups without changing them.
 */
export function hostTree(
  tunnels: Tunnel[],
  query: string,
  collapsed: Set<string>,
  collapsedGroups: Set<string>,
): { rows: HostRow[]; sections: HostSection[] | null } {
  const q = query.trim().toLowerCase();
  const byIdAll = new Map(tunnels.map((tun) => [tun.id, tun]));
  const flat = (list: Tunnel[]): HostRow[] =>
    list
      .filter((tun) => matches(tun, q))
      .map((tunnel) => ({
        tunnel,
        depth: 0,
        childCount: 0,
        via: tunnel.jumpTunnelId ? (byIdAll.get(tunnel.jumpTunnelId)?.name ?? null) : null,
      }));
  if (!hasGroups(tunnels)) {
    return { rows: q ? flat(tunnels) : treeRows(tunnels, collapsed, byIdAll), sections: null };
  }
  const rows: HostRow[] = [];
  const sections: HostSection[] = [];
  for (const section of groupSections(tunnels, groupOf)) {
    const isCollapsed = !q && collapsedGroups.has(sectionKey(section.name));
    const shown = q ? flat(section.items) : isCollapsed ? [] : treeRows(section.items, collapsed, byIdAll);
    if (q && shown.length === 0) continue;
    const ids = treeRows(section.items, new Set(), byIdAll).map((row) => row.tunnel.id);
    sections.push({ name: section.name, ids, start: rows.length, count: shown.length, collapsed: isCollapsed });
    rows.push(...shown);
  }
  return { rows, sections };
}

/**
 * A host and every host that jumps through it, directly or not, in the
 * tree's order: what "open this host and its children" opens.
 */
export function subtreeIds(tunnels: Tunnel[], rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return; // a jump cycle in bad data
    seen.add(id);
    out.push(id);
    for (const tun of tunnels) if (tun.jumpTunnelId === id) walk(tun.id);
  };
  if (tunnels.some((tun) => tun.id === rootId)) walk(rootId);
  return out;
}

interface Props {
  rows: HostRow[];
  emptyText: string;
  statuses: Record<string, TunnelRuntimeState>;
  panesPerHost: Record<string, number>;
  collapsed: Set<string>;
  highlightId: string | null;
  onHighlight: (id: string) => void;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  beginDrag: (source: DragSource, label: string) => (e: ReactPointerEvent) => void;
  /** Picking several hosts to open in one tab: rows show a checkbox. */
  selecting: boolean;
  selected: Set<string>;
  /** A click that picks: in selection mode, or with Ctrl / Shift held. */
  onPick: (id: string, range: boolean) => void;
  onRowMenu: (e: ReactMouseEvent, row: HostRow) => void;
  /** Group headers (`hostTree`); null draws the plain tree. */
  sections: HostSection[] | null;
  connectedCount: (ids: string[]) => number;
  onToggleSection: (name: string | null) => void;
  onSectionMenu: (e: ReactMouseEvent, section: HostSection) => void;
}

export function HostTree({
  rows,
  emptyText,
  statuses,
  panesPerHost,
  collapsed,
  highlightId,
  onHighlight,
  onToggle,
  onOpen,
  beginDrag,
  selecting,
  selected,
  onPick,
  onRowMenu,
  sections,
  connectedCount,
  onToggleSection,
  onSectionMenu,
}: Props) {
  const { t } = useTranslation("terminal");
  const renderRow = ({ tunnel: tun, depth, childCount, via }: HostRow) => {
        const status = statuses[tun.id]?.status ?? "disconnected";
        const open = panesPerHost[tun.id] ?? 0;
        const highlighted = tun.id === highlightId;
        const isCollapsed = collapsed.has(tun.id);
        const picked = selected.has(tun.id);
        return (
          <li
            key={tun.id}
            role="treeitem"
            aria-expanded={childCount > 0 ? !isCollapsed : undefined}
            aria-selected={selecting ? picked : undefined}
          >
            <button
              onClick={(e) => {
                if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) onPick(tun.id, e.shiftKey);
                else onHighlight(tun.id);
              }}
              onDoubleClick={() => !selecting && onOpen(tun.id)}
              onContextMenu={(e) => onRowMenu(e, { tunnel: tun, depth, childCount, via })}
              onPointerDown={beginDrag({ kind: "host", tunnelId: tun.id }, tun.name)}
              title={selecting ? undefined : t("openHint")}
              style={{ paddingLeft: 4 + depth * 14 }}
              className={`group flex w-full cursor-grab items-center gap-1.5 rounded py-1.5 pr-2 text-left ${
                picked ? "bg-accent/10" : highlighted ? "bg-surface-hover" : "hover:bg-surface-hover"
              } ${highlighted && selecting ? "ring-1 ring-inset ring-border" : ""}`}
            >
              {childCount > 0 ? (
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(tun.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={isCollapsed ? t("expand") : t("collapse")}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:bg-border hover:text-text"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  >
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              {selecting && (
                <span
                  aria-hidden="true"
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
                    picked ? "border-accent bg-accent text-on-accent" : "border-muted/60 bg-bg"
                  }`}
                >
                  {picked && (
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              )}
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">
                  {tun.name}
                  {childCount > 0 && isCollapsed && (
                    <span className="ml-1 text-[11px] text-muted">({childCount})</span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {tun.username}@{tun.host}
                  {via && <span className="font-sans"> · {t("hostVia", { name: via })}</span>}
                </span>
              </span>
              {open > 0 && (
                <span className="rounded bg-accent/15 px-1.5 text-[11px] font-medium text-accent">
                  {open}
                </span>
              )}
              {!selecting && <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(tun.id);
                }}
                aria-label={t("openSession")}
                title={t("openSession")}
                className={`rounded p-0.5 text-muted hover:text-accent ${
                  highlighted ? "" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 4.5L6.5 8L3 11.5M8.5 12H13"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>}
            </button>
          </li>
        );
  };

  const header = (section: HostSection) => {
    const label = section.name ?? t("group.none");
    const connected = connectedCount(section.ids);
    return (
      <li
        key={`group:${sectionKey(section.name)}`}
        role="none"
        onContextMenu={(e) => onSectionMenu(e, section)}
        className="group/header mt-1.5 flex items-center gap-1 first:mt-0"
      >
        <button
          onClick={() => onToggleSection(section.name)}
          aria-expanded={!section.collapsed}
          title={section.collapsed ? t("group.expand") : t("group.collapse")}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] font-semibold text-muted hover:text-text"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            aria-hidden="true"
            className={`shrink-0 transition-transform ${section.collapsed ? "" : "rotate-90"}`}
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={`truncate ${section.name === null ? "italic" : ""}`}>{label}</span>
          <span className="shrink-0 font-mono text-[10px] font-normal">
            {connected > 0 ? `${connected}/${section.ids.length}` : section.ids.length}
          </span>
        </button>
        <button
          onClick={(e) => onSectionMenu(e, section)}
          aria-label={t("group.menu", { name: label })}
          title={t("group.menu", { name: label })}
          aria-haspopup="menu"
          className="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-surface-hover hover:text-text focus-visible:opacity-100 group-hover/header:opacity-100"
        >
          ⋯
        </button>
      </li>
    );
  };

  return (
    <ul role="tree" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      {sections
        ? sections.flatMap((section) => [
            header(section),
            ...rows.slice(section.start, section.start + section.count).map(renderRow),
          ])
        : rows.map(renderRow)}
      {rows.length === 0 && !sections?.length && <li className="px-2 py-3 text-xs text-muted">{emptyText}</li>}
    </ul>
  );
}
