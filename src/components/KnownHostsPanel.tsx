import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { forgetKnownHost, listKnownHosts } from "../api";
import type { KnownHostEntry } from "../types";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
}

export function KnownHostsPanel({ onClose }: Props) {
  const { t } = useTranslation("knownHostsPanel");
  const { t: tc } = useTranslation("common");
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setEntries(await listKnownHosts());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const forget = async (keyId: string) => {
    await forgetKnownHost(keyId);
    await refresh();
  };

  return (
    <Modal
      title={
        <h2 className="flex items-center gap-1.5 font-display text-base font-semibold text-text">
          {t("title")}
          <span
            title={t("tooltip")}
            className="flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-normal text-muted"
          >
            i
          </span>
        </h2>
      }
      onClose={onClose}
      size="lg"
    >
      <p className="text-xs text-muted">{t("description")}</p>

      <div className="mt-4 max-h-96 overflow-y-auto">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">{tc("loading")}</p>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t("emptyState")}</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.keyId} className="rounded border border-border bg-bg p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-text">{entry.keyId}</span>
                  <button
                    onClick={() => forget(entry.keyId)}
                    className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-coral hover:bg-coral/10"
                  >
                    {t("forget")}
                  </button>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted">
                  {entry.algorithm} · {entry.fingerprint}
                </p>
                <p className="text-[11px] text-muted">
                  {t("trustedAt", { date: new Date(entry.trustedAt * 1000).toLocaleString() })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
