import { useTranslation } from "react-i18next";
import { clearTerminalCommands } from "../../api";
import { Group, Row, Switch, type NumberControlFn, type PageProps } from "./parts";

export function TerminalPage({
  settings,
  save,
  busy,
  numberControl,
  forgotten,
  onForgotten,
}: PageProps & {
  numberControl: NumberControlFn;
  /** Kept by the panel so it survives switching pages. */
  forgotten: boolean;
  onForgotten: () => void;
}) {
  const { t } = useTranslation("settingsPanel");
  return (
    <>
      <Group title={t("groups.mouse")}>
        <Row
          title={t("terminalAppMouse")}
          description={t("terminalAppMouseHint")}
          control={
            <Switch
              label={t("terminalAppMouse")}
              checked={settings.terminalAppMouse}
              disabled={busy}
              onChange={(on) => save({ ...settings, terminalAppMouse: on })}
            />
          }
        />
      </Group>
      <Group title={t("groups.rendering")}>
        <Row
          title={t("terminalWebgl")}
          description={t("terminalWebglHint")}
          control={
            <Switch
              label={t("terminalWebgl")}
              checked={settings.terminalWebgl}
              disabled={busy}
              onChange={(on) => save({ ...settings, terminalWebgl: on })}
            />
          }
        />
        <Row
          title={t("terminalDimInactive")}
          description={t("terminalDimInactiveHint")}
          control={
            <Switch
              label={t("terminalDimInactive")}
              checked={settings.terminalDimInactive}
              disabled={busy}
              onChange={(on) => save({ ...settings, terminalDimInactive: on })}
            />
          }
        />
      </Group>
      <Group title={t("groups.smart")} tour="settings-smart">
        <Row
          title={t("terminalSuggestions")}
          description={t("terminalSuggestionsHint")}
          control={
            <Switch
              label={t("terminalSuggestions")}
              checked={settings.terminalSuggestions}
              disabled={busy}
              onChange={(on) => save({ ...settings, terminalSuggestions: on })}
            />
          }
        />
        <Row
          title={t("terminalLongCommand")}
          description={t("terminalLongCommandHint")}
          control={numberControl("terminalLongCommandSecs", t("terminalLongCommandHint"))}
        />
        <Row
          title={t("terminalForget")}
          description={t("terminalForgetHint")}
          control={
            <button
              onClick={() => void clearTerminalCommands().then(onForgotten)}
              disabled={forgotten}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text hover:border-coral hover:text-coral disabled:pointer-events-none disabled:opacity-50"
            >
              {forgotten ? t("terminalForgotten") : t("terminalForgetButton")}
            </button>
          }
        />
      </Group>
    </>
  );
}
