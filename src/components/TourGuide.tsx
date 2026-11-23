import { useCallback } from "react";
import { isWindows } from "../platform";
import { GuidedTour, type TourStep } from "./GuidedTour";
import type { RouterTab } from "./RouterPanel";
import type { SettingsPage } from "./SettingsPanel";

export type TourPanel = "add" | `router:${RouterTab}` | "capture" | "preferences" | `settings:${SettingsPage}`;

const stepDefinitions: (TourStep & { panel?: TourPanel; platform?: "windows" | "linux" })[] = [
  { id: "welcome", chapter: "basics", target: null, keys: ["F1"] },
  { id: "mode", chapter: "basics", target: "settings-mode", panel: "settings:general" },
  { id: "appearance", chapter: "basics", target: "settings-theme", panel: "preferences" },
  { id: "language", chapter: "basics", target: "language" },
  { id: "linux-setup", chapter: "basics", target: "linux-setup", platform: "linux" },
  { id: "tray", chapter: "basics", target: "settings-startup", panel: "settings:general" },
  { id: "add", chapter: "tunnels", target: "add" },
  { id: "add-auth", chapter: "tunnels", target: "add-auth", panel: "add" },
  { id: "add-socks", chapter: "tunnels", target: "add-socks", panel: "add" },
  { id: "add-jump", chapter: "tunnels", target: "add-jump", panel: "add" },
  { id: "list", chapter: "tunnels", target: "list" },
  { id: "bulk", chapter: "tunnels", target: "bulk", keys: ["Ctrl+F"] },
  { id: "router", chapter: "router", target: "router" },
  { id: "router-enable", chapter: "router", target: "router-enable", panel: "router:rules" },
  { id: "router-rules", chapter: "router", target: "router-rules", panel: "router:rules" },
  { id: "router-log", chapter: "router", target: "router-log", panel: "router:log" },
  { id: "router-settings", chapter: "router", target: "router-settings", panel: "router:settings" },
  { id: "router-proxy", chapter: "router", target: "router-proxy", panel: "router:settings", platform: "windows" },
  { id: "router-pac", chapter: "router", target: "router-pac", panel: "router:settings", platform: "linux" },
  { id: "capture-launch", chapter: "capture", target: "capture-launch", panel: "capture", platform: "windows" },
  { id: "capture-monitor", chapter: "capture", target: "capture-active", panel: "capture", platform: "windows" },
  { id: "terminal", chapter: "terminal", target: "terminal" },
  { id: "settings", chapter: "settings", target: "settings" },
  { id: "settings-reconnect", chapter: "settings", target: "settings-reconnect", panel: "settings:tunnels" },
  { id: "settings-terminal", chapter: "settings", target: "settings-smart", panel: "settings:terminal" },
  { id: "settings-config", chapter: "settings", target: "settings-config", panel: "settings:backup" },
  { id: "settings-hosts", chapter: "settings", target: "settings-hosts", panel: "settings:backup" },
  { id: "settings-about", chapter: "settings", target: "settings-updates", panel: "settings:about" },
];
const steps = stepDefinitions.filter(({ platform }) => !platform || platform === (isWindows ? "windows" : "linux"));

interface Props {
  onFinish: () => void;
  onRequestPanel: (panel: TourPanel | null) => void;
}

export function TourGuide({ onFinish, onRequestPanel }: Props) {
  const showStep = useCallback((index: number) => onRequestPanel(steps[index].panel ?? null), [onRequestPanel]);
  return <GuidedTour steps={steps} onShowStep={showStep} onFinish={() => {
    onRequestPanel(null);
    onFinish();
  }} />;
}
