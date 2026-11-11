import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { Tunnel, TunnelStatus } from "../types";
import type { DragSource } from "./tabs";

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
}

/**
 * Hosts as the visible rows of a tree: a host that jumps through another sits
 * under it, like in the main window. Collapsed hosts hide their subtree. A
 * search query flattens the tree to the matching hosts. Order is the
 * tunnels' saved order (drag-and-drop in the main window), not alphabetical.
 */
export function hostRows(tunnels: Tunnel[], query: string, collapsed: Set<string>): HostRow[] {
  const q = query.trim().toLowerCase();
  if (q) {
    return tunnels
      .filter(
        (tun) =>
          tun.name.toLowerCase().includes(q) ||
          tun.host.toLowerCase().includes(q) ||
          tun.username.toLowerCase().includes(q),
      )
      .map((tunnel) => ({ tunnel, depth: 0, childCount: 0 }));
  }

  const ids = new Set(tunnels.map((tun) => tun.id));
  const children = new Map<string, Tunnel[]>();
  for (const tun of tunnels) {
    if (tun.jumpTunnelId && ids.has(tun.jumpTunnelId)) {
      children.set(tun.jumpTunnelId, [...(children.get(tun.jumpTunnelId) ?? []), tun]);
    }
  }
  const rows: HostRow[] = [];
  const seen = new Set<string>();
  const walk = (tun: Tunnel, depth: number) => {
    if (seen.has(tun.id)) return; // a jump cycle in bad data
    seen.add(tun.id);
    const kids = children.get(tun.id) ?? [];
    rows.push({ tunnel: tun, depth, childCount: kids.length });
    if (!collapsed.has(tun.id)) for (const kid of kids) walk(kid, depth + 1);
  };
  tunnels
    .filter((tun) => !tun.jumpTunnelId || !ids.has(tun.jumpTunnelId))
    .forEach((root) => walk(root, 0));
  return rows;
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
}: Props) {
  const { t } = useTranslation("terminal");
  return (
    <ul role="tree" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      {rows.map(({ tunnel: tun, depth, childCount }) => {
        const status = statuses[tun.id]?.status ?? "disconnected";
        const open = panesPerHost[tun.id] ?? 0;
        const highlighted = tun.id === highlightId;
        const isCollapsed = collapsed.has(tun.id);
        return (
          <li key={tun.id} role="treeitem" aria-expanded={childCount > 0 ? !isCollapsed : undefined}>
            <button
              onClick={() => onHighlight(tun.id)}
              onDoubleClick={() => onOpen(tun.id)}
              onPointerDown={beginDrag({ kind: "host", tunnelId: tun.id }, tun.name)}
              title={t("openHint")}
              style={{ paddingLeft: 4 + depth * 14 }}
              className={`group flex w-full cursor-grab items-center gap-1.5 rounded py-1.5 pr-2 text-left ${
                highlighted ? "bg-surface-hover" : "hover:bg-surface-hover"
              }`}
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
                </span>
              </span>
              {open > 0 && (
                <span className="rounded bg-accent/15 px-1.5 text-[11px] font-medium text-accent">
                  {open}
                </span>
              )}
              <span
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
              </span>
            </button>
          </li>
        );
      })}
      {rows.length === 0 && <li className="px-2 py-3 text-xs text-muted">{emptyText}</li>}
    </ul>
  );
}
