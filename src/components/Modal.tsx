import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fitWindow, popupClosed, popupOpened } from "../windowFit";

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<ModalSize, number> = {
  sm: 420,
  md: 520,
  lg: 640,
  xl: 768,
};

/** Backdrop padding around the panel (p-4), per side. */
const BACKDROP_PAD = 16;

interface Props {
  title: ReactNode;
  onClose: () => void;
  size?: ModalSize;
  /** Overrides the panel's default border color, e.g. a danger-toned dialog. */
  borderClassName?: string;
  /**
   * Whether a click on the backdrop closes it like the X does. Off for forms,
   * where a stray click would throw away what was typed, and for decisions
   * that must be made on purpose.
   */
  dismissible?: boolean;
  children: ReactNode;
}

// Shared wrapper for every popup panel. The header (title + close button)
// never scrolls away: only the body scrolls. When the window is too small for
// the panel, the window grows to fit it and shrinks back once the last popup
// closes, so panels rarely have to scroll at all.
export function Modal({
  title,
  onClose,
  size = "md",
  borderClassName = "border-border",
  dismissible = true,
  children,
}: Props) {
  const { t } = useTranslation("common");
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);

  useLayoutEffect(() => {
    popupOpened();
    return popupClosed;
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    const body = bodyRef.current;
    if (!panel || !body) return;
    const measure = () => {
      // The panel's height if nothing had to scroll.
      const natural = panel.offsetHeight - body.clientHeight + body.scrollHeight;
      const width = SIZE_PX[size];
      // The panel is min(92vw, size) wide, so the window must be at least
      // size / 0.92 for it to reach full width.
      fitWindow(Math.max(width / 0.92, width + BACKDROP_PAD * 2), natural + BACKDROP_PAD * 2);
    };
    measure();
    // Content can grow while open (an import preview, a validation error).
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [size]);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      // Both press and release must land on the backdrop itself: a text
      // selection dragged out of the panel must not close it.
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (dismissible && pressedOnBackdrop.current && e.target === e.currentTarget) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={`modal-panel flex max-h-full flex-col rounded-lg border ${borderClassName} bg-surface shadow-xl`}
        style={{ width: `min(92vw, ${SIZE_PX[size]}px)` }}
      >
        <div className="flex shrink-0 items-start gap-3 pl-5 pr-3 pt-3">
          <div className="min-w-0 flex-1 pt-2">{title}</div>
          <button
            onClick={onClose}
            aria-label={t("close")}
            className="shrink-0 rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 2L14 14M14 2L2 14"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div ref={bodyRef} className="min-h-0 overflow-y-auto px-5 pb-5 pt-4">
          {children}
        </div>
      </div>
    </div>
  );
}
