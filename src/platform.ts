/**
 * Process capture (DLL injection) and the system-proxy toggle (WinINET) only
 * exist on Windows. The webview's user agent is enough to tell: WebView2 on
 * Windows, WebKitGTK elsewhere.
 */
export const isWindows = navigator.userAgent.includes("Windows");
