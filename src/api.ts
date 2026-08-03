import { invoke } from "@tauri-apps/api/core";
import type { KnownHostEntry, PortForward, PortForwardInput, Settings, Tunnel, TunnelInput } from "./types";

export const listTunnels = () => invoke<Tunnel[]>("list_tunnels");

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
