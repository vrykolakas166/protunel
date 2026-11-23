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
  /** One-level folder shown as a section (see `groups.ts`); null: ungrouped. */
  group: string | null;
  /** Remote directories offered first when browsing this host's files. */
  bookmarks: string[];
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
  /** One-level folder shown as a section (see `groups.ts`); null: ungrouped. */
  group: string | null;
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

/** A server offered a different key than the trusted one; the connection was refused. */
export interface HostKeyMismatch {
  /** `host:port`, as tunnels are matched against known hosts. */
  keyId: string;
  knownFingerprint: string;
  knownAlgorithm: string;
  trustedAt: number;
  offeredFingerprint: string;
  offeredAlgorithm: string;
}

export interface KnownHostEntry {
  keyId: string;
  fingerprint: string;
  algorithm: string;
  trustedAt: number;
}


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
  /** Set when the tunnel's private-key file does not exist on this machine. */
  missingKeyPath: string | null;
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
  /** The UI mode the file asks for ("simple"), if any. */
  uiMode: UiMode | null;
}

export interface ExportSections {
  tunnels: boolean;
  tunnelIds: string[];
  router: boolean;
  settings: boolean;
  knownHosts: boolean;
  /** The file opens protunel in Simple mode on the importing machine. */
  simpleMode: boolean;
}

export interface ImportSections {
  tunnels: boolean;
  router: boolean;
  settings: boolean;
  knownHosts: boolean;
  secrets: boolean;
  overwriteNameConflicts: boolean;
  /** Apply the file's UI mode. */
  uiMode: boolean;
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
  /** A theme id, or "system" to follow Windows between themeLight and themeDark. */
  theme: string;
  autostartEnabled: boolean;
  portRangeMin: number;
  portRangeMax: number;
  notificationsEnabled: boolean;
  autoReconnectEnabled: boolean;
  keepaliveIntervalSecs: number;
  reconnectMaxAttempts: number;
  tourCompleted: boolean;
  language: string;
  themeLight: string;
  themeDark: string;
  /** Programs on the server may take over the terminal's mouse (tmux, vim, htop). */
  terminalAppMouse: boolean;
  /** Stay in the tray when launched at sign-in. */
  startMinimized: boolean;
  /** GPU (WebGL) terminal rendering; off uses native text rendering. */
  terminalWebgl: boolean;
  /** Download updates in the background as soon as they are found. */
  autoUpdate: boolean;
  /** Null until the user picks (first launch, or first after updating). */
  uiMode: UiMode | null;
  /** Remember commands per host to suggest the usual sequence and error fixes. */
  terminalSuggestions: boolean;
  /** Notify when a command this long ends out of sight; 0 = off. */
  terminalLongCommandSecs: number;
  /** Dim the panes without focus in a tab with several panes. */
  terminalDimInactive: boolean;
}

/** `terminal_memory.json`: learned per host, never exported. */
export interface TerminalMemory {
  /** Keyed by tunnel id. */
  hosts: Record<string, HostMemory>;
  workspaces: Workspace[];
}

export interface HostMemory {
  /** Opening commands of recent shells, oldest first. */
  sessions: string[][];
  /** Command → times run. */
  commands: Record<string, number>;
  /** Suggested sequence key → dismissals in a row. */
  dismissed: Record<string, number>;
}

/** A named set of terminal tabs. `tabs` are layout trees (`LayoutNode`). */
export interface Workspace {
  id: string;
  name: string;
  tabs: unknown[];
}

/** Simple: one "internal network" switch for people who only browse. */
export type UiMode = "simple" | "full";

export type DebugTunnelFailure = "auth" | "unreachable" | "hostKey";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

/** Mirror of `updates::UpdateSnapshot`. */
export interface UpdateSnapshot {
  /** This build updates itself (Windows, AppImage); package installs don't. */
  supported: boolean;
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  /** 0–1 while downloading, when the size is known. */
  progress: number | null;
  error: string | null;
  /** Unix seconds. */
  lastChecked: number | null;
  /** A ready update is applied when protunel quits (AppImage). */
  installsOnExit: boolean;
}

export interface WhatsNew {
  version: string;
  notes: string;
}

export interface TerminalExit {
  /** The remote shell's exit code, when the server reported one. */
  exitStatus: number | null;
  /** Why the terminal ended abnormally (session lost, write failed). */
  message: string | null;
}

export interface PlatformStatus {
  /** `XDG_CURRENT_DESKTOP`, lower-cased ("hyprland", "kde", …); empty on Windows. */
  desktop: string;
  vaultAvailable: boolean;
  sshAgentAvailable: boolean;
  /** e.g. "sudo pacman -S --needed"; empty when the distro is unknown. */
  installCommand: string;
  /** The AppImage or executable path, for an `exec-once` autostart line. */
  launchCommand: string;
  /** False for a package-manager install, which must not self-update. */
  selfUpdate: boolean;
}

// WinSCP import (`winscp.rs`). Never carries a password.
export type WinscpWarning =
  | { kind: "nameHost"; named: string }
  | { kind: "nameUser"; named: string }
  | { kind: "noPassword" }
  | { kind: "passwordUnreadable" }
  | { kind: "keyPathMissing"; path: string }
  | { kind: "bastionCredentialsDiffer" };

export type WinscpRowStatus =
  | { kind: "new" }
  | { kind: "existing"; id: string; name: string; group: string | null }
  | { kind: "unsupported" };

export interface WinscpRow {
  index: number;
  name: string;
  group: string | null;
  target: string;
  remoteDir: string | null;
  status: WinscpRowStatus;
  bastion: number | null;
  warnings: WinscpWarning[];
}

export interface WinscpBastion {
  index: number;
  target: string;
  candidates: { id: string; name: string }[];
  warnings: WinscpWarning[];
}

export interface WinscpPreview {
  token: string;
  fileName: string;
  rows: WinscpRow[];
  bastions: WinscpBastion[];
}

export interface WinscpImportRequest {
  token: string;
  rows: { index: number; action: "add" | "setGroup" }[];
  bastions: { index: number; useTunnel: string | null }[];
}

export interface WinscpOutcome {
  added: number;
  grouped: number;
  bastionsCreated: number;
  failed: { name: string; error: string }[];
  groups: string[];
}
