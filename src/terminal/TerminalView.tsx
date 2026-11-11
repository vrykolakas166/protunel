import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { terminalClose, terminalOpen, terminalResize } from "../api";
import type { TerminalExit, Tunnel } from "../types";
import { matchShortcut } from "./shortcuts";
import type { ITheme } from "@xterm/xterm";

export type SessionPhase = "connecting" | "open" | "closed";

export interface SessionInfo {
  phase: SessionPhase;
  cols: number;
  rows: number;
  /** Keystroke → first byte of output back, for the most recent keystroke. */
  echoMs: number | null;
  /** Output bytes over the last second. */
  bytesPerSec: number;
  renderer: "webgl" | "dom";
}

const FONT_FAMILY = '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace';
const FONT_SIZE = 13;

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

interface Props {
  tunnel: Tunnel;
  /** Laid out on screen (its tab is active and it isn't hidden by a zoom). */
  visible: boolean;
  /** The pane that owns the keyboard in its tab. */
  focused: boolean;
  /** xterm colours of the active app theme. */
  theme: ITheme;
  /** Bumped by the window to hand keyboard focus back to the focused pane. */
  focusSignal: number;
  onInfo: (info: SessionInfo) => void;
  onFocus: () => void;
  /** The backend terminal id once the shell is open, null once it ends. */
  onTerminalId: (id: string | null) => void;
  /** Delivers typed input: to this terminal only, or fanned out by broadcast. */
  send: (data: string, ownId: string) => void;
  /** Lets the window veto a paste, e.g. multi-line text about to be broadcast. */
  confirmPaste: (text: string) => Promise<boolean>;
}

/**
 * One xterm instance bound to one remote shell. Stays mounted while hidden so
 * scrollback survives tab switches and layout changes; `visible` decides who
 * fits, `focused` who takes the keyboard.
 */
export function TerminalView({
  tunnel,
  visible,
  focused,
  theme,
  focusSignal,
  onInfo,
  onFocus,
  onTerminalId,
  send,
  confirmPaste,
}: Props) {
  const { t } = useTranslation("terminal");
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Everything the xterm callbacks read lives in refs: those callbacks are
  // registered once, at mount, and must not see stale props.
  const tunnelRef = useRef(tunnel);
  tunnelRef.current = tunnel;
  const tRef = useRef(t);
  tRef.current = t;
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const callbacks = useRef({ onFocus, onTerminalId, send, confirmPaste });
  callbacks.current = { onFocus, onTerminalId, send, confirmPaste };
  // Characters in the last copy, shown briefly as a toast; null when hidden.
  const [copied, setCopied] = useState<number | null>(null);
  const copiedTimer = useRef(0);
  const onCopiedRef = useRef((chars: number) => {
    setCopied(chars);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1400);
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let terminalId: string | null = null;
    let phase: SessionPhase = "connecting";
    let renderer: SessionInfo["renderer"] = "dom";
    let echoMs: number | null = null;
    let keyAt: number | null = null;
    let bytesThisSecond = 0;
    let bytesPerSec = 0;

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowProposedApi: true, // required by the unicode11 addon
      theme: themeRef.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));
    termRef.current = term;
    fitRef.current = fit;

    const report = () =>
      onInfoRef.current({
        phase,
        cols: term.cols,
        rows: term.rows,
        echoMs,
        bytesPerSec,
        renderer,
      });

    const fitIfVisible = () => {
      // A hidden tab measures 0×0; fitting it would shrink the remote PTY.
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
    };

    const copy = (text: string) => {
      writeText(text)
        .then(() => onCopiedRef.current(text.length))
        .catch(() => {});
    };
    const copySelection = () => {
      const text = term.getSelection();
      if (!text) return false;
      copy(text);
      term.clearSelection();
      return true;
    };
    const paste = async () => {
      try {
        const text = await readText();
        if (text && (await callbacks.current.confirmPaste(text))) term.paste(text);
      } catch {
        // Empty or non-text clipboard: nothing to paste.
      }
    };
    const setTerminalId = (id: string | null) => {
      terminalId = id;
      callbacks.current.onTerminalId(id);
    };

    const connect = async () => {
      if (disposed) return;
      phase = "connecting";
      report();
      const { username, host, port } = tunnelRef.current;
      term.write(dim(tRef.current("connecting", { target: `${username}@${host}:${port}` })) + "\r\n");

      // Per-attempt flag: the exit channel can fire before `terminalOpen`
      // resolves when the shell dies immediately.
      let ended = false;
      const output = new Channel<ArrayBuffer>();
      output.onmessage = (buffer) => {
        const bytes = new Uint8Array(buffer);
        bytesThisSecond += bytes.length;
        if (keyAt !== null) {
          echoMs = performance.now() - keyAt;
          keyAt = null;
        }
        term.write(bytes);
      };
      const exit = new Channel<TerminalExit>();
      exit.onmessage = ({ exitStatus, message }) => {
        ended = true;
        setTerminalId(null);
        phase = "closed";
        keyAt = null;
        const detail =
          message ?? (exitStatus !== null ? tRef.current("exitCode", { code: exitStatus }) : null);
        term.write(
          "\r\n" +
            dim(`── ${tRef.current("sessionEnded")}${detail ? ` (${detail})` : ""} ──`) +
            "\r\n" +
            dim(tRef.current("pressEnterReconnect")) +
            "\r\n",
        );
        report();
      };

      try {
        const id = await terminalOpen(tunnelRef.current.id, term.cols, term.rows, output, exit);
        if (disposed) {
          void terminalClose(id);
          return;
        }
        if (ended) return;
        setTerminalId(id);
        phase = "open";
      } catch (err) {
        phase = "closed";
        term.write(red(String(err)) + "\r\n" + dim(tRef.current("pressEnterRetry")) + "\r\n");
      }
      report();
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (matchShortcut(e)) return false; // the window handles these
      const key = e.key.toLowerCase();
      // Ctrl+C is always SIGINT, selection or not. Copy is Ctrl+Shift+C (or
      // just selecting); paste is Ctrl+Shift+V (or right-click).
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === "c") {
        e.preventDefault(); // Ctrl+Shift+C is WebView2's inspect-element shortcut
        copySelection();
        return false;
      }
      if (e.ctrlKey && !e.altKey && key === "v") {
        // Both must stop the browser's native paste. Plain Ctrl+V belongs to
        // the shell (readline's quoted-insert), so it is sent as ^V.
        e.preventDefault();
        if (e.shiftKey) void paste();
        else term.input("\x16", true);
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (phase === "open" && terminalId) {
        if (keyAt === null) keyAt = performance.now();
        callbacks.current.send(data, terminalId);
      } else if (phase === "closed" && data.includes("\r")) {
        term.write("\r\n");
        void connect();
      }
    });

    // Dragging a divider refits every frame; the server only needs the size
    // the drag settles on.
    let resizeTimer = 0;
    term.onResize(({ cols, rows }) => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (terminalId) terminalResize(terminalId, cols, rows).catch(() => {});
      }, 60);
      report();
    });

    // PuTTY conventions: releasing a selection copies it, right-click pastes.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0 && term.hasSelection()) copy(term.getSelection());
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void paste();
    };
    const onFocusIn = () => callbacks.current.onFocus();
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("focusin", onFocusIn);

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitIfVisible);
    });

    const ticker = window.setInterval(() => {
      bytesPerSec = bytesThisSecond;
      bytesThisSecond = 0;
      report();
    }, 1000);

    // The WebGL renderer measures glyphs once; measuring before the bundled
    // font has loaded would lock in the fallback font's cell size.
    void document.fonts.load(`${FONT_SIZE}px "IBM Plex Mono"`).finally(() => {
      if (disposed) return;
      term.open(container);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          renderer = "dom";
          report();
        });
        term.loadAddon(webgl);
        renderer = "webgl";
      } catch {
        renderer = "dom";
      }
      fitIfVisible();
      observer.observe(container);
      if (focusedRef.current) term.focus();
      void connect();
    });

    return () => {
      disposed = true;
      window.clearTimeout(copiedTimer.current);
      cancelAnimationFrame(frame);
      window.clearInterval(ticker);
      observer.disconnect();
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("focusin", onFocusIn);
      window.clearTimeout(resizeTimer);
      if (terminalId) void terminalClose(terminalId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && container.clientWidth > 0) fitRef.current?.fit();
      if (focused) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, focused, focusSignal]);

  return (
    <div
      className="relative h-full w-full px-3 pb-1 pt-2"
      style={{ background: theme.background }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {copied !== null && (
        <div
          role="status"
          className="search-drop-in pointer-events-none absolute right-4 top-3 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text shadow-lg"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-accent">
            <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("copied", { count: copied })}
        </div>
      )}
    </div>
  );
}
