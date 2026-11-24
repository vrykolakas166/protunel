import { useTranslation } from "react-i18next";
import type { Tunnel } from "../../types";
import { ConfigFlow } from "../ConfigFlow";
import { Group, Row } from "./parts";

export function BackupPage({
  tunnels,
  simple,
  inBackupFlow,
  onBackupFlow,
  onImported,
  onOpenHosts,
}: {
  tunnels: Tunnel[];
  simple: boolean;
  inBackupFlow: boolean;
  onBackupFlow: (inFlow: boolean) => void;
  onImported: () => void;
  onOpenHosts: () => void;
}) {
  const { t } = useTranslation("settingsPanel");
  return (
    <>
      <div data-tour="settings-config">
        <ConfigFlow tunnels={tunnels} onImported={onImported} onBusyChange={onBackupFlow} />
      </div>
      {!inBackupFlow && !simple && (
        <Group title={t("groups.security")} tour="settings-hosts">
          <Row
            title={t("knownHostsTitle")}
            description={t("knownHostsHint")}
            control={
              <button
                onClick={onOpenHosts}
                className="shrink-0 rounded border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:bg-surface-hover"
              >
                {t("manageKnownHosts")}
              </button>
            }
          />
        </Group>
      )}
    </>
  );
}
