import { useState, type FormEvent } from "react";
import type { AuthMethod, Tunnel, TunnelInput } from "../types";

type AuthKind = AuthMethod["kind"];
type FormMode = "add" | "edit" | "clone";

interface Props {
  mode: FormMode;
  initial?: Tunnel | null;
  suggestedPort?: number;
  tunnels: Tunnel[];
  onSubmit: (input: TunnelInput, secret?: string) => Promise<void>;
  onCancel: () => void;
}

const TITLE: Record<FormMode, string> = {
  add: "Add tunnel",
  edit: "Edit tunnel",
  clone: "Clone tunnel",
};

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
const monoInputClass = `${inputClass} font-mono`;
const labelClass = "block text-xs font-medium text-muted";

export function AddTunnelForm({ mode, initial, suggestedPort, tunnels, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(
    initial ? (mode === "clone" ? `${initial.name} copy` : initial.name) : "",
  );
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(initial?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(
    initial?.auth.kind === "privateKey" ? initial.auth.path : "",
  );
  const [secret, setSecret] = useState("");
  const [localSocksPort, setLocalSocksPort] = useState(
    initial?.localSocksPort ?? suggestedPort ?? 1080,
  );
  const [autoConnect, setAutoConnect] = useState(mode === "edit" ? (initial?.autoConnect ?? false) : false);
  const [socksEnabled, setSocksEnabled] = useState(initial?.socksEnabled ?? true);
  const [jumpTunnelId, setJumpTunnelId] = useState(initial?.jumpTunnelId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jumpOptions = tunnels.filter((t) => t.id !== initial?.id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const auth: AuthMethod =
        authKind === "privateKey"
          ? { kind: "privateKey", path: keyPath }
          : authKind === "agent"
            ? { kind: "agent" }
            : { kind: "password" };

      await onSubmit(
        {
          name,
          host,
          port,
          username,
          auth,
          localSocksPort,
          autoConnect,
          socksEnabled,
          jumpTunnelId: jumpTunnelId || null,
        },
        secret || undefined,
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface p-5 shadow-xl"
      >
        <h2 className="font-display text-base font-semibold text-text">{TITLE[mode]}</h2>

        <div>
          <label className={labelClass}>Name</label>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className={labelClass}>Host</label>
            <input
              className={monoInputClass}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Port</label>
            <input
              type="number"
              className={monoInputClass}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Username</label>
          <input
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>

        <div>
          <label className={labelClass}>Authentication</label>
          <select
            className={inputClass}
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as AuthKind)}
          >
            <option value="password">Password</option>
            <option value="privateKey">Private key file</option>
            <option value="agent">SSH agent (Pageant)</option>
          </select>
        </div>

        {authKind === "privateKey" && (
          <div>
            <label className={labelClass}>Key file path</label>
            <input
              className={monoInputClass}
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="C:\Users\you\.ssh\id_ed25519"
              required
            />
          </div>
        )}

        {(authKind === "password" || authKind === "privateKey") && (
          <div>
            <label className={labelClass}>
              {authKind === "password" ? "Password" : "Key passphrase (optional)"}
            </label>
            <input
              type="password"
              className={monoInputClass}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                mode === "edit"
                  ? "Leave blank to keep existing"
                  : mode === "clone"
                    ? "Not carried over — re-enter"
                    : ""
              }
            />
          </div>
        )}

        <div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={socksEnabled}
              onChange={(e) => setSocksEnabled(e.target.checked)}
            />
            Enable local SOCKS5 proxy
          </label>
        </div>

        {socksEnabled && (
          <div>
            <label className={labelClass}>Local SOCKS port</label>
            <input
              type="number"
              className={monoInputClass}
              value={localSocksPort}
              onChange={(e) => setLocalSocksPort(Number(e.target.value))}
              required
            />
          </div>
        )}

        <div>
          <label className={labelClass}>Connect via</label>
          <select
            className={inputClass}
            value={jumpTunnelId}
            onChange={(e) => setJumpTunnelId(e.target.value)}
          >
            <option value="">Direct connection</option>
            {jumpOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
          />
          Connect automatically on startup
        </label>

        {error && <p className="text-sm text-coral">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {mode === "edit" ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
