import { GuidedTour, type TourStep } from "../components/GuidedTour";
import { isWindows } from "../platform";

const SEEN_KEY = "protunel.terminalTourSeen";

/** Absent: never shown. "basic": shown with no shell open, so the panes and
 * files part is still to come. "1": all of it seen. */
function seenState(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return "1";
  }
}

export function shouldShowTerminalTour() {
  return seenState() === null;
}

/** The first shell opened after the short tour: offer the rest once. */
export function shouldOfferPanesTour() {
  return seenState() === "basic";
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

export function markTerminalTourSeen(basicOnly = false) {
  try {
    localStorage.setItem(SEEN_KEY, basicOnly ? "basic" : "1");
  } catch {
    // Closing still works when storage is unavailable.
  }
}

type Part = "all" | "panes";

const stepDefinitions: (TourStep & { platform?: "windows" | "linux" })[] = [
  { id: "term-welcome", chapter: "sessions", target: null },
  { id: "term-hosts", chapter: "sessions", target: ["term-hosts", "term-sidebar"], keys: ["Ctrl+Shift+S"] },
  { id: "term-select", chapter: "sessions", target: ["term-select", "term-sidebar"] },
  { id: "term-tabs", chapter: "sessions", target: "term-tabs", keys: ["Ctrl+Shift+D", "Ctrl+Shift+E"] },
  { id: "term-workspaces", chapter: "sessions", target: "term-workspaces" },
  { id: "term-header", chapter: "panes", target: ["term-header", "term-layout"], keys: ["Ctrl+Shift+Z"] },
  { id: "term-layout", chapter: "panes", target: "term-layout", keys: ["Ctrl+Shift+G"] },
  { id: "term-broadcast", chapter: "panes", target: "term-broadcast", keys: ["Ctrl+Shift+B"] },
  { id: "term-files", chapter: "panes", target: ["term-file-panel", "term-files"], keys: ["Ctrl+Shift+O"] },
  { id: "term-files-copy", chapter: "panes", target: ["term-file-panel", "term-files"], platform: "linux" },
  { id: "term-files-copy-win", chapter: "panes", target: ["term-file-panel", "term-files"], platform: "windows" },
  { id: "term-footer", chapter: "panes", target: "term-footer" },
  { id: "term-smart", chapter: "keyboard", target: ["term-header", "term-footer"], keys: ["→", "Ctrl+→", "Alt+Enter"] },
  { id: "term-shortcuts", chapter: "keyboard", target: null, keys: ["Ctrl+Shift+K", "Ctrl+Shift+C", "Ctrl+Shift+V"] },
];

const platformSteps = stepDefinitions.filter(
  ({ platform }) => !platform || platform === (isWindows ? "windows" : "linux"),
);

/** No shell yet: what to do first, then stop; panes and files come later. */
const BASIC = ["term-welcome", "term-hosts", "term-select", "term-next", "term-shortcuts"];
const basicSteps: TourStep[] = BASIC.map(
  (id) => platformSteps.find((step) => step.id === id) ?? { id, chapter: "sessions", target: "term-empty" },
);
const panesSteps = platformSteps.filter((step) => step.chapter !== "sessions");

/** `onFinish(basicOnly)`: true when what ran was the short, no-shell version. */
export function TerminalTour({
  hasTab,
  part,
  onFinish,
}: {
  hasTab: boolean;
  part: Part;
  onFinish: (basicOnly: boolean) => void;
}) {
  const stage = !hasTab ? "basic" : part;
  const steps = stage === "basic" ? basicSteps : stage === "panes" ? panesSteps : platformSteps;
  // Keyed by stage: the tabs can vanish mid-tour (window hidden), and a
  // shorter list must start over rather than keep an index past its end.
  return <GuidedTour key={stage} steps={steps} onFinish={() => onFinish(stage === "basic")} />;
}
