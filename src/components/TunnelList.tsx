import { useState, type FormEvent } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { PortForward, Tunnel } from "../types";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { TunnelStats } from "../types";
import { formatBytes, formatDuration } from "../format";
import { addPortForward, deletePortForward } from "../api";

const LINE_COLOR: Record<string, string> = {
  disconnected: "text-slate",
  connecting: "text-amber",
  connected: "text-accent",
  error: "text-coral",
};

const DOT_COLOR: Record<string, string> = {
  disconnected: "bg-slate",
  connecting: "bg-amber",
  connected: "bg-accent",
  error: "bg-coral",
};

interface Props {
  tunnels: Tunnel[];
  statuses: Record<string, TunnelRuntimeState>;
  stats: Record<string, TunnelStats>;
  suggestedForwardPort: number;
  onToggle: (tunnel: Tunnel) => void;
  onEdit: (tunnel: Tunnel) => void;
  onClone: (tunnel: Tunnel) => void;
  onDelete: (tunnel: Tunnel) => void;
  onRefresh: () => Promise<void>;
  onError: (text: string) => void;
}

export function TunnelList({
  tunnels,
  statuses,
  stats,
  suggestedForwardPort,
  onToggle,
  onEdit,
  onClone,
  onDelete,
  onRefresh,
  onError,
}: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
        No tunnels yet. Add one to open a socket.
      </div>
    );
  }

  const tunnelIds = new Set(tunnels.map((t) => t.id));
  const childrenByParent = new Map<string, Tunnel[]>();
  for (const tunnel of tunnels) {
    if (tunnel.jumpTunnelId && tunnelIds.has(tunnel.jumpTunnelId)) {
      const siblings = childrenByParent.get(tunnel.jumpTunnelId) ?? [];
      siblings.push(tunnel);
      childrenByParent.set(tunnel.jumpTunnelId, siblings);
    }
  }
  const roots = tunnels.filter(
    (t) => !t.jumpTunnelId || !tunnelIds.has(t.jumpTunnelId),
  );

  const rows: { tunnel: Tunnel; depth: number }[] = [];
  for (const root of roots) {
    rows.push({ tunnel: root, depth: 0 });
    if (!collapsedGroups.has(root.id)) {
      for (const child of childrenByParent.get(root.id) ?? []) {
        rows.push({ tunnel: child, depth: 1 });
      }
    }
  }

  return (
    <ul className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
      {rows.map(({ tunnel, depth }) => {
        const children = childrenByParent.get(tunnel.id) ?? [];
        const hasChildren = children.length > 0;
        const isCollapsed = collapsedGroups.has(tunnel.id);
        const runtime = statuses[tunnel.id];
        const status = runtime?.status ?? "disconnected";
        const isBusy = status === "connecting";
        const isOn = status === "connected" || status === "connecting";
        const tunnelStats = stats[tunnel.id];
        const lineClass =
          status === "connected"
            ? "tunnel-line tunnel-line--live"
            : status === "connecting"
              ? "tunnel-line tunnel-line--pending"
              : "tunnel-line";

        return (
          <li
            key={tunnel.id}
            style={depth > 0 ? { marginLeft: 20 } : undefined}
            className={`rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-hover ${
              depth > 0 ? "border-l-2 border-l-accent/40" : ""
            }`}
          >
            <div className="flex items-center gap-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[status]}`} />

              {hasChildren && (
                <button
                  onClick={() => toggleGroup(tunnel.id)}
                  title={isCollapsed ? "Expand dependents" : "Collapse dependents"}
                  aria-expanded={!isCollapsed}
                  className="shrink-0 rounded px-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
                >
                  {isCollapsed ? "▸" : "▾"}
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
                aria-label={isOn ? "Disconnect" : "Connect"}
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
                title="Port forwards"
                aria-expanded={expanded.has(tunnel.id)}
                className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
              >
                {expanded.has(tunnel.id) ? "▾" : "▸"} Forwards
                {tunnel.forwards.length > 0 ? ` (${tunnel.forwards.length})` : ""}
              </button>
              <button
                onClick={() => onClone(tunnel)}
                title="Clone"
                className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
              >
                Clone
              </button>
              <button
                onClick={() => onEdit(tunnel)}
                title="Edit"
                className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(tunnel)}
                title="Delete"
                className="rounded px-2 py-1 text-xs font-medium text-coral hover:bg-coral/10"
              >
                Delete
              </button>
            </div>

            <div className="mt-2.5 flex items-center gap-2 font-mono text-[11px]">
              {tunnel.socksEnabled && (
                <button
                  onClick={() => copySocksCommand(tunnel)}
                  title="Copy curl --socks5 command"
                  className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-text hover:border-accent hover:text-accent"
                >
                  {copiedId === tunnel.id ? "copied" : `:${tunnel.localSocksPort}`}
                </button>
              )}
              <div className={`h-0.5 flex-1 ${lineClass} ${LINE_COLOR[status]}`} />
              <span className="shrink-0 truncate text-muted">
                {tunnel.username}@{tunnel.host}:{tunnel.port}
                {tunnel.jumpTunnelId && (
                  <> via {tunnels.find((t) => t.id === tunnel.jumpTunnelId)?.name ?? "?"}</>
                )}
              </span>
            </div>

            {status === "connected" && tunnelStats && (
              <p className="mt-1.5 font-mono text-[11px] text-muted">
                ↑ {formatBytes(tunnelStats.bytesUp)} ↓ {formatBytes(tunnelStats.bytesDown)} ·{" "}
                {formatDuration(tunnelStats.uptimeSecs)}
              </p>
            )}
            {status === "error" && runtime?.message && (
              <p className="mt-1.5 truncate text-[11px] text-coral">{runtime.message}</p>
            )}

            {expanded.has(tunnel.id) && (
              <ForwardsPanel
                tunnel={tunnel}
                suggestedForwardPort={suggestedForwardPort}
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

function ForwardsPanel({
  tunnel,
  suggestedForwardPort,
  onRefresh,
  onError,
}: {
  tunnel: Tunnel;
  suggestedForwardPort: number;
  onRefresh: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(0);
  const [localPort, setLocalPort] = useState(suggestedForwardPort);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addPortForward(tunnel.id, { remoteHost, remotePort, localPort });
      await onRefresh();
      setRemoteHost("");
      setRemotePort(0);
      setLocalPort(suggestedForwardPort);
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
        <p className="text-[11px] text-muted">No port forwards yet.</p>
      )}
      {tunnel.forwards.map((forward) => (
        <div key={forward.id} className="flex items-center gap-2 font-mono text-[11px] text-text">
          <span className="flex-1 truncate">
            {forward.remoteHost}:{forward.remotePort} → :{forward.localPort}
          </span>
          <button
            onClick={() => remove(forward)}
            title="Remove forward"
            className="shrink-0 rounded px-1.5 py-0.5 text-coral hover:bg-coral/10"
          >
            Remove
          </button>
        </div>
      ))}

      <form onSubmit={submit} className="flex items-center gap-1.5 pt-1">
        <input
          value={remoteHost}
          onChange={(e) => setRemoteHost(e.target.value)}
          placeholder="remote host"
          required
          className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <input
          type="number"
          value={remotePort || ""}
          onChange={(e) => setRemotePort(Number(e.target.value))}
          placeholder="remote port"
          required
          className="w-20 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <span className="text-muted">→</span>
        <input
          type="number"
          value={localPort || ""}
          onChange={(e) => setLocalPort(Number(e.target.value))}
          placeholder="local port"
          required
          className="w-20 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}
