import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";

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
  danger: "bg-coral text-on-coral hover:opacity-90",
  accent: "bg-accent text-on-accent hover:bg-accent-hover",
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation("common");
  return (
    <Modal
      title={<h2 className="font-display text-base font-semibold text-text">{title}</h2>}
      onClose={onCancel}
      size="sm"
      borderClassName={TONE_BORDER[tone]}
    >
      <p className="text-sm text-muted">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
        >
          {t("cancel")}
        </button>
        <button
          onClick={onConfirm}
          className={`rounded px-3 py-1.5 text-sm font-medium ${TONE_BUTTON[tone]}`}
        >
          {confirmLabel ?? t("delete")}
        </button>
      </div>
    </Modal>
  );
}
