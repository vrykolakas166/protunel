import type { Tunnel } from "../types";
import type { TunnelRuntimeState } from "../hooks/useTunnelEvents";

const STATUS_COLOR: Record<string, string> = {
  disconnected: "bg-neutral-400",
  connecting: "bg-amber-500",
  connected: "bg-emerald-500",
  error: "bg-red-500",
};

interface Props {
  tunnels: Tunnel[];
  statuses: Record<string, TunnelRuntimeState>;
  onToggle: (tunnel: Tunnel) => void;
  onEdit: (tunnel: Tunnel) => void;
  onDelete: (tunnel: Tunnel) => void;
}

export function TunnelList({ tunnels, statuses, onToggle, onEdit, onDelete }: Props) {
  if (tunnels.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        No tunnels yet. Add one to get started.
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

        return (
          <li
            key={tunnel.id}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLOR[status]}`} />

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {tunnel.name}
              </p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                {tunnel.username}@{tunnel.host}:{tunnel.port} → socks5://127.0.0.1:
                {tunnel.localSocksPort}
              </p>
              {status === "error" && runtime?.message && (
                <p className="truncate text-xs text-red-600 dark:text-red-400">
                  {runtime.message}
                </p>
              )}
            </div>

            <button
              onClick={() => onToggle(tunnel)}
              disabled={isBusy}
              aria-pressed={isOn}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                isOn ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-700"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  isOn ? "translate-x-4" : ""
                }`}
              />
            </button>

            <button
              onClick={() => onEdit(tunnel)}
              className="rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(tunnel)}
              className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              Delete
            </button>
          </li>
        );
      })}
    </ul>
  );
}
