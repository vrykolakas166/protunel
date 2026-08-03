interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "danger" | "accent";
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_BORDER: Record<"danger" | "accent", string> = {
  danger: "border-coral/40",
  accent: "border-accent/40",
};

const TONE_BUTTON: Record<"danger" | "accent", string> = {
  danger: "bg-coral hover:opacity-90",
  accent: "bg-accent hover:bg-accent-hover",
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  tone = "danger",
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className={`w-full max-w-sm rounded-lg border ${TONE_BORDER[tone]} bg-surface p-5 shadow-xl`}>
        <h2 className="font-display text-base font-semibold text-text">{title}</h2>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded px-3 py-1.5 text-sm font-medium text-white ${TONE_BUTTON[tone]}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
