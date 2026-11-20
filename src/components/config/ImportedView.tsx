// What an import changed.

import { useTranslation } from "react-i18next";
import type { ImportResult } from "../../types";
import { primaryButton, Callout, Stat, CheckIcon } from "./parts";

export function ImportedView({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const { t } = useTranslation("configPanel");
  return (
        <div className="flex flex-col items-center gap-4 py-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
            <CheckIcon size={24} />
          </span>
          <p className="text-sm font-medium text-text">{t("result.done")}</p>
          <div className="grid w-full grid-cols-5 gap-2">
            <Stat value={result.tunnelsAdded} label={t("result.added")} />
            <Stat value={result.tunnelsUpdated} label={t("result.updated")} />
            <Stat value={result.rulesReplaced} label={t("result.rules")} />
            <Stat value={result.secretsRestored} label={t("result.secrets")} />
            <Stat value={result.knownHostsAdded} label={t("result.hosts")} />
          </div>
          {result.secretsRestored === 0 && result.tunnelsAdded + result.tunnelsUpdated > 0 && (
            <div className="w-full">
              <Callout tone="amber">{t("result.noSecretsReminder")}</Callout>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className={primaryButton}>
              {t("result.close")}
            </button>
          </div>
        </div>
  );
}
