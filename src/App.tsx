import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { AddTunnelForm } from "./components/AddTunnelForm";
import { CapturePanel } from "./components/CapturePanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { KnownHostsPanel } from "./components/KnownHostsPanel";
import { LocalIps } from "./components/LocalIps";
import { MessageBar } from "./components/MessageBar";
import { RouterPanel } from "./components/RouterPanel";
import { Sample1 } from "./components/Sample1";
import { SettingsPanel } from "./components/SettingsPanel";
import { TourGuide, type TourPanel } from "./components/TourGuide";
import { TunnelList } from "./components/TunnelList";
import { useRouterEvents } from "./hooks/useRouterEvents";
import { useLanguage } from "./hooks/useLanguage";
import { useTheme } from "./themes";
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
  openTerminalWindow,
  reorderTunnels,
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
  const { t } = useTranslation("app");
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [showKnownHosts, setShowKnownHosts] = useState(false);
  const [showRouter, setShowRouter] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<"connect" | "disconnect" | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);

  useTheme(settings);
  useLanguage(settings?.language);

  const router = useRouterEvents();

  const { statuses, stats, throughput, hostKeyQueue, dismissHostKey } = useTunnelEvents(
    (_tunnelId, text) => setMessage({ text, isError: true }),
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
    // The terminal window can add and edit hosts too.
    const unlisten = listen("tunnels-changed", () => {
      listTunnels().then(setTunnels).catch(() => {});
    });
    return () => {
      unlisten.then((f) => f());
    };
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

  // Ctrl+F drops the floating search box in; Escape drops it back out and
  // clears the filter, so a closed box never leaves the list silently
  // filtered with no visible reason why.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
      } else if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSearch]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  const refresh = async () => setTunnels(await listTunnels());

  // The tour drives the modals itself so it can point at things inside them.
  // Everything it opens is closed again when it moves on or ends.
  const showTourPanel = useCallback((panel: TourPanel | null) => {
    setShowRouter(panel === "router");
    setShowCapture(panel === "capture");
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

  const filteredTunnels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tunnels;
    return tunnels.filter(
      (tun) => tun.name.toLowerCase().includes(query) || tun.host.toLowerCase().includes(query),
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

  // `ids` is the new order of the rows on screen, which may be a search-filtered
  // subset: those take the slots the visible tunnels held in the full list,
  // and hidden tunnels keep theirs.
  const handleReorder = async (ids: string[]) => {
    const byId = new Map(tunnels.map((tun) => [tun.id, tun]));
    const visible = new Set(ids);
    let next = 0;
    const merged = tunnels.map((tun) => (visible.has(tun.id) ? byId.get(ids[next++])! : tun));
    setTunnels(merged);
    try {
      await reorderTunnels(merged.map((tun) => tun.id));
    } catch (err) {
      setMessage({ text: String(err), isError: true });
      await refresh();
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
        <h1 className="sr-only">ProdTunnel</h1>
        <Sample1 size={40} className="shrink-0" />
        <LocalIps className="flex-1" />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() =>
              openTerminalWindow().catch((err) => setMessage({ text: String(err), isError: true }))
            }
            data-tour="terminal"
            title={t("terminalTooltip")}
            className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs font-medium text-text hover:border-accent hover:bg-surface-hover"
          >
            {/* Prompt glyph: this opens a shell, not a panel. */}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="M4.5 6l2 2-2 2M8 10h3" />
            </svg>
            {t("terminal")}
            {/* Arrow out of a box: opens in its own window. */}
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true">
              <path d="M7 1.5h3.5V5M10.5 1.5 5.5 6.5M9 7.5v2.5a.5.5 0 0 1-.5.5h-6.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5H4.5" />
            </svg>
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <button
            onClick={() => setShowRouter(true)}
            data-tour="router"
            title={
              router.status === "running"
                ? t("routerListening", { port: router.port })
                : t("routerTooltip")
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
            {t("router")}
          </button>
          <button
            onClick={() => setShowCapture(true)}
            data-tour="capture"
            title={t("captureTooltip")}
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {t("capture")}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            data-tour="settings"
            className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {t("settings")}
          </button>
        </div>
      </header>

      <MessageBar text={message?.text ?? null} isError={message?.isError ?? false} />

      {pendingUpdate && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-accent/10 px-4 py-2 text-sm text-text">
          <span>{t("updateAvailable", { version: pendingUpdate.version })}</span>
          <button
            onClick={installUpdate}
            disabled={updateInstalling}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {updateInstalling ? t("installing") : t("installAndRestart")}
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
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {t("connectAll")}
        </button>
        <button
          onClick={() => setPendingBulkAction("disconnect")}
          disabled={filteredTunnels.length === 0}
          className="rounded bg-coral px-3 py-1.5 text-xs font-medium text-on-coral hover:opacity-90 disabled:opacity-50"
        >
          {t("disconnectAll")}
        </button>
        <button
          onClick={() => setFormState({ mode: "add" })}
          data-tour="add"
          className="ml-auto rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t("addTunnel")}
        </button>
      </div>

      <div data-tour="list" className="relative flex min-h-0 flex-1 flex-col">
        {showSearch && (
          <div className="search-drop-in absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              placeholder={t("searchPlaceholder")}
              data-tour="search"
              className="w-48 rounded border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              onClick={() => {
                setShowSearch(false);
                setSearch("");
              }}
              aria-label={t("closeSearch")}
              className="rounded p-1 text-muted hover:bg-surface-hover hover:text-text"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2 2L14 14M14 2L2 14"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        )}
        <TunnelList
          tunnels={filteredTunnels}
          statuses={statuses}
          stats={stats}
          throughput={throughput}
          suggestedForwardPort={suggestPort(tunnels, settings)}
          onToggle={handleToggle}
          onEdit={(tunnel) => setFormState({ mode: "edit", tunnel })}
          onClone={(tunnel) => setFormState({ mode: "clone", tunnel })}
          onDelete={setPendingDelete}
          onRefresh={refresh}
          onError={(text) => setMessage({ text, isError: true })}
          onReorder={handleReorder}
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

      {showRouter && (
        <RouterPanel
          tunnels={tunnels}
          runtime={router}
          onClose={() => setShowRouter(false)}
        />
      )}
      {showCapture && <CapturePanel runtime={router} onClose={() => setShowCapture(false)} />}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSettingsChange={setSettings}
          onOpenConfig={() => setShowConfig(true)}
          onOpenHosts={() => setShowKnownHosts(true)}
        />
      )}
      {showConfig && (
        <ConfigPanel
          tunnels={tunnels}
          onClose={() => setShowConfig(false)}
          onImported={() => {
            void refresh();
            getSettings().then(setSettings);
          }}
        />
      )}
      {showKnownHosts && <KnownHostsPanel onClose={() => setShowKnownHosts(false)} />}
      {/* Below the tour overlay's z-index so it is dimmed along with everything
          else while the tour runs. */}
      {!showTour && (
        <button
          onClick={() => setShowTour(true)}
          title={t("showGuidedTour")}
          aria-label={t("showGuidedTour")}
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
          title={t("deleteTunnelTitle")}
          message={t("deleteTunnelMessage", { name: pendingDelete.name })}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingBulkAction && (
        <ConfirmDialog
          title={pendingBulkAction === "connect" ? t("connectAllTitle") : t("disconnectAllTitle")}
          message={
            pendingBulkAction === "connect"
              ? t("connectAllMessage")
              : t("disconnectAllMessage")
          }
          confirmLabel={pendingBulkAction === "connect" ? t("connectAll") : t("disconnectAll")}
          tone={pendingBulkAction === "connect" ? "accent" : "danger"}
          onConfirm={confirmBulkAction}
          onCancel={() => setPendingBulkAction(null)}
        />
      )}
    </main>
  );
}

export default App;
