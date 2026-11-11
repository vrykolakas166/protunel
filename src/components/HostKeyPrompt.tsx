import { Trans, useTranslation } from "react-i18next";
import type { HostKeyPending } from "../types";
import { confirmHostKey, rejectHostKey } from "../api";
import { Modal } from "./Modal";

interface Props {
  request: HostKeyPending;
  onResolved: (requestId: string) => void;
}

export function HostKeyPrompt({ request, onResolved }: Props) {
  const { t } = useTranslation("hostKeyPrompt");
  const accept = async () => {
    await confirmHostKey(request.requestId);
    onResolved(request.requestId);
  };

  const reject = async () => {
    await rejectHostKey(request.requestId);
    onResolved(request.requestId);
  };

  return (
    <Modal
      dismissible={false}
      title={<h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>}
      onClose={reject}
      size="md"
      borderClassName="border-amber/40"
    >
      <p className="text-sm text-muted">
        <Trans
          t={t}
          i18nKey="body"
          values={{ host: request.host, port: request.port, algorithm: request.algorithm }}
          components={{
            host: <span className="font-mono text-text" />,
          }}
        />
      </p>
      <p className="mt-3 break-all rounded border border-border bg-bg p-2 font-mono text-xs text-text">
        {request.fingerprint}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={reject}
          className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
        >
          {t("reject")}
        </button>
        <button
          onClick={accept}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t("trustAndConnect")}
        </button>
      </div>
    </Modal>
  );
}
