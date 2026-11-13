import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPlatformStatus, isWindows } from "../platform";
import type { PlatformStatus, Tunnel } from "../types";
import { CopyLine } from "./CopyLine";

interface Props {
  tunnels: Tunnel[];
}

type Problem = "vault" | "agent";

const DISMISS_KEY = "protunel.setupNotice.dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string) {
  try {
    localStorage.setItem(DISMISS_KEY, value);
  } catch {
    // Not persisted; the notice just comes back next launch.
  }
}

/** Fix commands per problem. The agent fix uses gcr's socket-activated agent,
 * which ships with gnome-keyring, so one install covers both problems.
 * Hyprland also needs the variables exported from `hyprland.conf`, since no
 * desktop session does it for the apps it launches. */
function fixLines(problem: Problem, status: PlatformStatus, hyprland: boolean): string[] {
  if (problem === "vault") {
    const lines = status.installCommand ? [`${status.installCommand} gnome-keyring`] : [];
    if (hyprland) lines.push("exec-once = gnome-keyring-daemon --start --components=secrets");
    return lines;
  }
  const lines = ["systemctl --user enable --now gcr-ssh-agent.socket"];
  if (hyprland) lines.push("env = SSH_AUTH_SOCK,$XDG_RUNTIME_DIR/gcr/ssh");
  return lines;
}

/**
 * Linux only: names the OS services this app needs that are missing on this
 * session, with the commands that fix them. A minimal compositor setup lacks
 * both often enough that failing later — mid-connect, with a raw D-Bus error —
 * is the worse experience. The agent is only flagged when a tunnel uses it.
 * Dismissal is remembered per problem set, so a new problem shows again.
 */
export function SetupNotice({ tunnels }: Props) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (isWindows) return;
    getPlatformStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  const usesAgent = tunnels.some((tun) => tun.auth.kind === "agent");
  const problems: Problem[] = [];
  if (!status.vaultAvailable) problems.push("vault");
  if (usesAgent && !status.sshAgentAvailable) problems.push("agent");

  const key = problems.join(",");
  if (problems.length === 0 || dismissed === key) return null;

  const hyprland = status.desktop.includes("hyprland");

  return (
    <div className="space-y-2 border-b border-border bg-coral/10 px-4 py-2 text-xs text-text">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-coral">{t("setup.title")}</p>
        <button
          onClick={() => {
            writeDismissed(key);
            setDismissed(key);
          }}
          className="shrink-0 text-muted hover:text-text"
        >
          {t("setup.dismiss")}
        </button>
      </div>
      {problems.map((problem) => (
        <div key={problem} className="space-y-1">
          <p>{t(`setup.${problem}`)}</p>
          {fixLines(problem, status, hyprland).map((line) => (
            <CopyLine key={line} text={line} />
          ))}
        </div>
      ))}
      {hyprland && <p className="text-muted">{t("setup.hyprlandNote")}</p>}
    </div>
  );
}
