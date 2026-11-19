import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { HostKeyMismatch } from "../types";
import { Modal } from "./Modal";

interface Props {
  mismatch: HostKeyMismatch;
  tunnelName: string;
  onCancel: () => void;
  /** Forget the trusted key and reconnect; the new key then goes through the usual TOFU prompt. */
  onForget: () => Promise<void>;
}

/**
 * Shown from the tunnel row when a server's host key no longer matches the
 * trusted one. It never trusts the new key itself: forgetting the old one
 * just lets the next connection ask, with the new fingerprint, like the first
 * time — so a man in the middle still needs the user to click "Trust".
 */
export function HostKeyChangedDialog({ mismatch, tunnelName, onCancel, onForget }: Props) {
  const { t } = useTranslation("hostKeyPrompt");
  const { t: tc } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await onForget();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const fingerprint = (label: string, value: string, algorithm: string, tone: string) => (
    <div>
      <p className="text-[11px] font-medium text-muted">{label}</p>
      <p className={`mt-0.5 break-all rounded border bg-bg px-2 py-1.5 font-mono text-[11px] ${tone}`}>
        <span className="text-muted">{algorithm} · </span>
        {value}
      </p>
    </div>
  );

  return (
    <Modal
      dismissible={false}
      size="md"
      borderClassName="border-coral/50"
      title={<h2 className="font-display text-base font-semibold text-coral">{t("changed.title")}</h2>}
      onClose={onCancel}
    >
      <div className="space-y-3 text-sm text-text">
        <p>
          {t("changed.body", {
            name: tunnelName,
            host: mismatch.keyId,
            date: new Date(mismatch.trustedAt * 1000).toLocaleDateString(),
          })}
        </p>
        {fingerprint(t("changed.trusted"), mismatch.knownFingerprint, mismatch.knownAlgorithm, "border-border text-muted")}
        {fingerprint(t("changed.offered"), mismatch.offeredFingerprint, mismatch.offeredAlgorithm, "border-coral/40 text-text")}
        <p className="rounded-lg border border-amber/40 bg-amber/10 p-2.5 text-[11px]">{t("changed.warning")}</p>
        {error && <p className="text-xs text-coral">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {tc("cancel")}
          </button>
          <button
            onClick={() => void forget()}
            disabled={busy}
            className="rounded bg-coral px-3 py-1.5 text-sm font-medium text-on-coral hover:opacity-90 disabled:opacity-50"
          >
            {t("changed.forget")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
