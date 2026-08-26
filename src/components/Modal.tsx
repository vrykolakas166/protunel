import type { ReactNode } from "react";

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<ModalSize, number> = {
  sm: 420,
  md: 520,
  lg: 640,
  xl: 768,
};

interface Props {
  title: ReactNode;
  onClose: () => void;
  size?: ModalSize;
  /** Overrides the panel's default border color, e.g. a danger-toned dialog. */
  borderClassName?: string;
  children: ReactNode;
}

// Shared wrapper for every popup panel: close button is always pinned to the
// same top-right spot regardless of what a panel puts in its header, and
// width scales with the window instead of being capped at a fixed px value.
export function Modal({
  title,
  onClose,
  size = "md",
  borderClassName = "border-border",
  children,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className={`relative flex max-h-full flex-col overflow-y-auto rounded-lg border ${borderClassName} bg-surface p-5 shadow-xl`}
        style={{ width: `min(92vw, ${SIZE_PX[size]}px)` }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1.5 text-muted hover:bg-surface-hover hover:text-text"
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
        <div className="pr-8">{title}</div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
