import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Tunnel } from "../types";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";
import type { TunnelStats } from "../types";
import { formatBytes, formatDuration } from "../format";

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
  onToggle: (tunnel: Tunnel) => void;
  onEdit: (tunnel: Tunnel) => void;
  onClone: (tunnel: Tunnel) => void;
  onDelete: (tunnel: Tunnel) => void;
}

export function TunnelList({ tunnels, statuses, stats, onToggle, onEdit, onClone, onDelete }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  return (
    <ul className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
      {tunnels.map((tunnel) => {
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
            className="rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center gap-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[status]}`} />

              <p className="min-w-0 flex-1 truncate font-display text-sm font-medium text-text">
                {tunnel.name}
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
              <button
                onClick={() => copySocksCommand(tunnel)}
                title="Copy curl --socks5 command"
                className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-text hover:border-accent hover:text-accent"
              >
                {copiedId === tunnel.id ? "copied" : `:${tunnel.localSocksPort}`}
              </button>
              <div className={`h-0.5 flex-1 ${lineClass} ${LINE_COLOR[status]}`} />
              <span className="shrink-0 truncate text-muted">
                {tunnel.username}@{tunnel.host}:{tunnel.port}
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
          </li>
        );
      })}
    </ul>
  );
}
