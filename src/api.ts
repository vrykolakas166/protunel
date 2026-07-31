import { invoke } from "@tauri-apps/api/core";
import type { Tunnel, TunnelInput } from "./types";

export const listTunnels = () => invoke<Tunnel[]>("list_tunnels");

export const addTunnel = (input: TunnelInput, secret?: string) =>
  invoke<Tunnel>("add_tunnel", { input, secret });

export const updateTunnel = (id: string, input: TunnelInput, secret?: string) =>
  invoke<Tunnel>("update_tunnel", { id, input, secret });

export const deleteTunnel = (id: string) => invoke<void>("delete_tunnel", { id });

export const connectTunnel = (id: string) => invoke<void>("connect_tunnel", { id });

export const disconnectTunnel = (id: string) => invoke<void>("disconnect_tunnel", { id });

export const confirmHostKey = (requestId: string) =>
  invoke<void>("confirm_host_key", { requestId });

export const rejectHostKey = (requestId: string) =>
  invoke<void>("reject_host_key", { requestId });
