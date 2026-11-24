import { useEffect, useRef } from "react";
import { strayKeyAction } from "./shortcuts";

/** Text fields of the window's own UI (search, dialogs) — not xterm's hidden input. */
function isTextField(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    el.matches("input, textarea, select, [contenteditable='true']") &&
    !el.classList.contains("xterm-helper-textarea")
  );
}

/**
 * Registers the window shortcut handler once (capture phase). The handler
 * itself is replaced every render, so it always reads the latest state.
 */
export function useShortcutHandler(handler: (e: globalThis.KeyboardEvent) => void) {
  const shortcutRef = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  shortcutRef.current = handler;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Keeps the webview's own keys, clicks and zoom out of the terminal window. */
export function useNativeWindowGuards(refocus: () => void) {
  // A terminal window must behave like a native one: no key or click may
  // reach the webview's own features (reload, find, print, caret browsing,
  // zoom, select-all of the page…).
  useEffect(() => {
    // Clicks on the window's chrome (tab bar, pane headers, sidebar rows,
    // footer) must not pull focus out of the shell, or the next keystrokes
    // land on a button or the page body. Buttons still get their click.
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".xterm, input, textarea, select, label, [role='dialog']")) return;
      // A press on an element's own scrollbar must stay a scrollbar drag.
      // (Only scrollable HTML elements: an SVG icon reports clientWidth 0.)
      const scrollable =
        target instanceof HTMLElement &&
        (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth);
      if (scrollable && (e.offsetX > target.clientWidth || e.offsetY > target.clientHeight)) return;
      e.preventDefault();
    };

    // Bubble phase: xterm has already handled (and cancelled) every key it
    // turns into shell input; see `strayKeyAction` for the rest.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const place = isTextField(target)
        ? "textField"
        : // A dialog's own buttons keep Space/Enter, like the shell keeps its keys.
          target.closest?.(".xterm, [role='dialog']")
          ? "terminal"
          : "other";
      const action = strayKeyAction(e, place);
      if (action === "pass") return;
      e.preventDefault();
      if (action === "refocus") refocus();
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault(); // page zoom
    };
    // Coming back to the window (Alt+Tab, reopening it) resumes typing.
    const onWindowFocus = () => {
      // The browser gives focus back to the file panel by itself.
      if (document.activeElement?.closest("[data-file-panel]")) return;
      refocus();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);
}
