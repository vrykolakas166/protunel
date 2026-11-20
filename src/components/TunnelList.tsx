import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { hostKeyId } from "../hooks/useHostKeyMismatches";
import type { HostKeyMismatch, PortForward, Tunnel } from "../types";
import type { Throughput, TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { TunnelStats } from "../types";
import { formatBytes, formatDuration } from "../format";
import { addPortForward, deletePortForward } from "../api";
import { TunnelWaveform } from "./TunnelWaveform";
import { openMenu } from "../contextMenu";

const DOT_COLOR: Record<string, string> = {
  disconnected: "bg-slate",
  connecting: "bg-amber",
  reconnecting: "bg-amber",
  connected: "bg-accent",
  error: "bg-coral",
};

interface Props {
  tunnels: Tunnel[];
  statuses: Record<string, TunnelRuntimeState>;
  stats: Record<string, TunnelStats>;
  throughput: Record<string, Throughput>;
  suggestedForwardPort: number;
  onToggle: (tunnel: Tunnel) => void;
  onEdit: (tunnel: Tunnel) => void;
  onClone: (tunnel: Tunnel) => void;
  onDelete: (tunnel: Tunnel) => void;
  onRefresh: () => Promise<void>;
  onError: (text: string) => void;
  /** New order of `tunnels` (ids, top to bottom) after a drag-and-drop. */
  onReorder: (ids: string[]) => void;
  /** Refused host keys by `host:port` (see `useHostKeyMismatches`). */
  hostKeyMismatches: Record<string, HostKeyMismatch>;
  onReviewHostKey: (tunnel: Tunnel) => void;
  /** The search `tunnels` was filtered by ("" when not searching). */
  searchQuery: string;
  onClearSearch: () => void;
}

/** The tunnel a row hangs under in the tree, or null for a top-level row. */
function parentOf(tunnel: Tunnel, ids: Set<string>): string | null {
  return tunnel.jumpTunnelId && ids.has(tunnel.jumpTunnelId) ? tunnel.jumpTunnelId : null;
}

export function TunnelList({
  tunnels,
  searchQuery,
  onClearSearch,
  statuses,
  stats,
  throughput,
  onToggle,
  onEdit,
  onClone,
  onDelete,
  onRefresh,
  onError,
  onReorder,
  hostKeyMismatches,
  onReviewHostKey,
}: Props) {
  const { t } = useTranslation("tunnelList");
  const { t: tc } = useTranslation("common");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // While dragging: the live order (ids) and the row being dragged.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const lastTops = useRef(new Map<string, number>());

  const listRef = useRef<HTMLUListElement>(null);
  /** The live drag, read by pointer handlers and the layout effect alike. */
  const drag = useRef<{
    id: string;
    /** It and its dependents: they travel as one block. */
    block: Set<string>;
    /** Pointer y (list content coordinates) minus the row's top at grab. */
    grab: number;
    /** Last pointer y, list content coordinates. */
    y: number;
  } | null>(null);
  /**
   * Set by a drop or cancel: the block just released. The next render clears
   * its transform and glides every row into place (in the same frame, so the
   * block never flashes at its slot first).
   */
  const settling = useRef<Set<string> | null>(null);

  /** List content y of a viewport y (scroll included). */
  const contentY = (clientY: number) => {
    const list = listRef.current!;
    return clientY - list.getBoundingClientRect().top + list.scrollTop;
  };

  /** Keeps the dragged block under the pointer, wherever its slot now is. */
  const placeDragged = () => {
    const current = drag.current;
    if (!current) return;
    const anchor = rowRefs.current.get(current.id);
    if (!anchor) return;
    const offset = current.y - current.grab - anchor.offsetTop;
    for (const id of current.block) {
      const el = rowRefs.current.get(id);
      if (el) el.style.transform = `translateY(${offset}px)`;
    }
  };

  // FLIP: when a drag reshuffles rows, every other row glides from where it
  // was to where it now is. The dragged block is skipped: it follows the
  // pointer instead (`placeDragged`). Positions are `offsetTop`, which
  // ignores transforms, so a glide in progress doesn't skew the next one.
  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    const moving = drag.current?.block;
    const released = settling.current;
    settling.current = null;
    released?.forEach((id) => {
      const el = rowRefs.current.get(id);
      if (el) el.style.transform = "";
    });
    const animate = !!moving || !!released;
    rowRefs.current.forEach((el, id) => {
      const top = el.offsetTop;
      tops.set(id, top);
      const previous = lastTops.current.get(id);
      if (animate && !moving?.has(id) && previous !== undefined && Math.abs(previous - top) > 1) {
        el.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "none" }], {
          duration: 180,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    });
    lastTops.current = tops;
    placeDragged();
  });

  /**
   * Drag by the grip only. A row moves among its siblings: top-level rows
   * among top-level rows, a dependent among the dependents of the same
   * parent. A drag can never change which tunnel another jumps through.
   */
  const startReorder = (tunnel: Tunnel) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    const row = rowRefs.current.get(tunnel.id);
    const list = listRef.current;
    if (!row || !list) return;
    // Listen on the window, not the grip with pointer capture: reordering
    // makes React move the row's DOM node, which drops the capture and left
    // the drag stalling until the pointer happened to cross the grip again.
    const ids = new Set(tunnels.map((tun) => tun.id));
    const parent = parentOf(tunnel, ids);
    const initial = tunnels.map((tun) => tun.id);
    let current = initial;

    // The row plus everything that jumps through it, at any depth.
    const block = new Set([tunnel.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const tun of tunnels) {
        if (!block.has(tun.id) && tun.jumpTunnelId && block.has(tun.jumpTunnelId)) {
          block.add(tun.id);
          grew = true;
        }
      }
    }
    const y = contentY(e.clientY);
    drag.current = { id: tunnel.id, block, grab: y - row.offsetTop, y };
    setDragId(tunnel.id);
    setOrder(current);

    const move = (ev: PointerEvent) => {
      const state = drag.current;
      if (!state || ev.pointerId !== pointerId) return;
      // Nudge the list along when the pointer nears its edges.
      const rect = list.getBoundingClientRect();
      if (ev.clientY < rect.top + 32) list.scrollTop -= 12;
      else if (ev.clientY > rect.bottom - 32) list.scrollTop += 12;
      state.y = contentY(ev.clientY);

      // The block's middle decides its slot among its siblings.
      const anchor = rowRefs.current.get(tunnel.id)!;
      const middle = state.y - state.grab + anchor.offsetHeight / 2;
      const siblings = current.filter(
        (id) => id !== tunnel.id && parentOf(tunnels.find((tun) => tun.id === id)!, ids) === parent,
      );
      if (siblings.length === 0) {
        placeDragged();
        return;
      }
      const before = siblings.find((id) => {
        const el = rowRefs.current.get(id);
        return el && middle < el.offsetTop + el.offsetHeight / 2;
      });
      const next = current.filter((id) => id !== tunnel.id);
      const at = before !== undefined ? next.indexOf(before) : next.indexOf(siblings[siblings.length - 1]) + 1;
      next.splice(at, 0, tunnel.id);
      if (next.join() !== current.join()) {
        current = next;
        setOrder(next);
      } else {
        placeDragged();
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.style.removeProperty("cursor");
      window.removeEventListener("keydown", onKey, true);
      const order = commit ? current : initial;
      // The block is drawn where the pointer left it: record that as its
      // last position, so the next render's FLIP glides it (and, on a
      // cancel, every row) into the final slots.
      const anchor = rowRefs.current.get(tunnel.id);
      const offset = anchor ? drag.current!.y - drag.current!.grab - anchor.offsetTop : 0;
      for (const id of block) {
        const el = rowRefs.current.get(id);
        if (el) lastTops.current.set(id, el.offsetTop + offset);
      }
      drag.current = null;
      settling.current = block;
      if (commit && order.join() !== initial.join()) onReorder(order);
      setDragId(null);
      setOrder(null);
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // The grip's cursor, wherever the pointer wanders while dragging.
    document.body.style.cursor = "grabbing";
    window.addEventListener("keydown", onKey, true);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copySocksCommand = async (tunnel: Tunnel) => {
    await writeText(`curl --socks5 127.0.0.1:${tunnel.localSocksPort} https://`);
    setCopiedId(tunnel.id);
    setTimeout(() => setCopiedId((current) => (current === tunnel.id ? null : current)), 1500);
  };

  if (tunnels.length === 0) {
    // A search that matches nothing is not an empty list: the tunnels are
    // all still there, and saying otherwise reads as if they were lost.
    return searchQuery.trim() ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
        <span>{t("noMatches", { query: searchQuery.trim() })}</span>
        <button
          onClick={onClearSearch}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text hover:border-accent hover:text-accent"
        >
          {t("clearSearch")}
        </button>
      </div>
    ) : (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">{t("empty")}</div>
    );
  }

  const byIdAll = new Map(tunnels.map((tun) => [tun.id, tun]));
  const ordered = order
    ? order.map((id) => byIdAll.get(id)).filter((tun): tun is Tunnel => !!tun)
    : tunnels;
  const tunnelIds = new Set(ordered.map((t) => t.id));
  const childrenByParent = new Map<string, Tunnel[]>();
  for (const tunnel of ordered) {
    if (tunnel.jumpTunnelId && tunnelIds.has(tunnel.jumpTunnelId)) {
      const siblings = childrenByParent.get(tunnel.jumpTunnelId) ?? [];
      siblings.push(tunnel);
      childrenByParent.set(tunnel.jumpTunnelId, siblings);
    }
  }
  const roots = ordered.filter(
    (t) => !t.jumpTunnelId || !tunnelIds.has(t.jumpTunnelId),
  );

  const rows: { tunnel: Tunnel; depth: number }[] = [];
  const visited = new Set<string>();
  const pushSubtree = (tunnel: Tunnel, depth: number) => {
    if (visited.has(tunnel.id)) return; // guards a jump-chain cycle from bad data
    visited.add(tunnel.id);
    rows.push({ tunnel, depth });
    if (collapsedGroups.has(tunnel.id)) return;
    for (const child of childrenByParent.get(tunnel.id) ?? []) {
      pushSubtree(child, depth + 1);
    }
  };
  for (const root of roots) {
    pushSubtree(root, 0);
  }

  return (
    // `relative`: rows measure `offsetTop` against the list itself.
    // pb-16: the last row can scroll clear of the floating "?" tour button.
    <ul ref={listRef} className="relative flex flex-1 flex-col gap-2 overflow-y-auto p-4 pb-16">
      {rows.map(({ tunnel, depth }) => {
        const children = childrenByParent.get(tunnel.id) ?? [];
        const hasChildren = children.length > 0;
        const isCollapsed = collapsedGroups.has(tunnel.id);
        const runtime = statuses[tunnel.id];
        const status = runtime?.status ?? "disconnected";
        // Reconnecting is still "on": the tunnel task owns its ports and is
        // working its way back, so the toggle stays lit and stays clickable.
        const isBusy = status === "connecting";
        const isOn =
          status === "connected" || status === "connecting" || status === "reconnecting";
        const tunnelStats = stats[tunnel.id];
        const tunnelThroughput = throughput[tunnel.id];

        const treeTint = Math.min(20 + depth * 20, 90); // % accent mixed in; root lightest, deeper levels darker

        return (
          <li
            key={tunnel.id}
            data-tunnel-row={tunnel.id}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: isOn ? t("disconnect") : t("connect"), enabled: !isBusy, action: () => onToggle(tunnel) },
                "separator",
                { label: tc("edit"), action: () => onEdit(tunnel) },
                { label: tc("clone"), action: () => onClone(tunnel) },
                {
                  label: expanded.has(tunnel.id) ? t("menu.hideForwards") : t("menu.showForwards"),
                  action: () => toggleExpanded(tunnel.id),
                },
                "separator",
                ...(tunnel.socksEnabled
                  ? [{ label: t("menu.copySocks"), action: () => void writeText(`127.0.0.1:${tunnel.localSocksPort}`) }]
                  : []),
                {
                  label: t("menu.copyTarget"),
                  action: () => void writeText(`${tunnel.username}@${tunnel.host}:${tunnel.port}`),
                },
                "separator",
                { label: tc("delete"), action: () => onDelete(tunnel) },
              ])
            }
            ref={(el) => {
              if (el) rowRefs.current.set(tunnel.id, el);
              else rowRefs.current.delete(tunnel.id);
            }}
            style={{
              marginLeft: depth > 0 ? depth * 20 : undefined,
              borderLeftColor: `color-mix(in srgb, var(--color-accent) ${treeTint}%, transparent)`,
            }}
            className={`@container rounded-lg border border-l-2 border-border bg-surface p-3 transition-colors hover:bg-surface-hover ${
              dragId === tunnel.id
                ? "relative z-10 shadow-lg ring-2 ring-accent"
                : dragId && drag.current?.block.has(tunnel.id)
                  ? "relative z-10 shadow-lg"
                  : ""
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                onPointerDown={startReorder(tunnel)}
                title={t("dragToReorder")}
                aria-label={t("dragToReorder")}
                className={`-my-1 -ml-1.5 -mr-1.5 shrink-0 touch-none rounded px-0.5 py-1 hover:bg-surface-hover hover:text-text ${
                  dragId === tunnel.id ? "cursor-grabbing text-accent" : "cursor-grab text-muted/60"
                }`}
              >
                <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
                  <circle cx="2" cy="2" r="1.1" />
                  <circle cx="6" cy="2" r="1.1" />
                  <circle cx="2" cy="7" r="1.1" />
                  <circle cx="6" cy="7" r="1.1" />
                  <circle cx="2" cy="12" r="1.1" />
                  <circle cx="6" cy="12" r="1.1" />
                </svg>
              </span>
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[status]}`} />

              {hasChildren && (
                <button
                  onClick={() => toggleGroup(tunnel.id)}
                  title={isCollapsed ? t("expandDependents") : t("collapseDependents")}
                  aria-expanded={!isCollapsed}
                  className="shrink-0 rounded p-1 text-muted hover:bg-surface-hover hover:text-text"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  >
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}

              <p
                title={tunnel.name}
                className="min-w-0 flex-1 truncate font-display text-sm font-medium text-text"
              >
                {tunnel.name}
                {hasChildren && (
                  <span className="ml-1.5 text-[11px] font-normal text-muted">
                    ({children.length})
                  </span>
                )}
              </p>

              <button
                onClick={() => onToggle(tunnel)}
                disabled={isBusy}
                aria-pressed={isOn}
                aria-label={isOn ? t("disconnect") : t("connect")}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                  isOn ? "bg-accent" : "bg-slate/40"
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${
                    isOn ? "translate-x-4" : ""
                  }`}
                />
              </button>

              <button
                onClick={() => toggleExpanded(tunnel.id)}
                title={t("portForwards")}
                aria-expanded={expanded.has(tunnel.id)}
                className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
              >
                {expanded.has(tunnel.id) ? "▾" : "▸"}
                {/* A narrow row keeps the name readable: the label goes, the count stays. */}
                <span className="hidden @md:inline"> {t("forwards")}</span>
                {tunnel.forwards.length > 0 ? ` (${tunnel.forwards.length})` : ""}
              </button>
              <button
                onClick={() => onClone(tunnel)}
                title={tc("clone")}
                aria-label={tc("clone")}
                className="rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="8" y="8" width="13" height="13" rx="1.5" />
                  <path d="M4 16V5a1 1 0 0 1 1-1h11" strokeLinecap="round" />
                </svg>
              </button>
              <button
                onClick={() => onEdit(tunnel)}
                title={tc("edit")}
                aria-label={tc("edit")}
                className="rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 20h9" strokeLinecap="round" />
                  <path
                    d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                onClick={() => onDelete(tunnel)}
                title={tc("delete")}
                aria-label={tc("delete")}
                className="rounded p-1.5 text-coral hover:bg-coral/10"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18" strokeLinecap="round" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" strokeLinecap="round" strokeLinejoin="round" />
                  <path
                    d="M19 6l-.8 13.2a1 1 0 0 1-1 .8H6.8a1 1 0 0 1-1-.8L5 6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div className="mt-2.5 flex items-center gap-2 font-mono text-[11px]">
              {tunnel.socksEnabled && (
                <button
                  onClick={() => copySocksCommand(tunnel)}
                  title={t("copySocksCommand")}
                  className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-text hover:border-accent hover:text-accent"
                >
                  {copiedId === tunnel.id ? t("copied") : `:${tunnel.localSocksPort}`}
                </button>
              )}
              <div className="h-4 flex-1">
                <TunnelWaveform
                  up={tunnelThroughput?.up ?? []}
                  down={tunnelThroughput?.down ?? []}
                  status={status}
                />
              </div>
              <span
                title={`${tunnel.username}@${tunnel.host}:${tunnel.port}`}
                className="min-w-0 max-w-[65%] truncate text-muted"
              >
                {tunnel.username}@{tunnel.host}:{tunnel.port}
                {tunnel.jumpTunnelId && (
                  <>
                    {" "}
                    {t("via", {
                      name: tunnels.find((tt) => tt.id === tunnel.jumpTunnelId)?.name ?? "?",
                    })}
                  </>
                )}
              </span>
            </div>

            {status === "connected" && tunnelStats && (
              <p className="mt-1.5 font-mono text-[11px] text-muted">
                ↑ {formatBytes(tunnelStats.bytesUp)} ↓ {formatBytes(tunnelStats.bytesDown)} ·{" "}
                {formatDuration(tunnelStats.uptimeSecs)}
              </p>
            )}
            {status === "reconnecting" && (
              <p title={runtime?.message ?? undefined} className="mt-1.5 truncate text-[11px] text-amber">
                {t("reconnecting", { message: runtime?.message ?? "" })}
              </p>
            )}
            {hostKeyMismatches[hostKeyId(tunnel)] && status !== "connected" ? (
              // The generic "Unknown server key" error says nothing useful;
              // a changed key gets its own line and a way to act on it.
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-coral">
                <span className="min-w-0 flex-1 truncate">{t("hostKeyChanged")}</span>
                <button
                  onClick={() => onReviewHostKey(tunnel)}
                  className="shrink-0 rounded border border-coral/40 px-1.5 py-0.5 font-medium hover:bg-coral/10"
                >
                  {t("reviewHostKey")}
                </button>
              </div>
            ) : (
              status === "error" &&
              runtime?.message && (
                <p title={runtime.message} className="mt-1.5 truncate text-[11px] text-coral">
                  {runtime.message}
                </p>
              )
            )}

            {expanded.has(tunnel.id) && (
              <ForwardsPanel
                tunnel={tunnel}
                onRefresh={onRefresh}
                onError={onError}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Splits a pasted/typed "host:port" into its parts, e.g. for a remote-host
 * field that also accepts the shorthand. `host` must contain no colon, which
 * naturally excludes bare (unbracketed) IPv6 addresses rather than
 * mis-splitting them. */
function parseHostPort(value: string): { host: string; port: number } | null {
  const match = value.match(/^([^\s:]+):(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function ForwardsPanel({
  tunnel,
  onRefresh,
  onError,
}: {
  tunnel: Tunnel;
  onRefresh: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const { t } = useTranslation("tunnelList");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(0);
  const [localPort, setLocalPort] = useState(0);
  const [busy, setBusy] = useState(false);

  const trySplitHostPort = (value: string) => {
    const parsed = parseHostPort(value);
    if (!parsed) return;
    setRemoteHost(parsed.host);
    setRemotePort(parsed.port);
    setLocalPort(parsed.port);
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Enter-to-submit fires before the remote-host field blurs, so its
      // pending "host:port" split (see onBlur/onPaste below) may not have
      // run yet — resolve it here too rather than trusting stale state.
      const parsed = parseHostPort(remoteHost);
      const host = parsed?.host ?? remoteHost;
      const port = parsed?.port ?? remotePort;
      const local = parsed?.port ?? localPort;
      await addPortForward(tunnel.id, { remoteHost: host, remotePort: port, localPort: local });
      await onRefresh();
      setRemoteHost("");
      setRemotePort(0);
      setLocalPort(0);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (forward: PortForward) => {
    try {
      await deletePortForward(forward.id);
      await onRefresh();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <div className="mt-2.5 space-y-1.5 rounded border border-border bg-bg p-2">
      {tunnel.forwards.length === 0 && (
        <p className="text-[11px] text-muted">{t("noForwardsYet")}</p>
      )}
      {tunnel.forwards.map((forward) => (
        <div key={forward.id} className="flex items-center gap-2 font-mono text-[11px] text-text">
          <span className="flex-1 truncate">
            {forward.remoteHost}:{forward.remotePort} → :{forward.localPort}
          </span>
          <button
            onClick={() => remove(forward)}
            title={t("removeForward")}
            className="shrink-0 rounded px-1.5 py-0.5 text-coral hover:bg-coral/10"
          >
            {t("remove")}
          </button>
        </div>
      ))}

      <form onSubmit={submit} className="flex items-center gap-1.5 pt-1">
        <input
          value={remoteHost}
          onChange={(e) => setRemoteHost(e.target.value)}
          onPaste={(e) => {
            // The paste hasn't landed in the input's value yet at this
            // point in the event — read it back on the next tick once the
            // browser has merged it in.
            const input = e.currentTarget;
            setTimeout(() => trySplitHostPort(input.value), 0);
          }}
          onBlur={(e) => trySplitHostPort(e.target.value)}
          placeholder={t("remoteHostPlaceholder")}
          required
          className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <input
          type="number"
          value={remotePort || ""}
          onChange={(e) => setRemotePort(Number(e.target.value))}
          placeholder={t("remotePortPlaceholder")}
          required
          className="w-24 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <span className="text-muted">→</span>
        <input
          type="number"
          value={localPort || ""}
          onChange={(e) => setLocalPort(Number(e.target.value))}
          placeholder={t("localPortPlaceholder")}
          required
          className="w-24 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {t("add")}
        </button>
      </form>
    </div>
  );
}
