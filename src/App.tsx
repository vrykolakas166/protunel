import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { AddTunnelForm } from "./components/AddTunnelForm";
import { CapturePanel } from "./components/CapturePanel";
import { isWindows } from "./platform";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { KnownHostsPanel } from "./components/KnownHostsPanel";
import { LocalIps } from "./components/LocalIps";
import { MessageBar } from "./components/MessageBar";
import { RouterPanel } from "./components/RouterPanel";
import { Sample1 } from "./components/Sample1";
import { LanguageMenu } from "./components/LanguageMenu";
import { PreferencesPanel } from "./components/PreferencesPanel";
import { SettingsIcon, SettingsPanel, type SettingsPage } from "./components/SettingsPanel";
import { useUpdates } from "./hooks/useUpdates";
import { ReleaseNotes } from "./components/ReleaseNotes";
import { Modal } from "./components/Modal";
import { SetupNotice } from "./components/SetupNotice";
import { TourGuide, type TourPanel } from "./components/TourGuide";
import { TunnelList } from "./components/TunnelList";
import { useRouterEvents } from "./hooks/useRouterEvents";
import { useLanguage } from "./hooks/useLanguage";
import { usedLocalPorts } from "./hostRange";
import { useTheme } from "./themes";
import { useTunnelEvents } from "./hooks/useTunnelEvents";
import { hostKeyId, useHostKeyMismatches } from "./hooks/useHostKeyMismatches";
import { HostKeyChangedDialog } from "./components/HostKeyChangedDialog";
import { SimpleHome } from "./components/SimpleHome";
import { ModeChooser } from "./components/ModeChooser";
import { UpdateBanner } from "./components/UpdateBanner";
import { TunnelToolbar } from "./components/TunnelToolbar";
import { openMenu } from "./contextMenu";
import { DevToolsPage } from "./components/DevToolsPage";
import {
  addTunnel,
  addTunnels,
  connectAll,
  connectTunnel,
  debugWhatsNew,
  devToolsEnabled,
  forgetKnownHost,
  installUpdate,
  takeWhatsNew,
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
import type { Settings, Tunnel, TunnelInput, UiMode, WhatsNew } from "./types";

interface Message {
  text: string;
  isError: boolean;
}

type FormState =
  | { mode: "add" }
  | { mode: "edit"; tunnel: Tunnel }
  | { mode: "clone"; tunnel: Tunnel };

/** Statuses that count as "up" for the toolbar: on, or on the way. */
const LIVE = ["connected", "connecting", "reconnecting"];

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
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const { mismatches: hostKeyMismatches, dismiss: dismissMismatch } = useHostKeyMismatches();
  /** Tunnel whose changed host key is being reviewed. */
  const [reviewingKey, setReviewingKey] = useState<Tunnel | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<"connect" | "disconnect" | null>(null);
  const updates = useUpdates();
  /** Restart-to-update waiting on the user (tunnels are about to drop). */
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  /** Release notes of the version this launch just updated to, shown once. */
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);
  /** Settings › Developer tools exists (debug builds, PROTUNEL_DEVTOOLS=1). */
  const [devTools, setDevTools] = useState(false);

  useTheme(settings);
  useLanguage(settings?.language);

  const router = useRouterEvents();

  // Simple mode says what went wrong on the tunnel's row, in plain words;
  // the raw SSH error up top would only alarm.
  const simpleRef = useRef(false);
  simpleRef.current = settings?.uiMode === "simple";
  const { statuses, stats, throughput, hostKeyQueue, dismissHostKey } = useTunnelEvents(
    (_tunnelId, text) => !simpleRef.current && setMessage({ text, isError: true }),
  );

  useEffect(() => {
    listTunnels()
      .then(setTunnels)
      .catch((err) => setMessage({ text: String(err), isError: true }));
    getSettings().then((loaded) => {
      setSettings(loaded);
      // Runs itself once on a fresh install, then never again unless replayed.
      // The tour shows the full app; with no mode chosen yet, the mode
      // question comes first and starts it (see `chooseMode`).
      if (!loaded.tourCompleted && loaded.uiMode === "full") setShowTour(true);
    });
    devToolsEnabled().then(setDevTools).catch(() => {});
    takeWhatsNew()
      .then((notes) => notes && setWhatsNew(notes))
      .catch(() => {});
    // The tray's "Restart to update" lands here so the user can be asked.
    const unlistenRestart = listen("update-restart-requested", () => setConfirmRestart(true));
    // The terminal window can add and edit hosts too.
    const unlisten = listen("tunnels-changed", () => {
      listTunnels().then(setTunnels).catch(() => {});
    });
    // Settings saved anywhere else (the terminal window's mouse chip, an
    // import). Every save sends the whole object, so a stale copy here would
    // put the other window's change back on this window's next save.
    const unlistenSettings = listen<Settings>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenRestart.then((f) => f());
    };
  }, []);

  /** Tunnels that a restart would drop (they come back after it). */
  const liveTunnels = Object.values(statuses).filter((s) => s.status !== "disconnected" && s.status !== "error").length;

  const restartToUpdate = async () => {
    setConfirmRestart(false);
    setRestarting(true);
    try {
      await installUpdate(); // only returns if it failed
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
    setRestarting(false);
  };

  // Nothing running: no reason to ask. Otherwise say what will happen.
  const requestRestart = () => (liveTunnels > 0 ? setConfirmRestart(true) : void restartToUpdate());

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

  const simple = settings?.uiMode === "simple";
  /** No mode picked yet: a fresh install, or the first launch after updating. */
  const askMode = !!settings && settings.uiMode === null;

  const chooseMode = async (mode: UiMode) => {
    if (!settings) return;
    try {
      const saved = await updateSettings({ ...settings, uiMode: mode });
      setSettings(saved);
      if (mode === "full" && !saved.tourCompleted) setShowTour(true);
    } catch (err) {
      setMessage({ text: String(err), isError: true });
    }
  };

  const openSettings = (page: SettingsPage) => {
    setSettingsPage(page);
    setShowSettings(true);
  };

  // The tour drives the modals itself so it can point at things inside them.
  // Everything it opens is closed again when it moves on or ends.
  const showTourPanel = useCallback((panel: TourPanel | null) => {
    setShowRouter(panel === "router");
    setShowCapture(panel === "capture");
    const settingsTarget = panel?.startsWith("settings:") ? (panel.slice(9) as SettingsPage) : null;
    if (settingsTarget) setSettingsPage(settingsTarget);
    setShowSettings(settingsTarget !== null);
    setShowPreferences(panel === "preferences");
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

  // A clone with the secret field left blank reuses the original's secret;
  // the backend copies it vault-to-vault so it never reaches the webview.
  const copySecretFrom = formState?.mode === "clone" ? formState.tunnel.id : undefined;

  const handleSubmit = async (input: TunnelInput, secret?: string) => {
    if (formState?.mode === "edit") {
      await updateTunnel(formState.tunnel.id, input, secret);
    } else {
      await addTunnel(input, secret, copySecretFrom);
    }
    await refresh();
    setFormState(null);
  };

  const handleSubmitMany = async (inputs: TunnelInput[], secret?: string) => {
    try {
      const created = await addTunnels(inputs, secret, copySecretFrom);
      setMessage({ text: t("bulkAdded", { count: created.length }), isError: false });
      setFormState(null);
    } finally {
      await refresh();
    }
  };

  // Nothing until settings load: the window must not flash the full app at
  // someone about to be asked for (or already in) Simple mode.
  if (!settings) return <main className="h-screen bg-bg" />;

  if (askMode) {
    return (
      <main className="flex h-screen flex-col bg-bg text-text">
        <ModeChooser
          settings={settings}
          afterUpdate={tunnels.length > 0}
          onChoose={(mode) => void chooseMode(mode)}
          onSettingsChange={setSettings}
        />
        {/* A resumed tunnel can still need its key confirmed. */}
        {hostKeyQueue[0] && <HostKeyPrompt request={hostKeyQueue[0]} onResolved={dismissHostKey} />}
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <h1 className="sr-only">protunel</h1>
        <Sample1 size={40} className="shrink-0" />
        <LocalIps className="flex-1" />

        <div className="ml-auto flex items-center gap-1.5">
          {!simple && (
            <>
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
              {isWindows && (
                <button
                  onClick={() => setShowCapture(true)}
                  data-tour="capture"
                  title={t("captureTooltip")}
                  className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
                >
                  {t("capture")}
                </button>
              )}
            </>
          )}
          <button
            onClick={() => openSettings("general")}
            data-tour="settings"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            <SettingsIcon name="settings" size={14} />
            {t("settings")}
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          {settings && <LanguageMenu settings={settings} onSettingsChange={setSettings} />}
          {/* At the right edge because the drawer slides out of that edge. The
              swatch is the live accent colour, so it follows a hover preview too. */}
          <button
            onClick={() => setShowPreferences(true)}
            data-tour="preferences"
            title={t("preferencesTooltip")}
            aria-label={t("preferences")}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-muted hover:bg-surface-hover hover:text-text"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.6C4.4 1.6 1.6 4.3 1.6 7.8C1.6 11.3 4.4 14.4 7.6 14.4C8.6 14.4 9 13.8 9 13.1C9 12.3 8.3 12 8.3 11.2C8.3 10.4 8.9 9.9 9.7 9.9H11.2C13 9.9 14.4 8.6 14.4 6.8C14.4 3.9 11.5 1.6 8 1.6Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle cx="5" cy="7.4" r="1" fill="currentColor" />
              <circle cx="7.6" cy="4.8" r="1" fill="currentColor" />
              <circle cx="10.9" cy="5.6" r="1" className="fill-accent" />
            </svg>
          </button>
        </div>
      </header>

      <MessageBar text={message?.text ?? null} isError={message?.isError ?? false} />

      <SetupNotice tunnels={tunnels} />

      <UpdateBanner
        updates={updates}
        restarting={restarting}
        onRestart={requestRestart}
        onWhatsNew={() => openSettings("about")}
      />

      {simple ? (
        <SimpleHome
          tunnels={tunnels}
          statuses={statuses}
          router={router}
          hostKeyMismatches={hostKeyMismatches}
          onImport={() => openSettings("backup")}
          onError={(text) => setMessage({ text, isError: true })}
        />
      ) : (
        <>
          <TunnelToolbar
            // Whole list, not the search result: the bulk actions act on every tunnel.
            total={tunnels.length}
            live={tunnels.filter((tun) => LIVE.includes(statuses[tun.id]?.status ?? "")).length}
            searching={showSearch}
            onConnectAll={() => setPendingBulkAction("connect")}
            onDisconnectAll={() => setPendingBulkAction("disconnect")}
            onSearch={() => {
              if (showSearch) setSearch("");
              setShowSearch(!showSearch);
            }}
            onAdd={() => setFormState({ mode: "add" })}
          />

          <div
            data-tour="list"
            className="relative flex min-h-0 flex-1 flex-col"
            onContextMenu={(e) => {
              // Rows and fields have their own menus; this is the empty space.
              const target = e.target as HTMLElement;
              if (target.closest("[data-tunnel-row], input, textarea, button")) return;
              openMenu(e, [
                { label: t("addTunnel"), action: () => setFormState({ mode: "add" }) },
                { label: t("importConfig"), action: () => openSettings("backup") },
              ]);
            }}
          >
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
              hostKeyMismatches={hostKeyMismatches}
              onReviewHostKey={setReviewingKey}
            />
          </div>
        </>
      )}

      {formState && (
        <AddTunnelForm
          mode={formState.mode}
          initial={formState.mode === "add" ? null : formState.tunnel}
          suggestedPort={suggestPort(tunnels, settings)}
          tunnels={tunnels}
          onSubmit={handleSubmit}
          onSubmitMany={formState.mode === "edit" ? undefined : handleSubmitMany}
          onHostKeyForgotten={dismissMismatch}
          running={
            formState.mode === "edit" &&
            ["connected", "connecting", "reconnecting"].includes(statuses[formState.tunnel.id]?.status ?? "")
          }
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
      {showPreferences && settings && (
        <PreferencesPanel
          settings={settings}
          onClose={() => setShowPreferences(false)}
          onSettingsChange={setSettings}
        />
      )}
      {showSettings && (
        <SettingsPanel
          page={settingsPage}
          updates={updates}
          restarting={restarting}
          onRestartToUpdate={requestRestart}
          tunnels={tunnels}
          onClose={() => setShowSettings(false)}
          onSettingsChange={setSettings}
          onImported={() => {
            void refresh();
            getSettings().then(setSettings);
          }}
          onOpenHosts={() => setShowKnownHosts(true)}
          devTools={
            devTools ? (
              <DevToolsPage
                tunnels={tunnels}
                onError={(text) => setMessage({ text, isError: true })}
                onShowWhatsNew={() => {
                  setShowSettings(false);
                  debugWhatsNew()
                    .then(setWhatsNew)
                    .catch((err) => setMessage({ text: String(err), isError: true }));
                }}
                onAskMode={() => {
                  if (!settings) return;
                  setShowSettings(false);
                  updateSettings({ ...settings, uiMode: null })
                    .then(setSettings)
                    .catch((err) => setMessage({ text: String(err), isError: true }));
                }}
              />
            ) : undefined
          }
        />
      )}
      {confirmRestart && (
        <ConfirmDialog
          title={t("restartTitle", { version: updates?.version ?? "" })}
          message={t("restartMessage", { count: liveTunnels })}
          confirmLabel={t("restartToUpdate")}
          tone="accent"
          onConfirm={() => void restartToUpdate()}
          onCancel={() => setConfirmRestart(false)}
        />
      )}
      {/* Only reached once a mode is chosen, so an update that adds modes asks first. */}
      {whatsNew && (
        <Modal
          size="md"
          title={
            <div>
              <h2 className="font-display text-base font-semibold text-text">
                {t("whatsNewTitle", { version: whatsNew.version })}
              </h2>
              <p className="text-[11px] text-muted">{t("whatsNewHint")}</p>
            </div>
          }
          onClose={() => setWhatsNew(null)}
        >
          {whatsNew.notes ? <ReleaseNotes markdown={whatsNew.notes} /> : <p className="text-sm text-muted">{t("whatsNewEmpty")}</p>}
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => setWhatsNew(null)}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              {t("whatsNewDone")}
            </button>
          </div>
        </Modal>
      )}
      {showKnownHosts && (
        <KnownHostsPanel onClose={() => setShowKnownHosts(false)} onForgotten={dismissMismatch} />
      )}
      {reviewingKey && hostKeyMismatches[hostKeyId(reviewingKey)] && (
        <HostKeyChangedDialog
          mismatch={hostKeyMismatches[hostKeyId(reviewingKey)]}
          tunnelName={reviewingKey.name}
          onCancel={() => setReviewingKey(null)}
          onForget={async () => {
            const keyId = hostKeyId(reviewingKey);
            await forgetKnownHost(keyId);
            dismissMismatch(keyId);
            setReviewingKey(null);
            // The new key now gets the first-connection prompt, fingerprint and all.
            connectTunnel(reviewingKey.id).catch((err) => setMessage({ text: String(err), isError: true }));
          }}
        />
      )}
      {/* Below the tour overlay's z-index so it is dimmed along with everything
          else while the tour runs. */}
      {!showTour && !simple && (
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
