import { useState, type ReactNode, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";

interface Props {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** A line under the field for the current value (e.g. "merges into …"). */
  hint?: (value: string) => ReactNode;
  /** Whether the value can be submitted (blank never can). */
  valid?: (value: string) => boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/** One text field and a confirm button: renames and the like. */
export function PromptDialog({ title, label, initial = "", confirmLabel, hint, valid, onConfirm, onCancel }: Props) {
  const { t } = useTranslation("common");
  const [value, setValue] = useState(initial);
  const ok = value.trim() !== "" && (valid?.(value) ?? true);
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (ok) onConfirm(value.trim());
  };
  return (
    <Modal
      title={<h2 className="font-display text-base font-semibold text-text">{title}</h2>}
      onClose={onCancel}
      size="sm"
      dismissible={false}
    >
      <form onSubmit={submit}>
        <label className="block text-xs font-medium text-muted">
          {label}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        {hint && <p className="mt-1.5 min-h-4 text-[11px] text-muted">{hint(value)}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={!ok}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
