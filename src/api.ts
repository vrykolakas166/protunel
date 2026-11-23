import { invoke, type Channel } from "@tauri-apps/api/core";
import type {
  CaptureConnection,
  CapturedProcess,
  ImportPreview,
  ImportResult,
  ImportSections,
  ExportSections,
  FileContent,
  FileCount,
  FileListing,
  FileProperties,
  FileTransfer,
  CopyAcross,
  PasteOutcome,
  SavedFile,
  HostKeyMismatch,
  UpdateSnapshot,
  WhatsNew,
  DebugTunnelFailure,
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
  TerminalMemory,
  Tunnel,
  TunnelInput,
  WinscpImportRequest,
  WinscpOutcome,
  WinscpPreview,
} from "./types";

export const listTunnels = () => invoke<Tunnel[]>("list_tunnels");

export const listTunnelStatuses = () => invoke<StatusEvent[]>("list_tunnel_statuses");

/** `copySecretFrom`: when no secret is typed, reuse that tunnel's (clone). */
export const addTunnel = (input: TunnelInput, secret?: string, copySecretFrom?: string) =>
  invoke<Tunnel>("add_tunnel", { input, secret, copySecretFrom });

/** Several tunnels sharing one secret (an address range in the add form). */
export const addTunnels = (inputs: TunnelInput[], secret?: string, copySecretFrom?: string) =>
  invoke<Tunnel[]>("add_tunnels", { inputs, secret, copySecretFrom });

export const updateTunnel = (id: string, input: TunnelInput, secret?: string) =>
  invoke<Tunnel>("update_tunnel", { id, input, secret });

export const deleteTunnel = (id: string) => invoke<void>("delete_tunnel", { id });

/** Saves the display order of tunnels; ids are the full list, top to bottom. */
export const reorderTunnels = (ids: string[]) => invoke<void>("reorder_tunnels", { ids });
/** Files hosts under `group`; null or blank ungroups them. */
export const setTunnelsGroup = (ids: string[], group: string | null) =>
  invoke<void>("set_tunnels_group", { ids, group });

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

export const listHostKeyMismatches = () => invoke<HostKeyMismatch[]>("list_host_key_mismatches");

export const updateStatus = () => invoke<UpdateSnapshot>("update_status");
export const checkForUpdates = () => invoke<UpdateSnapshot>("check_for_updates");
export const downloadUpdate = () => invoke<UpdateSnapshot>("download_update");
/** Installs the downloaded update and restarts; resolves only on failure. */
export const installUpdate = () => invoke<void>("install_update");
/** Release notes of the version just installed, once. */
export const takeWhatsNew = () => invoke<WhatsNew | null>("take_whats_new");

/** Simple mode's switch: router + system proxy + routed tunnels, or all off. */
export const setNetworkAccess = (on: boolean) => invoke<void>("set_network_access", { on });

export const devToolsEnabled = () => invoke<boolean>("dev_tools_enabled");
export const debugSimulateUpdate = (step: "available" | "error" | "reset") =>
  invoke<UpdateSnapshot>("debug_simulate_update", { step });
export const debugWhatsNew = () => invoke<WhatsNew>("debug_whats_new");
export const debugFailTunnel = (id: string, kind: DebugTunnelFailure) =>
  invoke<void>("debug_fail_tunnel", { id, kind });

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

/** Opens the file dialog (Rust side) and previews a WinSCP.ini; null when cancelled. */
export const winscpPreview = () => invoke<WinscpPreview | null>("winscp_preview");
export const winscpCancel = (token: string) => invoke<void>("winscp_cancel", { token });
export const winscpImport = (request: WinscpImportRequest) => invoke<WinscpOutcome>("winscp_import", { request });

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

export const getTerminalMemory = () => invoke<TerminalMemory>("get_terminal_memory");

export const saveTerminalMemory = (memory: TerminalMemory) =>
  invoke<void>("save_terminal_memory", { memory });

/** Forgets every remembered command; workspaces stay. */
export const clearTerminalCommands = () => invoke<void>("clear_terminal_commands");

/** Desktop notification (respects the notifications setting). */
export const terminalNotify = (title: string, body: string) =>
  invoke<void>("terminal_notify", { title, body });

/** Broadcast: the same input to several terminals, in order, in one call. */
export const terminalWriteMany = (ids: string[], data: string) =>
  invoke<void>("terminal_write_many", { ids, data });

export const terminalResize = (id: string, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { id, cols, rows });

export const terminalClose = (id: string) => invoke<void>("terminal_close", { id });

/** Tells Rust whether an editor holds unsaved changes (the close button then asks the page). */
export const terminalSetUnsaved = (unsaved: boolean) => invoke<void>("terminal_set_unsaved", { unsaved });

/** Hides the terminal window and closes its shells, after the page asked about unsaved edits. */
export const terminalWindowHide = () => invoke<void>("terminal_window_hide");

// File panel: SFTP on the pane's tunnel session. Errors that the UI
// translates are bare codes: "not-connected", "no-such-file",
// "permission-denied", "exists", "conflict", "timeout", "too-large".
export const filesHome = (tunnelId: string) => invoke<string>("files_home", { tunnelId });
export const filesList = (tunnelId: string, path: string) => invoke<FileListing>("files_list", { tunnelId, path });
export const filesProperties = (tunnelId: string, path: string) =>
  invoke<FileProperties>("files_properties", { tunnelId, path });
export const filesDirSize = (tunnelId: string, path: string) => invoke<number>("files_dir_size", { tunnelId, path });
export const filesCreate = (tunnelId: string, path: string, dir: boolean) =>
  invoke<void>("files_create", { tunnelId, path, dir });
export const filesRename = (tunnelId: string, from: string, to: string) =>
  invoke<void>("files_rename", { tunnelId, from, to });
export const filesCount = (tunnelId: string, paths: string[]) => invoke<FileCount>("files_count", { tunnelId, paths });
export const filesDelete = (tunnelId: string, paths: string[]) => invoke<void>("files_delete", { tunnelId, paths });
export const filesPaste = (tunnelId: string, sources: string[], destDir: string, cut: boolean) =>
  invoke<PasteOutcome>("files_paste", { tunnelId, sources, destDir, cut });
export const filesCopyAcross = (
  fromTunnelId: string,
  sources: string[],
  toTunnelId: string,
  destDir: string,
  overwrite: boolean,
) => invoke<CopyAcross>("files_copy_across", { fromTunnelId, sources, toTunnelId, destDir, overwrite });
export const filesReadText = (tunnelId: string, path: string, tail: boolean) =>
  invoke<FileContent>("files_read_text", { tunnelId, path, tail });
export const filesReadImage = (tunnelId: string, path: string) =>
  invoke<ArrayBuffer>("files_read_image", { tunnelId, path });
export const filesWriteText = (
  tunnelId: string,
  path: string,
  text: string,
  expectSize: number,
  expectMtime: number | null,
  force: boolean,
) => invoke<SavedFile>("files_write_text", { tunnelId, path, text, expectSize, expectMtime, force });
export const filesUpload = (tunnelId: string, localPaths: string[], remoteDir: string, overwrite: boolean) =>
  invoke<string[]>("files_upload", { tunnelId, localPaths, remoteDir, overwrite });
export const filesPickUpload = (tunnelId: string, remoteDir: string) =>
  invoke<string[]>("files_pick_upload", { tunnelId, remoteDir });
export const filesDownload = (tunnelId: string, remotePaths: string[]) =>
  invoke<string[]>("files_download", { tunnelId, remotePaths });
/** Windows only: an OS drag of remote rows to Explorer (OLE virtual files); elsewhere "unsupported". */
export const filesDragOut = (tunnelId: string, paths: string[]) => invoke<void>("files_drag_out", { tunnelId, paths });
export const filesPickDownload = (tunnelId: string, remotePaths: string[]) =>
  invoke<string[]>("files_pick_download", { tunnelId, remotePaths });
export const filesOpenLocal = (tunnelId: string, remotePath: string) =>
  invoke<string>("files_open_local", { tunnelId, remotePath });
export const filesTransfers = () => invoke<FileTransfer[]>("files_transfers");
export const filesCancelTransfer = (id: string) => invoke<void>("files_cancel_transfer", { id });
export const filesClearTransfers = () => invoke<void>("files_clear_transfers");
export const filesReveal = (id: string) => invoke<void>("files_reveal", { id });
export const filesSaveDraft = (name: string, text: string) => invoke<string | null>("files_save_draft", { name, text });
