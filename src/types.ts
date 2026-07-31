export type AuthMethod =
  | { kind: "password" }
  | { kind: "privateKey"; path: string }
  | { kind: "agent" };

export interface Tunnel {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  localSocksPort: number;
  autoConnect: boolean;
}

export interface TunnelInput {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  localSocksPort: number;
  autoConnect: boolean;
}

export type TunnelStatus = "disconnected" | "connecting" | "connected" | "error";

export interface StatusEvent {
  tunnelId: string;
  status: TunnelStatus;
  message: string | null;
}

export interface HostKeyPending {
  requestId: string;
  tunnelId: string;
  host: string;
  port: number;
  fingerprint: string;
  algorithm: string;
}
