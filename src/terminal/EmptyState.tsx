import { useTranslation } from "react-i18next";
import type { Workspace } from "../types";
import { icons } from "./PaneLayer";

const SHORTCUTS = [
  ["Ctrl+Shift+K", "kbSearch"],
  ["Ctrl+Shift+S", "kbSidebar"],
  ["Ctrl+Tab", "kbNextTab"],
  ["Ctrl+1…9", "kbGotoTab"],
  ["Ctrl+Shift+D", "kbSplitRight"],
  ["Ctrl+Shift+E", "kbSplitDown"],
  ["Alt+←↑↓→", "kbFocusPane"],
  ["Ctrl+Shift+Z", "kbZoom"],
  ["Ctrl+Shift+B", "kbBroadcast"],
  ["Ctrl+Shift+G", "kbTile"],
  ["Ctrl+Shift+W", "kbClosePane"],
  ["Ctrl+Shift+O", "kbFiles"],
  ["Ctrl+Shift+C", "kbCopy"],
  ["Ctrl+Shift+V", "kbPaste"],
] as const;

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border bg-surface px-1 py-px font-mono text-[10px] text-text">
      {children}
    </kbd>
  );
}

interface Props {
  hostCount: number;
  lastSession: Workspace | null;
  lastSessionTarget: string | null;
  namedWorkspaces: Workspace[];
  workspacePanes: (workspace: Workspace) => number;
  openWorkspace: (workspace: Workspace) => void;
  onAddHost: () => void;
  onShowTour: () => void;
}

/** What the pane area shows with no tab open: restore, workspaces, shortcuts. */
export function EmptyState({
  hostCount,
  lastSession,
  lastSessionTarget,
  namedWorkspaces,
  workspacePanes,
  openWorkspace,
  onAddHost,
  onShowTour,
}: Props) {
  const { t } = useTranslation("terminal");
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
      <div data-tour="term-empty" className="max-w-sm text-center">
        <svg
          className="mx-auto mb-3 text-accent"
          width="28"
          height="28"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1" />
          <path
            d="M4 6L6 8L4 10M8 10.5H11.5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <h2 className="font-display text-base font-semibold">{t("emptyTitle")}</h2>
        <p className="mt-1 text-sm text-muted">
          {hostCount === 0 ? t("emptyNoHosts") : t("emptyBody")}
        </p>
        {hostCount === 0 ? (
          <button
            onClick={onAddHost}
            className="mt-4 rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            {t("newHost")}
          </button>
        ) : (
          <>
          {(lastSession || namedWorkspaces.length > 0) && (
            <div className="mx-auto mt-4 flex max-w-xs flex-wrap justify-center gap-1.5">
              {lastSession && workspacePanes(lastSession) > 0 && (
                <button
                  onClick={() => openWorkspace(lastSession)}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:bg-accent-hover"
                >
                  {icons.restore}
                  {lastSessionTarget
                    ? t("workspace.restoreOne", { target: lastSessionTarget })
                    : t("workspace.restore", { count: workspacePanes(lastSession) })}
                </button>
              )}
              {namedWorkspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => openWorkspace(workspace)}
                  disabled={workspacePanes(workspace) === 0}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  {icons.workspace}
                  {workspace.name}
                </button>
              ))}
            </div>
          )}
          <ul className="mx-auto mt-4 grid w-fit grid-cols-[auto_auto] items-center gap-x-3 gap-y-1 text-[11px] text-muted [@media(max-height:520px)]:hidden">
            {SHORTCUTS.map(([keys, label]) => (
              <li key={keys} className="contents">
                <span className="text-right">
                  <Kbd>{keys}</Kbd>
                </span>
                <span className="text-left">{t(label)}</span>
              </li>
            ))}
          </ul>
          {/* The tour's only home here: rarely wanted again, so no
              toolbar button (Settings › About in the main window too). */}
          <button
            onClick={onShowTour}
            className="mt-3 text-[11px] text-muted underline decoration-border underline-offset-2 hover:text-text"
          >
            {t("showGuidedTour")}
          </button>
          </>
        )}
      </div>
    </div>
  );
}
