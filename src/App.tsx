import { useCallback, useEffect, useMemo, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { AddTunnelForm } from "./components/AddTunnelForm";
import { ConfigPanel } from "./components/ConfigPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { KnownHostsPanel } from "./components/KnownHostsPanel";
import { MessageBar } from "./components/MessageBar";
import { RouterPanel } from "./components/RouterPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TourGuide, type TourPanel } from "./components/TourGuide";
import { TunnelList } from "./components/TunnelList";
import { useRouterEvents } from "./hooks/useRouterEvents";
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
  updateSettings,
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

function usedLocalPorts(tunnels: Tunnel[]): Set<number> {
  const used = new Set<number>();
  for (const tunnel of tunnels) {
    if (tunnel.socksEnabled) used.add(tunnel.localSocksPort);
    for (const forward of tunnel.forwards) used.add(forward.localPort);
  }
  return used;
}

function suggestPort(tunnels: Tunnel[], settings: Settings | null): number {
  if (!settings) return 1080;
  const used = usedLocalPorts(tunnels);
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
  const [showRouter, setShowRouter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<"connect" | "disconnect" | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);

  useTheme(settings?.theme ?? "system");

  const router = useRouterEvents();

  const { statuses, stats, hostKeyQueue, dismissHostKey } = useTunnelEvents((_tunnelId, text) =>
    setMessage({ text, isError: true }),
  );

  useEffect(() => {
    listTunnels()
      .then(setTunnels)
      .catch((err) => setMessage({ text: String(err), isError: true }));
    getSettings().then((loaded) => {
      setSettings(loaded);
      // Runs itself once on a fresh install, then never again unless replayed.
      if (!loaded.tourCompleted) setShowTour(true);
    });
    check()
      .then((update) => update && setPendingUpdate(update))
      .catch(() => {});
  }, []);

  const installUpdate = async () => {
    if (!pendingUpdate) return;
    setUpdateInstalling(true);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (err) {
      setMessage({ text: String(err), isError: true });
      setUpdateInstalling(false);
    }
  };

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const refresh = async () => setTunnels(await listTunnels());

  // The tour drives the modals itself so it can point at things inside them.
  // Everything it opens is closed again when it moves on or ends.
  const showTourPanel = useCallback((panel: TourPanel | null) => {
    setShowRouter(panel === "router");
    setShowKnownHosts(panel === "hosts");
    setShowSettings(panel === "settings");
    setFormState(panel === "add" ? { mode: "add" } : null);
  }, []);

  const finishTour = async () => {
    setShowTour(false);
    if (!settings || settings.tourCompleted) return;
    try {
      setSettings(await updateSettings({ ...settings, tourCompleted: true }));
    } catch {
      // Not worth interrupting anyone over; worst case the tour offers itself
      // again next launch.
    }
  };

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
      if (status === "connected" || status === "connecting" || status === "reconnecting") {
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

  const confirmBulkAction = async () => {
    const action = pendingBulkAction;
    setPendingBulkAction(null);
    if (action === "connect") await handleConnectAll();
    else if (action === "disconnect") await handleDisconnectAll();
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
          data-tour="search"
          className="ml-2 w-36 rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setShowRouter(true)}
            data-tour="router"
            title={
              router.status === "running"
                ? `Router listening on 127.0.0.1:${router.port}`
                : "Rule-based proxy router"
            }
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                router.status === "running"
                  ? "bg-accent"
                  : router.status === "error"
                    ? "bg-coral"
                    : "bg-slate"
              }`}
            />
            Router
          </button>
          <button
            onClick={() => setShowKnownHosts(true)}
            data-tour="hosts"
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Hosts
          </button>
          <button
            onClick={() => setShowSettings(true)}
            data-tour="settings"
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Settings
          </button>
          <button
            onClick={() => setFormState({ mode: "add" })}
            data-tour="add"
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Add tunnel
          </button>
        </div>
      </header>

      <MessageBar text={message?.text ?? null} isError={message?.isError ?? false} />

      {pendingUpdate && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-accent/10 px-4 py-2 text-sm text-text">
          <span>Update v{pendingUpdate.version} available.</span>
          <button
            onClick={installUpdate}
            disabled={updateInstalling}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {updateInstalling ? "Installing…" : "Install & restart"}
          </button>
        </div>
      )}

      <div
        data-tour="bulk"
        className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2"
      >
        <button
          onClick={() => setPendingBulkAction("connect")}
          disabled={filteredTunnels.length === 0}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Connect all
        </button>
        <button
          onClick={() => setPendingBulkAction("disconnect")}
          disabled={filteredTunnels.length === 0}
          className="rounded bg-coral px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Disconnect all
        </button>
      </div>

      <div data-tour="list" className="flex min-h-0 flex-1 flex-col">
        <TunnelList
          tunnels={filteredTunnels}
          statuses={statuses}
          stats={stats}
          suggestedForwardPort={suggestPort(tunnels, settings)}
          onToggle={handleToggle}
          onEdit={(tunnel) => setFormState({ mode: "edit", tunnel })}
          onClone={(tunnel) => setFormState({ mode: "clone", tunnel })}
          onDelete={setPendingDelete}
          onRefresh={refresh}
          onError={(text) => setMessage({ text, isError: true })}
        />
      </div>

      {formState && (
        <AddTunnelForm
          mode={formState.mode}
          initial={formState.mode === "add" ? null : formState.tunnel}
          suggestedPort={suggestPort(tunnels, settings)}
          tunnels={tunnels}
          onSubmit={handleSubmit}
          onCancel={() => setFormState(null)}
        />
      )}

      {showKnownHosts && <KnownHostsPanel onClose={() => setShowKnownHosts(false)} />}
      {showRouter && (
        <RouterPanel
          tunnels={tunnels}
          runtime={router}
          onClose={() => setShowRouter(false)}
        />
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSettingsChange={setSettings}
          onOpenConfig={() => {
            setShowSettings(false);
            setShowConfig(true);
          }}
        />
      )}
      {showConfig && (
        <ConfigPanel
          onClose={() => setShowConfig(false)}
          onImported={() => {
            void refresh();
            getSettings().then(setSettings);
          }}
        />
      )}
      {/* Below the tour overlay's z-index so it is dimmed along with everything
          else while the tour runs. */}
      {!showTour && (
        <button
          onClick={() => setShowTour(true)}
          title="Show the guided tour"
          aria-label="Show the guided tour"
          className="fixed bottom-4 left-4 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-base font-semibold text-muted shadow-lg transition-colors hover:bg-surface-hover hover:text-text"
        >
          ?
        </button>
      )}

      {showTour && <TourGuide onFinish={finishTour} onRequestPanel={showTourPanel} />}

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

      {pendingBulkAction && (
        <ConfirmDialog
          title={pendingBulkAction === "connect" ? "Connect all tunnels" : "Disconnect all tunnels"}
          message={
            pendingBulkAction === "connect"
              ? "Connect every tunnel in the list?"
              : "Disconnect every active tunnel?"
          }
          confirmLabel={pendingBulkAction === "connect" ? "Connect all" : "Disconnect all"}
          tone={pendingBulkAction === "connect" ? "accent" : "danger"}
          onConfirm={confirmBulkAction}
          onCancel={() => setPendingBulkAction(null)}
        />
      )}
    </main>
  );
}

export default App;
