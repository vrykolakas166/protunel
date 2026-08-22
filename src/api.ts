import { invoke } from "@tauri-apps/api/core";
import type {
  ImportPreview,
  ImportResult,
  ImportSections,
  KnownHostEntry,
  PortForward,
  PortForwardInput,
  RouterConfig,
  RouterRule,
  RouterRuleInput,
  RouterSnapshot,
  RoutingDecision,
  Settings,
  StatusEvent,
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
export const exportConfig = (passphrase?: string) =>
  invoke<string | null>("export_config", { passphrase: passphrase || null });

export const pickImportFile = () => invoke<string | null>("pick_import_file");

export const previewImport = (path: string, passphrase?: string) =>
  invoke<ImportPreview>("preview_import", { path, passphrase: passphrase || null });

export const applyImport = (path: string, passphrase: string | undefined, sections: ImportSections) =>
  invoke<ImportResult>("apply_import", {
    path,
    passphrase: passphrase || null,
    sections,
  });
