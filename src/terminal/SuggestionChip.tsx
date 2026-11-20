// What the smart terminal shows over the bottom of a pane: the suggestion
// chip and the "use → for the ghost" reminder. Presentational only; the
// behaviour is in `smartSession.ts`.

import { useTranslation } from "react-i18next";
import type { Chip } from "./smartSession";

/**
 * The suggestion over the bottom of a pane. It never takes focus: the shell
 * keeps the keyboard, Alt+Enter puts the command at the prompt (never runs
 * it), any other key dismisses. Only a click on a sequence's Run runs it.
 */
export function SuggestionChip({
  chip,
  onRun,
  onInsert,
  onDismiss,
}: {
  chip: Chip;
  onRun: () => void;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("terminal");
  const button = "shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-surface-hover";
  return (
    <div
      role="status"
      className="search-drop-in absolute inset-x-4 bottom-3 z-10 flex justify-center"
      // Clicking the chip must not move focus off the shell.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex max-w-full items-center gap-2 rounded-lg border border-accent/40 bg-surface/95 py-1 pl-2.5 pr-1 text-[11px] text-text shadow-lg backdrop-blur">
        <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-accent" fill="currentColor" aria-hidden="true">
          <path d="M8 1.8l1.4 3.8 3.8 1.4-3.8 1.4L8 12.2 6.6 8.4 2.8 7l3.8-1.4z" />
        </svg>
        <span className="shrink-0 text-muted">
          {chip.kind === "sequence" ? t("smart.usual") : t(`smart.fix.${chip.fix.reason}`)}
        </span>
        <span className="flex min-w-0 items-center gap-1 overflow-hidden font-mono">
          {(chip.kind === "sequence" ? chip.commands : [chip.fix.command]).map((cmd, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span className="text-muted">→</span>}
              <span className="truncate rounded bg-bg px-1 py-px" title={cmd}>
                {cmd}
              </span>
            </span>
          ))}
        </span>
        <button onClick={onInsert} title={t(chip.kind === "fix" ? "smart.insertHint" : "smart.insertFirstHint")} className={`${button} text-accent`}>
          {t("smart.insert")}
          <kbd className="ml-1 font-mono text-[10px] text-muted">Alt+↵</kbd>
        </button>
        {chip.kind === "sequence" && (
          <button onClick={onRun} title={t("smart.runHint")} className={`${button} text-muted hover:text-text`}>
            {t("smart.run")}
          </button>
        )}
        <button
          onClick={onDismiss}
          title={t("smart.dismiss")}
          aria-label={t("smart.dismiss")}
          className="shrink-0 rounded p-1 text-muted hover:bg-surface-hover hover:text-text"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Two Tabs over a ghost suggestion: Tab is the shell's, → takes the ghost. */
export function TabHint({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("terminal");
  const key = "rounded border border-border bg-bg px-1 font-mono text-[10px]";
  return (
    <div role="status" className="search-drop-in absolute inset-x-4 bottom-3 z-10 flex justify-center">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="flex max-w-full items-center gap-1.5 rounded-lg border border-amber/50 bg-surface/95 px-2.5 py-1 text-[11px] text-text shadow-lg backdrop-blur"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="shrink-0 text-amber" aria-hidden="true">
          <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
          <path d="M4 7h1M7 7h1M10 7h2M5 9.5h6" />
        </svg>
        <span>{t("smart.tabHintBefore")}</span>
        <kbd className={key}>→</kbd>
        <span className="text-muted">{t("smart.tabHintWhole")}</span>
        <kbd className={key}>Ctrl+→</kbd>
        <span className="text-muted">{t("smart.tabHintWord")}</span>
        <span className="truncate text-muted">· {t("smart.tabHintAfter")}</span>
      </button>
    </div>
  );
}
