import { platformStatus } from "./api";
import type { PlatformStatus } from "./types";

/**
 * Process capture (DLL injection) and the system-proxy toggle (WinINET) only
 * exist on Windows. The webview's user agent is enough to tell: WebView2 on
 * Windows, WebKitGTK elsewhere.
 */
export const isWindows = navigator.userAgent.includes("Windows");

let statusPromise: Promise<PlatformStatus> | null = null;

/** Fetched once per app run: the probe talks D-Bus, and nothing it reports
 * (session env, installed services) changes without a re-login anyway. */
export function getPlatformStatus(): Promise<PlatformStatus> {
  statusPromise ??= platformStatus();
  return statusPromise;
}
