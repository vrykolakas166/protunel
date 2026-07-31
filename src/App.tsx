import { useEffect, useMemo, useState } from "react";
import { AddTunnelForm } from "./components/AddTunnelForm";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { KnownHostsPanel } from "./components/KnownHostsPanel";
import { MessageBar } from "./components/MessageBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { TunnelList } from "./components/TunnelList";
import { useTheme } from "./hooks/useTheme";
import { useTunnelEvents } from "./hooks/useTunnelEvents";
import {
  addTunnel,
  connectAll,
  connectTunnel,
  deleteTunnel,
  disconnectAll,
  disconnectTunnel,
  getSettings,
  listTunnels,
  updateTunnel,
} from "./api";
import type { Settings, Tunnel, TunnelInput } from "./types";

interface Message {
  text: string;
  isError: boolean;
}

type FormState =
  | { mode: "add" }
  | { mode: "edit"; tunnel: Tunnel }
  | { mode: "clone"; tunnel: Tunnel };

function suggestPort(tunnels: Tunnel[], settings: Settings | null): number {
  if (!settings) return 1080;
  const used = new Set(tunnels.map((t) => t.localSocksPort));
  for (let port = settings.portRangeMin; port <= settings.portRangeMax; port++) {
    if (!used.has(port)) return port;
  }
  return settings.portRangeMin;
}

function App() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [search, setSearch] = useState("");
  const [formState, setFormState] = useState<FormState | null>(null);
  const [showKnownHosts, setShowKnownHosts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);

  useTheme(settings?.theme ?? "system");

  const { statuses, stats, hostKeyQueue, dismissHostKey } = useTunnelEvents((_tunnelId, text) =>
    setMessage({ text, isError: true }),
  );

  useEffect(() => {
    listTunnels()
      .then(setTunnels)
      .catch((err) => setMessage({ text: String(err), isError: true }));
    getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const refresh = async () => setTunnels(await listTunnels());

  const activeCount = useMemo(
    () => Object.values(statuses).filter((s) => s.status === "connected").length,
    [statuses],
  );

  const filteredTunnels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tunnels;
    return tunnels.filter(
      (t) => t.name.toLowerCase().includes(query) || t.host.toLowerCase().includes(query),
    );
  }, [tunnels, search]);

  const handleToggle = async (tunnel: Tunnel) => {
    const status = statuses[tunnel.id]?.status ?? "disconnected";
    try {
      if (status === "connected" || status === "connecting") {
        await disconnectTunnel(tunnel.id);
      } else {
        await connectTunnel(tunnel.id);
      }
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteTunnel(pendingDelete.id);
      await refresh();
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    } finally {
      setPendingDelete(null);
    }
  };

  const handleConnectAll = async () => {
    try {
      await connectAll();
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const handleDisconnectAll = async () => {
    try {
      await disconnectAll();
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const handleSubmit = async (input: TunnelInput, secret?: string) => {
    if (formState?.mode === "edit") {
      await updateTunnel(formState.tunnel.id, input, secret);
    } else {
      await addTunnel(input, secret);
    }
    await refresh();
    setFormState(null);
  };

  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <h1 className="font-display text-lg font-semibold text-text">ProdTunnel</h1>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span
            className="h-1.5 w-1.5 rounded-full bg-accent"
            style={{ opacity: activeCount > 0 ? 1 : 0.3 }}
          />
          {activeCount} active
        </span>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="ml-2 w-36 rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={handleConnectAll}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Connect all
          </button>
          <button
            onClick={handleDisconnectAll}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Disconnect all
          </button>
          <button
            onClick={() => setShowKnownHosts(true)}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Hosts
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Settings
          </button>
          <button
            onClick={() => setFormState({ mode: "add" })}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Add tunnel
          </button>
        </div>
      </header>

      <MessageBar text={message?.text ?? null} isError={message?.isError ?? false} />

      <TunnelList
        tunnels={filteredTunnels}
        statuses={statuses}
        stats={stats}
        onToggle={handleToggle}
        onEdit={(tunnel) => setFormState({ mode: "edit", tunnel })}
        onClone={(tunnel) => setFormState({ mode: "clone", tunnel })}
        onDelete={setPendingDelete}
      />

      {formState && (
        <AddTunnelForm
          mode={formState.mode}
          initial={formState.mode === "add" ? null : formState.tunnel}
          suggestedPort={suggestPort(tunnels, settings)}
          onSubmit={handleSubmit}
          onCancel={() => setFormState(null)}
        />
      )}

      {showKnownHosts && <KnownHostsPanel onClose={() => setShowKnownHosts(false)} />}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} onSettingsChange={setSettings} />
      )}

      {hostKeyQueue[0] && (
        <HostKeyPrompt request={hostKeyQueue[0]} onResolved={dismissHostKey} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete tunnel"
          message={`Delete "${pendingDelete.name}"? This disconnects it and removes its saved credentials.`}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </main>
  );
}

export default App;
