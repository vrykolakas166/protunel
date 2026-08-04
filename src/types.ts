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
  forwards: PortForward[];
  jumpTunnelId: string | null;
  socksEnabled: boolean;
}

export interface PortForward {
  id: string;
  tunnelId: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

export interface PortForwardInput {
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

export interface TunnelInput {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  localSocksPort: number;
  autoConnect: boolean;
  jumpTunnelId: string | null;
  socksEnabled: boolean;
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

export interface TunnelStats {
  tunnelId: string;
  bytesUp: number;
  bytesDown: number;
  uptimeSecs: number;
}

export interface KnownHostEntry {
  keyId: string;
  fingerprint: string;
  algorithm: string;
  trustedAt: number;
}

export type ThemePreference = "system" | "light" | "dark";

export interface Settings {
  theme: ThemePreference;
  autostartEnabled: boolean;
  portRangeMin: number;
  portRangeMax: number;
  notificationsEnabled: boolean;
}
