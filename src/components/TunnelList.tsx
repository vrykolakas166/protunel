import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { PortForward, Tunnel } from "../types";
import type { Throughput, TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { TunnelStats } from "../types";
import { formatBytes, formatDuration } from "../format";
import { addPortForward, deletePortForward } from "../api";
import { TunnelWaveform } from "./TunnelWaveform";

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
}

/** The tunnel a row hangs under in the tree, or null for a top-level row. */
function parentOf(tunnel: Tunnel, ids: Set<string>): string | null {
  return tunnel.jumpTunnelId && ids.has(tunnel.jumpTunnelId) ? tunnel.jumpTunnelId : null;
}

export function TunnelList({
  tunnels,
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

  // FLIP: while a drag reshuffles rows, each row glides from where it was to
  // where it now is instead of jumping.
  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    rowRefs.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top;
      tops.set(id, top);
      const previous = lastTops.current.get(id);
      if (dragId && previous !== undefined && Math.abs(previous - top) > 1) {
        el.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "none" }], {
          duration: 160,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    });
    lastTops.current = tops;
  });

  /**
   * Drag by the grip only. A row moves among its siblings: top-level rows
   * among top-level rows, a dependent among the dependents of the same
   * parent. A drag can never change which tunnel another jumps through.
   */
  const startReorder = (tunnel: Tunnel) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const ids = new Set(tunnels.map((tun) => tun.id));
    const byId = new Map(tunnels.map((tun) => [tun.id, tun]));
    const parent = parentOf(tunnel, ids);
    const initial = tunnels.map((tun) => tun.id);
    let current = initial;
    setDragId(tunnel.id);
    setOrder(current);

    const move = (ev: PointerEvent) => {
      const row = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-tunnel-row]");
      const targetId = row?.dataset.tunnelRow;
      const target = targetId ? byId.get(targetId) : undefined;
      if (!row || !target || target.id === tunnel.id || parentOf(target, ids) !== parent) return;
      // Cross the target's middle before swapping, so a row doesn't flicker
      // back and forth while the pointer sits on the boundary.
      const rect = row.getBoundingClientRect();
      const movingDown = current.indexOf(target.id) > current.indexOf(tunnel.id);
      const past = movingDown
        ? ev.clientY > rect.top + rect.height / 2
        : ev.clientY < rect.top + rect.height / 2;
      if (!past) return;
      const next = current.filter((id) => id !== tunnel.id);
      next.splice(next.indexOf(target.id) + (movingDown ? 1 : 0), 0, tunnel.id);
      current = next;
      setOrder(next);
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (commit && current.join() !== initial.join()) onReorder(current);
      setDragId(null);
      setOrder(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
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
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        {t("empty")}
      </div>
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
    <ul className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
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
            ref={(el) => {
              if (el) rowRefs.current.set(tunnel.id, el);
              else rowRefs.current.delete(tunnel.id);
            }}
            style={{
              marginLeft: depth > 0 ? depth * 20 : undefined,
              borderLeftColor: `color-mix(in srgb, var(--color-accent) ${treeTint}%, transparent)`,
            }}
            className={`rounded-lg border border-l-2 border-border bg-surface p-3 transition-colors hover:bg-surface-hover ${
              dragId === tunnel.id ? "relative z-10 shadow-lg ring-2 ring-accent" : ""
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

              <p className="min-w-0 flex-1 truncate font-display text-sm font-medium text-text">
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
                {expanded.has(tunnel.id) ? "▾" : "▸"} {t("forwards")}
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
              <span className="shrink-0 truncate text-muted">
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
              <p className="mt-1.5 truncate text-[11px] text-amber">
                {t("reconnecting", { message: runtime?.message ?? "" })}
              </p>
            )}
            {status === "error" && runtime?.message && (
              <p className="mt-1.5 truncate text-[11px] text-coral">{runtime.message}</p>
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
          className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {t("add")}
        </button>
      </form>
    </div>
  );
}
