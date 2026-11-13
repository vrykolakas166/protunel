import { invoke, type Channel } from "@tauri-apps/api/core";
import type {
  CaptureConnection,
  CapturedProcess,
  ImportPreview,
  ImportResult,
  ImportSections,
  ExportSections,
  KnownHostEntry,
  LaunchCaptureInput,
  PlatformStatus,
  RecentCapture,
  PortForward,
  PortForwardInput,
  RouterConfig,
  RouterRule,
  RouterRuleInput,
  RouterSnapshot,
  RoutingDecision,
  Settings,
  StatusEvent,
  TerminalExit,
  Tunnel,
  TunnelInput,
} from "./types";

export const listTunnels = () => invoke<Tunnel[]>("list_tunnels");

export const listTunnelStatuses = () => invoke<StatusEvent[]>("list_tunnel_statuses");

export const addTunnel = (input: TunnelInput, secret?: string) =>
  invoke<Tunnel>("add_tunnel", { input, secret });

export const updateTunnel = (id: string, input: TunnelInput, secret?: string) =>
  invoke<Tunnel>("update_tunnel", { id, input, secret });

export const deleteTunnel = (id: string) => invoke<void>("delete_tunnel", { id });

/** Saves the display order of tunnels; ids are the full list, top to bottom. */
export const reorderTunnels = (ids: string[]) => invoke<void>("reorder_tunnels", { ids });

export const addPortForward = (tunnelId: string, input: PortForwardInput) =>
  invoke<PortForward>("add_port_forward", { tunnelId, input });

export const updatePortForward = (id: string, input: PortForwardInput) =>
  invoke<PortForward>("update_port_forward", { id, input });

export const deletePortForward = (id: string) => invoke<void>("delete_port_forward", { id });

export const connectTunnel = (id: string) => invoke<void>("connect_tunnel", { id });

export const disconnectTunnel = (id: string) => invoke<void>("disconnect_tunnel", { id });

export const connectAll = () => invoke<void>("connect_all");

export const disconnectAll = () => invoke<void>("disconnect_all");

export const confirmHostKey = (requestId: string) =>
  invoke<void>("confirm_host_key", { requestId });

export const rejectHostKey = (requestId: string) =>
  invoke<void>("reject_host_key", { requestId });

export const listKnownHosts = () => invoke<KnownHostEntry[]>("list_known_hosts");

export const forgetKnownHost = (keyId: string) => invoke<void>("forget_known_host", { keyId });

export const getSettings = () => invoke<Settings>("get_settings");

export const updateSettings = (settings: Settings) =>
  invoke<Settings>("update_settings", { settings });

export const getRouterConfig = () => invoke<RouterConfig>("get_router_config");

export const updateRouterConfig = (config: RouterConfig) =>
  invoke<RouterConfig>("update_router_config", { config });

export const routerSnapshot = () => invoke<RouterSnapshot>("router_snapshot");

export const listRouterRules = () => invoke<RouterRule[]>("list_router_rules");

export const addRouterRule = (input: RouterRuleInput) =>
  invoke<RouterRule>("add_router_rule", { input });

export const updateRouterRule = (id: string, input: RouterRuleInput) =>
  invoke<RouterRule>("update_router_rule", { id, input });

export const deleteRouterRule = (id: string) => invoke<void>("delete_router_rule", { id });

export const reorderRouterRules = (ids: string[]) =>
  invoke<void>("reorder_router_rules", { ids });

export const listRouterDecisions = () => invoke<RoutingDecision[]>("list_router_decisions");

/** Returns the written path, or null if the save dialog was cancelled. */
export const exportConfig = (passphrase: string | undefined, sections: ExportSections) =>
  invoke<string | null>("export_config", { passphrase: passphrase || null, sections });

export const pickImportFile = () => invoke<string | null>("pick_import_file");

export const previewImport = (path: string, passphrase?: string) =>
  invoke<ImportPreview>("preview_import", { path, passphrase: passphrase || null });

export const applyImport = (path: string, passphrase: string | undefined, sections: ImportSections) =>
  invoke<ImportResult>("apply_import", {
    path,
    passphrase: passphrase || null,
    sections,
  });

export const pickCaptureTarget = () => invoke<string | null>("pick_capture_target");

export const launchCapture = (input: LaunchCaptureInput) =>
  invoke<CapturedProcess>("launch_capture", { input });

export const stopCapture = (id: string) => invoke<void>("stop_capture", { id });

export const listLocalIps = () => invoke<string[]>("list_local_ips");

export const platformStatus = () => invoke<PlatformStatus>("platform_status");

export const listActiveCaptures = () => invoke<CapturedProcess[]>("list_active_captures");

export const listRecentCaptures = () => invoke<RecentCapture[]>("list_recent_captures");

export const listCaptureConnections = () =>
  invoke<CaptureConnection[]>("list_capture_connections");

export const openTerminalWindow = () => invoke<void>("open_terminal_window");

/** Opens a PTY shell on the tunnel's session, connecting the tunnel first if
 * needed. Output arrives on `onOutput` as raw bytes. Resolves to the terminal id. */
export const terminalOpen = (
  tunnelId: string,
  cols: number,
  rows: number,
  onOutput: Channel<ArrayBuffer>,
  onExit: Channel<TerminalExit>,
) => invoke<string>("terminal_open", { tunnelId, cols, rows, onOutput, onExit });

export const terminalWrite = (id: string, data: string) =>
  invoke<void>("terminal_write", { id, data });

/** Broadcast: the same input to several terminals, in order, in one call. */
export const terminalWriteMany = (ids: string[], data: string) =>
  invoke<void>("terminal_write_many", { ids, data });

export const terminalResize = (id: string, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { id, cols, rows });

export const terminalClose = (id: string) => invoke<void>("terminal_close", { id });
