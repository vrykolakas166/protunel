import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Matches `.drawer-panel-out` in index.css. */
const EXIT_MS = 160;

interface Props {
  title: ReactNode;
  onClose: () => void;
  /** Panel width in px (capped at 92vw). */
  width?: number;
  children: ReactNode;
}

// A sheet that slides in from the right edge. Unlike Modal it does not dim the
// window or grow it to fit: it exists for settings whose effect you want to
// watch on the rest of the window (theme preview), so the backdrop stays
// clear and only catches the click that dismisses it.
export function Drawer({ title, onClose, width = 380, children }: Props) {
  const { t } = useTranslation("common");
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);

  const close = useCallback(() => {
    if (timer.current !== null) return;
    setClosing(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = window.setTimeout(onClose, reduced ? 0 : EXIT_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="fixed inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside
        role="dialog"
        aria-modal="true"
        className={`${closing ? "drawer-panel-out" : "drawer-panel"} absolute inset-y-0 right-0 flex flex-col border-l border-border bg-surface shadow-2xl`}
        style={{ width: `min(92vw, ${width}px)` }}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border pl-5 pr-3 py-3">
          <div className="min-w-0 flex-1 pt-1">{title}</div>
          <button
            onClick={close}
            aria-label={t("close")}
            className="shrink-0 rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}
