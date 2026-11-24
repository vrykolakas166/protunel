import { useTranslation } from "react-i18next";
import { Group, Row, Switch, type NumberControlFn, type PageProps } from "./parts";

export function TunnelsPage({
  settings,
  save,
  busy,
  numberControl,
}: PageProps & { numberControl: NumberControlFn }) {
  const { t } = useTranslation("settingsPanel");
  return (
    <>
      <Group title={t("groups.reconnect")} tour="settings-reconnect">
        <Row
          title={t("autoReconnect")}
          description={t("autoReconnectHint")}
          control={
            <Switch
              label={t("autoReconnect")}
              checked={settings.autoReconnectEnabled}
              disabled={busy}
              onChange={(on) => save({ ...settings, autoReconnectEnabled: on })}
            />
          }
        />
        <Row
          title={t("keepaliveLabel")}
          description={t("keepaliveTooltip")}
          control={numberControl("keepaliveIntervalSecs", t("keepaliveTooltip"))}
        />
        <Row
          title={t("retriesLabel")}
          description={t("retriesTooltip")}
          control={numberControl("reconnectMaxAttempts", t("retriesTooltip"))}
        />
      </Group>
      <Group title={t("groups.newTunnels")}>
        <Row
          title={t("portRange")}
          description={t("portRangeHint")}
          control={
            <div className="flex items-center gap-1.5">
              {numberControl("portRangeMin", t("portMinTooltip"))}
              <span className="text-muted">–</span>
              {numberControl("portRangeMax", t("portMaxTooltip"))}
            </div>
          }
        />
      </Group>
    </>
  );
}
