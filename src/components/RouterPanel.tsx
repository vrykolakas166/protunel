import { useEffect, useMemo, useState, type SubmitEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  addRouterRule,
  deleteRouterRule,
  getRouterConfig,
  listRouterDecisions,
  listRouterRules,
  reorderRouterRules,
  updateRouterConfig,
  updateRouterRule,
} from "../api";
import { formatBytes, formatTimestamp } from "../format";
import type {
  RouterConfig,
  RouterRule,
  RouterRuleInput,
  RoutingDecision,
  RuleAction,
  RuleKind,
  Tunnel,
} from "../types";
import type { RouterRuntimeState } from "../hooks/useRouterEvents";
import { Modal } from "./Modal";
import { Group, Row, Switch } from "./SettingsPanel";
import { isWindows } from "../platform";
import { LinuxProxyHelp } from "./LinuxProxyHelp";
import { openMenu } from "../contextMenu";

/** Width left to the caller: `w-full` here would beat a `w-24` added later. */
const inputBase =
  "rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const inputClass = `w-full ${inputBase}`;
const selectBase =
  "rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const ghostButton =
  "rounded px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40";

// Kind order used to populate the rule-kind <select>; labels come from
// t(`ruleKind.${kind}`) so they stay translated.
const RULE_KINDS: RuleKind[] = ["hostWildcard", "hostRegex", "ipCidr", "all"];

// Pattern examples are regex/glob syntax, not language text — left untranslated.
// Only the "all" case ("matches everything") is prose and goes through t().
const KIND_PATTERN_EXAMPLE: Partial<Record<RuleKind, string>> = {
  hostWildcard: "*.example.com",
  hostRegex: "\\.corp\\.net$",
  ipCidr: "10.0.0.0/8",
};

/** The action as a chip: where a match goes reads at a glance. */
const ACTION_CHIP: Record<RuleAction, string> = {
  tunnel: "bg-accent/12 text-accent",
  direct: "bg-slate/15 text-muted",
  block: "bg-coral/12 text-coral",
};

const badge = "whitespace-nowrap rounded bg-surface-hover px-1.5 py-px font-sans text-[10px] text-muted";

const iconButton =
  "rounded p-1 text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-30";

function ActionChip({ action, target }: { action: RuleAction; target: string | null }) {
  const { t } = useTranslation("routerPanel");
  return (
    // min-w-0 + break-all: a tunnel name with no spaces wraps inside the row
    // instead of pushing it wider than the window.
    <span className={`min-w-0 max-w-full break-all rounded px-1.5 py-px font-sans text-[11px] font-medium ${ACTION_CHIP[action]}`}>
      {t(`ruleAction.${action}`)}
      {target && <span className="font-normal"> · {target}</span>}
    </span>
  );
}

const Chevron = ({ up }: { up?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
  </svg>
);

const EMPTY_RULE: RouterRuleInput = {
  enabled: true,
  kind: "hostWildcard",
  pattern: "",
  port: null,
  action: "tunnel",
  targetTunnelId: null,
};

export type RouterTab = "rules" | "log" | "settings";

interface Props {
  tunnels: Tunnel[];
  runtime: RouterRuntimeState;
  /** The tab to show; the tour moves it as it walks the panel. */
  tab?: RouterTab;
  onClose: () => void;
}

/**
 * Two-choice-or-more control drawn as one pill (default action, rule kind,
 * rule action): every option visible, the current one obvious.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap rounded-md border border-border bg-bg p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            value === option.value ? "bg-accent text-on-accent shadow-sm" : "text-muted hover:text-text"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function RouterPanel({ tunnels, runtime, tab: requestedTab = "rules", onClose }: Props) {
  const { t } = useTranslation("routerPanel");
  const { t: tc } = useTranslation("common");
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [rules, setRules] = useState<RouterRule[]>([]);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [editing, setEditing] = useState<RouterRule | null>(null);
  const [draft, setDraft] = useState<RouterRuleInput>(EMPTY_RULE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<RouterTab>(requestedTab);
  useEffect(() => setTab(requestedTab), [requestedTab]);

  const tunnelName = useMemo(() => {
    const byId = new Map(tunnels.map((tun) => [tun.id, tun.name]));
    return (id: string | null) => (id ? (byId.get(id) ?? t("deletedTunnel")) : "—");
  }, [tunnels, t]);

  const refreshRules = async () => setRules(await listRouterRules());

  useEffect(() => {
    getRouterConfig().then(setConfig).catch((e) => setError(String(e)));
    refreshRules().catch((e) => setError(String(e)));
  }, []);

  // The decision log only grows while traffic flows, so poll it while the panel
  // is open rather than pushing an event per proxied connection.
  useEffect(() => {
    const load = () => listRouterDecisions().then(setDecisions).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);

  const saveConfig = async (next: RouterConfig) => {
    setBusy(true);
    setError(null);
    const previous = config;
    setConfig(next);
    try {
      setConfig(await updateRouterConfig(next));
    } catch (e) {
      setError(String(e));
      setConfig(previous);
    } finally {
      setBusy(false);
    }
  };

  const submitRule = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: RouterRuleInput = {
        ...draft,
        pattern: draft.kind === "all" ? "" : draft.pattern.trim(),
        targetTunnelId: draft.action === "tunnel" ? draft.targetTunnelId : null,
      };
      if (editing) await updateRouterRule(editing.id, input);
      else await addRouterRule(input);
      await refreshRules();
      setDraft(EMPTY_RULE);
      setEditing(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const mutateRule = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refreshRules();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toRuleInput = (rule: RouterRule): RouterRuleInput => ({
    enabled: rule.enabled,
    kind: rule.kind,
    pattern: rule.pattern,
    port: rule.port,
    action: rule.action,
    targetTunnelId: rule.targetTunnelId,
  });

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRules(next);
    void mutateRule(() => reorderRouterRules(next.map((r) => r.id)));
  };

  const copyAddress = async () => {
    if (!config) return;
    await writeText(`127.0.0.1:${config.port}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!config) return null;

  const running = runtime.status === "running";
  const off = !config.enabled;
  const actions: { value: RuleAction; label: string }[] = [
    { value: "tunnel", label: t("ruleAction.tunnel") },
    { value: "direct", label: t("ruleAction.direct") },
    { value: "block", label: t("ruleAction.block") },
  ];
  const tunnelSelect = (value: string | null, onChange: (id: string | null) => void, disabled?: boolean) => (
    <select
      className={`${selectBase} min-w-40 max-w-full`}
      value={value ?? ""}
      required
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{t("ruleForm.tunnelPlaceholder")}</option>
      {tunnels.map((tun) => (
        <option key={tun.id} value={tun.id}>
          {tun.name}
        </option>
      ))}
    </select>
  );
  const tabs: { id: RouterTab; label: string; count?: number }[] = [
    { id: "rules", label: t("tabs.rules"), count: rules.length },
    { id: "log", label: t("tabs.log"), count: decisions.length || undefined },
    { id: "settings", label: t("tabs.settings") },
  ];

  return (
    <Modal
      dismissible={false}
      title={<h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>}
      onClose={onClose}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {/* Status card: on/off, where to point apps, and live traffic. */}
        <div
          data-tour="router-enable"
          className={`relative overflow-hidden rounded-xl border bg-surface shadow-sm ${
            running ? "border-accent/35" : "border-border"
          }`}
        >
          {running && (
            <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-accent/14 via-accent/4 to-transparent" aria-hidden="true" />
          )}
          <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3">
            <div className="flex items-center gap-3">
              <Switch
                label={t("runRouter")}
                checked={config.enabled}
                disabled={busy}
                onChange={(on) => saveConfig({ ...config, enabled: on })}
              />
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
                  <span className={`h-2 w-2 rounded-full ${running ? "bg-accent" : "bg-slate"}`} />
                  {running ? t("status.on") : t("status.off")}
                </p>
                <p className="text-[11px] text-muted">{running ? t("status.onHint") : t("status.offHint")}</p>
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {running && runtime.stats && (
                <span className="font-mono text-[11px] text-muted">
                  {t("stats", {
                    up: formatBytes(runtime.stats.bytesUp),
                    down: formatBytes(runtime.stats.bytesDown),
                    count: runtime.stats.activeConnections,
                  })}
                </span>
              )}
              <button
                onClick={copyAddress}
                title={t("copyAddressTitle")}
                className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-text hover:border-accent hover:text-accent"
              >
                127.0.0.1:{runtime.port ?? config.port}
                <span className="font-sans text-[11px] text-muted">{copied ? t("copied") : t("copy")}</span>
              </button>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-coral">{error}</p>}
        {runtime.message && <p className="text-xs text-amber">{runtime.message}</p>}
        {runtime.compileErrors.length > 0 && (
          <div className="rounded border border-coral/40 bg-coral/10 p-2 text-[11px] text-coral">
            {runtime.compileErrors.map((e) => (
              <p key={e}>{t("ruleIgnored", { error: e })}</p>
            ))}
          </div>
        )}

        <div role="tablist" aria-label={t("title")} className="flex gap-1 border-b border-border">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === item.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {item.label}
              {item.count !== undefined && (
                <span className="rounded-full bg-surface-hover px-1.5 font-mono text-[10px] text-muted">{item.count}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "rules" && (
          <div data-tour="router-rules" className="space-y-3">
            <RuleTable
              rules={rules}
              busy={busy}
              tunnelName={tunnelName}
              onMove={move}
              onToggle={(rule) =>
                mutateRule(() => updateRouterRule(rule.id, { ...toRuleInput(rule), enabled: !rule.enabled }))
              }
              onEdit={(rule) => {
                setEditing(rule);
                setDraft(toRuleInput(rule));
              }}
              onDelete={(rule) => mutateRule(() => deleteRouterRule(rule.id))}
            />

            {/* Where everything the rules don't match goes, said under them. */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted">
              <span>{t("defaultActionLabel")}</span>
              <ActionChip
                action={config.defaultAction}
                target={config.defaultAction === "tunnel" ? tunnelName(config.defaultTunnelId) : null}
              />
              <button onClick={() => setTab("settings")} className={`${ghostButton} ml-auto`}>
                {t("changeDefault")}
              </button>
            </div>

            <form onSubmit={submitRule} className="space-y-3 rounded-lg border border-border bg-bg/50 p-3">
              <p className="text-sm font-semibold text-text">{editing ? t("ruleForm.editTitle") : t("ruleForm.addTitle")}</p>
              <div className="space-y-1.5">
                <label className={labelClass}>{t("ruleForm.matchLabel")}</label>
                <Segmented
                  label={t("ruleForm.matchLabel")}
                  value={draft.kind}
                  options={RULE_KINDS.map((kind) => ({ value: kind, label: t(`ruleKind.${kind}`) }))}
                  onChange={(kind) => setDraft({ ...draft, kind })}
                />
                <div className="flex flex-wrap gap-1.5">
                  <input
                    className={`${inputBase} min-w-40 flex-1`}
                    value={draft.pattern}
                    aria-label={t("ruleForm.patternLabel")}
                    placeholder={
                      draft.kind === "all" ? t("ruleKindPlaceholder.all") : (KIND_PATTERN_EXAMPLE[draft.kind] ?? "")
                    }
                    disabled={draft.kind === "all"}
                    required={draft.kind !== "all"}
                    onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                  />
                  <input
                    type="number"
                    className={`${inputBase} w-28`}
                    value={draft.port ?? ""}
                    aria-label={t("ruleForm.anyPortPlaceholder")}
                    placeholder={t("ruleForm.anyPortPlaceholder")}
                    onChange={(e) => setDraft({ ...draft, port: e.target.value ? Number(e.target.value) : null })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className={labelClass}>{t("ruleForm.sendLabel")}</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Segmented
                    label={t("ruleForm.sendLabel")}
                    value={draft.action}
                    options={actions}
                    onChange={(action) => setDraft({ ...draft, action })}
                  />
                  {draft.action === "tunnel" &&
                    tunnelSelect(draft.targetTunnelId, (id) => setDraft({ ...draft, targetTunnelId: id }))}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                {editing && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setDraft(EMPTY_RULE);
                    }}
                    className="rounded px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-text"
                  >
                    {tc("cancel")}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50"
                >
                  {editing ? tc("save") : t("ruleForm.add")}
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === "log" && (
          <div data-tour="router-log">
            <DecisionLog decisions={decisions} tunnelName={tunnelName} />
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-4">
            <details className="group rounded-lg border border-border bg-bg/50 text-xs">
              <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 font-medium text-muted hover:text-text">
                <span className="transition-transform group-open:rotate-90">▸</span>
                {t("about")}
              </summary>
              <p className="px-3 pb-3 text-muted">
                <Trans t={t} i18nKey="description" components={{ code: <code className="font-mono text-text" /> }} />
              </p>
            </details>

            <Group title={t("groups.router")} tour="router-settings">
              <Row
                title={t("listenPortLabel")}
                disabled={off}
                control={
                  <input
                    type="number"
                    className={`${inputBase} w-24`}
                    value={config.port}
                    disabled={busy || off}
                    onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                    onBlur={() => saveConfig(config)}
                  />
                }
              />
              <Row title={t("defaultActionLabel")} disabled={off}>
                <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${off ? "opacity-50" : ""}`}>
                  <Segmented
                    label={t("defaultActionLabel")}
                    value={config.defaultAction}
                    options={actions}
                    disabled={busy || off}
                    onChange={(defaultAction) => saveConfig({ ...config, defaultAction })}
                  />
                  {config.defaultAction === "tunnel" &&
                    tunnelSelect(
                      config.defaultTunnelId,
                      (id) => saveConfig({ ...config, defaultTunnelId: id }),
                      busy || off,
                    )}
                </div>
              </Row>
              <Row
                title={t("resolveForIpRules")}
                disabled={off}
                control={
                  <Switch
                    label={t("resolveForIpRules")}
                    checked={config.resolveForIpRules}
                    disabled={busy || off}
                    onChange={(on) => saveConfig({ ...config, resolveForIpRules: on })}
                  />
                }
              />
            </Group>

            {isWindows ? (
              <Group title={t("groups.systemProxy")} tour="router-proxy">
                <Row
                  title={t("setSystemProxy")}
                  description={
                    <Trans t={t} i18nKey="pacDescription" components={{ code: <code className="font-mono" /> }} />
                  }
                  disabled={off}
                  control={
                    <Switch
                      label={t("setSystemProxy")}
                      checked={config.setSystemProxy}
                      disabled={busy || off}
                      onChange={(on) => saveConfig({ ...config, setSystemProxy: on })}
                    />
                  }
                />
                {config.setSystemProxy && (
                  <Row title={t("bypassListLabel")} disabled={off} indent>
                    <input
                      className={`${inputClass} mt-2`}
                      value={config.bypassList}
                      disabled={busy || off}
                      onChange={(e) => setConfig({ ...config, bypassList: e.target.value })}
                      onBlur={() => saveConfig(config)}
                    />
                    {runtime.pacUrl && (
                      <p className="mt-1.5 text-[11px] text-muted">
                        <Trans
                          t={t}
                          i18nKey="pacServing"
                          values={{ url: runtime.pacUrl }}
                          components={{ code: <code className="font-mono text-text" /> }}
                        />
                      </p>
                    )}
                  </Row>
                )}
              </Group>
            ) : (
              <LinuxProxyHelp port={config.port} />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function RuleTable({
  rules,
  busy,
  tunnelName,
  onMove,
  onToggle,
  onEdit,
  onDelete,
}: {
  rules: RouterRule[];
  busy: boolean;
  tunnelName: (id: string | null) => string;
  onMove: (index: number, delta: number) => void;
  onToggle: (rule: RouterRule) => void;
  onEdit: (rule: RouterRule) => void;
  onDelete: (rule: RouterRule) => void;
}) {
  const { t } = useTranslation("routerPanel");
  const { t: tc } = useTranslation("common");

  if (rules.length === 0) {
    return (
      <p className="rounded border border-border bg-bg p-3 text-[11px] text-muted">
        {t("ruleTable.empty")}
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {rules.map((rule, index) => (
        // One line when there is room; in a narrow window the pattern keeps
        // the first line and kind, port and destination drop to a second one
        // (container query on the row), instead of columns squeezed to a
        // letter wide.
        <li
          key={rule.id}
          onContextMenu={(e) =>
            openMenu(e, [
              { label: tc("edit"), enabled: !busy, action: () => onEdit(rule) },
              {
                label: rule.enabled ? t("ruleTable.disableRule") : t("ruleTable.enableRule"),
                enabled: !busy,
                action: () => onToggle(rule),
              },
              "separator",
              { label: t("ruleTable.moveUp"), enabled: !busy && index > 0, action: () => onMove(index, -1) },
              {
                label: t("ruleTable.moveDown"),
                enabled: !busy && index < rules.length - 1,
                action: () => onMove(index, 1),
              },
              "separator",
              { label: tc("delete"), enabled: !busy, action: () => onDelete(rule) },
            ])
          }
          className={`@container rounded-md border border-border bg-surface px-2 py-1.5 transition-colors hover:bg-surface-hover ${rule.enabled ? "" : "opacity-60"}`}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted">{index + 1}</span>
            <input
              type="checkbox"
              checked={rule.enabled}
              disabled={busy}
              title={rule.enabled ? t("ruleTable.disableRule") : t("ruleTable.enableRule")}
              aria-label={rule.enabled ? t("ruleTable.disableRule") : t("ruleTable.enableRule")}
              onChange={() => onToggle(rule)}
            />
            <span
              className={`order-1 min-w-0 flex-1 break-all font-mono text-xs text-text ${rule.enabled ? "" : "line-through"}`}
            >
              {rule.pattern || "*"}
            </span>
            <span className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-1.5 pl-12 @xl:order-2 @xl:max-w-[50%] @xl:basis-auto @xl:pl-0">
              <span className={badge}>{t(`ruleKind.${rule.kind}`)}</span>
              <span className={`${badge} font-mono`}>{rule.port ? `:${rule.port}` : t("ruleTable.anyPort")}</span>
              <ActionChip action={rule.action} target={rule.action === "tunnel" ? tunnelName(rule.targetTunnelId) : null} />
            </span>
            <span className="order-2 flex shrink-0 items-center @xl:order-3">
              <button
                onClick={() => onMove(index, -1)}
                disabled={busy || index === 0}
                title={t("ruleTable.moveUp")}
                aria-label={t("ruleTable.moveUp")}
                className={iconButton}
              >
                <Chevron up />
              </button>
              <button
                onClick={() => onMove(index, 1)}
                disabled={busy || index === rules.length - 1}
                title={t("ruleTable.moveDown")}
                aria-label={t("ruleTable.moveDown")}
                className={iconButton}
              >
                <Chevron />
              </button>
              <button onClick={() => onEdit(rule)} disabled={busy} title={tc("edit")} aria-label={tc("edit")} className={iconButton}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                onClick={() => onDelete(rule)}
                disabled={busy}
                title={tc("delete")}
                aria-label={tc("delete")}
                className="rounded p-1 text-coral hover:bg-coral/10 disabled:opacity-30"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                  <path d="M19 6l-.8 13.2a1 1 0 0 1-1 .8H6.8a1 1 0 0 1-1-.8L5 6" />
                </svg>
              </button>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const DECISION_PAGE = 25;

function DecisionLog({
  decisions,
  tunnelName,
}: {
  decisions: RoutingDecision[];
  tunnelName: (id: string | null) => string;
}) {
  const { t } = useTranslation("routerPanel");
  // Held independently of `decisions` so the 2s poll refreshing the data does
  // not collapse the list back while you are reading it.
  const [visible, setVisible] = useState(DECISION_PAGE);
  const shown = decisions.slice(0, visible);

  return (
    <div className="space-y-1 rounded border border-border bg-bg p-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted">{t("decisionLog.title")}</p>
        {decisions.length > 0 && (
          <span className="text-[11px] text-muted">
            {t("decisionLog.showingOf", { shown: shown.length, total: decisions.length })}
          </span>
        )}
      </div>

      {decisions.length === 0 && (
        <p className="text-[11px] text-muted">{t("decisionLog.empty")}</p>
      )}

      <div className="max-h-64 space-y-1 overflow-y-auto">
        {shown.map((d, i) => (
          // Wide: one line. Narrow: host first, then destination and outcome.
          <div key={`${d.at}-${d.host}-${i}`} className="@container border-b border-border/60 pb-1 last:border-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]">
              <span className="w-16 shrink-0 text-muted">{formatTimestamp(d.at, "time")}</span>
              <span className="min-w-0 flex-1 break-all text-text">
                {d.host}:{d.port}
              </span>
              <span className="flex min-w-0 basis-full flex-wrap items-center gap-1.5 pl-18 @xl:max-w-[50%] @xl:basis-auto @xl:pl-0">
                <ActionChip action={d.action} target={d.action === "tunnel" ? tunnelName(d.targetTunnelId) : null} />
                <span className={`break-all ${d.outcome === "ok" ? "text-muted" : "text-coral"}`}>{d.outcome}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {visible < decisions.length && (
        <button
          onClick={() => setVisible((v) => v + DECISION_PAGE)}
          className={ghostButton}
        >
          {t("decisionLog.showMore")}
        </button>
      )}
    </div>
  );
}
