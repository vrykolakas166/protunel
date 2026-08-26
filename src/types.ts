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

export type TunnelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

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

export type RuleKind = "hostWildcard" | "hostRegex" | "ipCidr" | "all";

export type RuleAction = "tunnel" | "direct" | "block";

export interface RouterRule {
  id: string;
  position: number;
  enabled: boolean;
  kind: RuleKind;
  pattern: string;
  port: number | null;
  action: RuleAction;
  targetTunnelId: string | null;
}

export interface RouterRuleInput {
  enabled: boolean;
  kind: RuleKind;
  pattern: string;
  port: number | null;
  action: RuleAction;
  targetTunnelId: string | null;
}

export interface RouterConfig {
  enabled: boolean;
  port: number;
  defaultAction: RuleAction;
  defaultTunnelId: string | null;
  setSystemProxy: boolean;
  bypassList: string;
  resolveForIpRules: boolean;
}

export interface RouterSnapshot {
  running: boolean;
  port: number | null;
  pacUrl: string | null;
  compileErrors: string[];
}

export interface RoutingDecision {
  at: number;
  host: string;
  port: number;
  ruleId: string | null;
  action: RuleAction;
  targetTunnelId: string | null;
  outcome: string;
}

export type RouterStatus = "stopped" | "running" | "error";

export interface RouterStatusEvent {
  status: RouterStatus;
  port: number | null;
  message: string | null;
}

export interface RouterStats {
  bytesUp: number;
  bytesDown: number;
  activeConnections: number;
}

export type TunnelDisposition = "new" | "overwrite" | "nameConflict";

export interface TunnelPreview {
  id: string;
  name: string;
  host: string;
  disposition: TunnelDisposition;
}

export interface ImportPreview {
  appVersion: string;
  exportedAt: number;
  tunnels: TunnelPreview[];
  routerRuleCount: number;
  currentRouterRuleCount: number;
  knownHostCount: number;
  hasSecrets: boolean;
  secretsUnlocked: boolean;
  secretCount: number;
}

export interface ImportSections {
  tunnels: boolean;
  router: boolean;
  settings: boolean;
  knownHosts: boolean;
  secrets: boolean;
  overwriteNameConflicts: boolean;
}

export interface ImportResult {
  tunnelsAdded: number;
  tunnelsUpdated: number;
  rulesReplaced: number;
  secretsRestored: number;
  knownHostsAdded: number;
}

export interface CapturedProcess {
  id: string;
  pid: number;
  exePath: string;
  label: string | null;
  startedAt: number;
}

export interface LaunchCaptureInput {
  exePath: string;
  args: string[];
  label: string | null;
}

export interface RecentCapture {
  exePath: string;
  args: string[];
  label: string | null;
  lastLaunchedAt: number;
}

export interface CaptureConnection {
  at: number;
  captureId: string;
  pid: number;
  host: string;
  port: number;
  action: RuleAction;
  outcome: string;
}

export interface Settings {
  theme: ThemePreference;
  autostartEnabled: boolean;
  portRangeMin: number;
  portRangeMax: number;
  notificationsEnabled: boolean;
  autoReconnectEnabled: boolean;
  keepaliveIntervalSecs: number;
  reconnectMaxAttempts: number;
  tourCompleted: boolean;
}
