import { useEffect, useState } from "react";
import { forgetKnownHost, listKnownHosts } from "../api";
import type { KnownHostEntry } from "../types";

interface Props {
  onClose: () => void;
}

export function KnownHostsPanel({ onClose }: Props) {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setEntries(await listKnownHosts());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const forget = async (keyId: string) => {
    await forgetKnownHost(keyId);
    await refresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-text">Known hosts</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-muted hover:bg-surface-hover hover:text-text"
          >
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Host keys trusted via the connect-time confirmation prompt. Forgetting one means the
          next connection to that host re-prompts.
        </p>

        <div className="mt-4 max-h-96 overflow-y-auto">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No trusted hosts yet.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => (
                <li key={entry.keyId} className="rounded border border-border bg-bg p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-text">{entry.keyId}</span>
                    <button
                      onClick={() => forget(entry.keyId)}
                      className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-coral hover:bg-coral/10"
                    >
                      Forget
                    </button>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted">
                    {entry.algorithm} · {entry.fingerprint}
                  </p>
                  <p className="text-[11px] text-muted">
                    Trusted {new Date(entry.trustedAt * 1000).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
