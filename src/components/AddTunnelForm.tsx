import { useState, type FormEvent } from "react";
import type { AuthMethod, Tunnel, TunnelInput } from "../types";

type AuthKind = AuthMethod["kind"];

interface Props {
  initial?: Tunnel | null;
  onSubmit: (input: TunnelInput, secret?: string) => Promise<void>;
  onCancel: () => void;
}

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";
const labelClass = "block text-xs font-medium text-neutral-600 dark:text-neutral-400";

export function AddTunnelForm({ initial, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(initial?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(
    initial?.auth.kind === "privateKey" ? initial.auth.path : "",
  );
  const [secret, setSecret] = useState("");
  const [localSocksPort, setLocalSocksPort] = useState(initial?.localSocksPort ?? 1080);
  const [autoConnect, setAutoConnect] = useState(initial?.autoConnect ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        { name, host, port, username, auth, localSocksPort, autoConnect },
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
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900"
      >
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {initial ? "Edit tunnel" : "Add tunnel"}
        </h2>

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
              className={inputClass}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Port</label>
            <input
              type="number"
              className={inputClass}
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
              className={inputClass}
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
              className={inputClass}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={initial ? "Leave blank to keep existing" : ""}
            />
          </div>
        )}

        <div>
          <label className={labelClass}>Local SOCKS port</label>
          <input
            type="number"
            className={inputClass}
            value={localSocksPort}
            onChange={(e) => setLocalSocksPort(Number(e.target.value))}
            required
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
          />
          Connect automatically on startup
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {initial ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
