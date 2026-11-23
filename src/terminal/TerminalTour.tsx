import { GuidedTour, type TourStep } from "../components/GuidedTour";

const SEEN_KEY = "protunel.terminalTourSeen";

export function shouldShowTerminalTour() {
  try {
    return localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

/**
 * Asks the terminal window to show its tour (Settings › About). Both windows
 * share localStorage: clearing the flag makes a fresh window show it, and the
 * `storage` event tells a live (hidden) one, see `onTerminalTourRequest`.
 */
export function requestTerminalTour() {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // Without storage the request can't cross windows; nothing to do.
  }
}

/** Calls `show` when the other window asks for the tour. Returns the unsubscribe. */
export function onTerminalTourRequest(show: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SEEN_KEY && e.newValue === null) show();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function markTerminalTourSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Closing still works when storage is unavailable.
  }
}

const steps: TourStep[] = [
  { id: "term-hosts", chapter: "sessions", target: ["term-hosts", "term-sidebar"], keys: ["Ctrl+Shift+S"] },
  { id: "term-select", chapter: "sessions", target: ["term-select", "term-sidebar"] },
  { id: "term-tabs", chapter: "sessions", target: "term-tabs", keys: ["Ctrl+Shift+D", "Ctrl+Shift+E"] },
  { id: "term-workspaces", chapter: "sessions", target: "term-workspaces" },
  { id: "term-header", chapter: "panes", target: ["term-header", "term-empty", "term-layout"], keys: ["Ctrl+Shift+Z"] },
  { id: "term-layout", chapter: "panes", target: "term-layout", keys: ["Ctrl+Shift+G"] },
  { id: "term-broadcast", chapter: "panes", target: "term-broadcast", keys: ["Ctrl+Shift+B"] },
  { id: "term-footer", chapter: "panes", target: "term-footer" },
  { id: "term-smart", chapter: "keyboard", target: ["term-header", "term-empty", "term-footer"], keys: ["→"] },
  { id: "term-shortcuts", chapter: "keyboard", target: null, keys: ["Ctrl+Shift+K", "Ctrl+Shift+C", "Ctrl+Shift+V"] },
];

const emptySteps = steps.map((step) => step.chapter === "panes" ? { ...step, target: "term-empty" } : step);

export function TerminalTour({ hasTab, onFinish }: { hasTab: boolean; onFinish: () => void }) {
  return <GuidedTour steps={hasTab ? steps : emptySteps} onFinish={onFinish} />;
}
