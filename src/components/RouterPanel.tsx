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
import { formatBytes } from "../format";
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
import { isWindows } from "../platform";

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const selectClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
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

const ACTION_COLOR: Record<RuleAction, string> = {
  tunnel: "text-accent",
  direct: "text-muted",
  block: "text-coral",
};

const EMPTY_RULE: RouterRuleInput = {
  enabled: true,
  kind: "hostWildcard",
  pattern: "",
  port: null,
  action: "tunnel",
  targetTunnelId: null,
};

interface Props {
  tunnels: Tunnel[];
  runtime: RouterRuntimeState;
  onClose: () => void;
}

export function RouterPanel({ tunnels, runtime, onClose }: Props) {
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

  return (
    <Modal
      dismissible={false}
      title={
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? "bg-accent" : "bg-slate"}`}
            />
            {running
              ? t("status.running", { port: runtime.port ?? config.port })
              : t("status.stopped")}
          </span>
          {running && runtime.stats && (
            <span className="font-mono text-[11px] text-muted">
              {t("stats", {
                up: formatBytes(runtime.stats.bytesUp),
                down: formatBytes(runtime.stats.bytesDown),
                count: runtime.stats.activeConnections,
              })}
            </span>
          )}
        </div>
      }
      onClose={onClose}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">
          <Trans
            t={t}
            i18nKey="description"
            components={{ code: <code className="font-mono text-text" /> }}
          />
        </p>

        <div className="grid grid-cols-2 gap-3 rounded border border-border bg-bg p-3">
          <div data-tour="router-enable" className="col-span-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => saveConfig({ ...config, enabled: !config.enabled })}
              disabled={busy}
              aria-pressed={config.enabled}
              aria-label={t("runRouter")}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                config.enabled ? "bg-accent" : "bg-slate/40"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${
                  config.enabled ? "translate-x-4" : ""
                }`}
              />
            </button>
            <span className="text-sm text-text">{t("runRouter")}</span>
          </div>

          <div className={config.enabled ? "" : "opacity-50"}>
            <label className={labelClass}>{t("listenPortLabel")}</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                className={inputClass}
                value={config.port}
                disabled={busy || !config.enabled}
                onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                onBlur={() => saveConfig(config)}
              />
              <button
                onClick={copyAddress}
                disabled={!config.enabled}
                className={ghostButton}
                title={t("copyAddressTitle")}>
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
          </div>

          <div className={config.enabled ? "" : "opacity-50"}>
            <label className={labelClass}>{t("defaultActionLabel")}</label>
            <select
              className={selectClass}
              value={config.defaultAction}
              disabled={busy || !config.enabled}
              onChange={(e) =>
                saveConfig({ ...config, defaultAction: e.target.value as RuleAction })
              }
            >
              <option value="direct">{t("ruleAction.direct")}</option>
              <option value="tunnel">{t("ruleAction.tunnel")}</option>
              <option value="block">{t("ruleAction.block")}</option>
            </select>
          </div>

          {config.defaultAction === "tunnel" && (
            <div className={`col-span-2 ${config.enabled ? "" : "opacity-50"}`}>
              <label className={labelClass}>{t("defaultTunnelLabel")}</label>
              <select
                className={selectClass}
                value={config.defaultTunnelId ?? ""}
                disabled={busy || !config.enabled}
                onChange={(e) =>
                  saveConfig({ ...config, defaultTunnelId: e.target.value || null })
                }
              >
                <option value="">{t("defaultTunnelPlaceholder")}</option>
                {tunnels.map((tun) => (
                  <option key={tun.id} value={tun.id}>
                    {tun.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {isWindows && (
            <>
              <label
                data-tour="router-proxy"
                className={`col-span-2 flex items-center gap-2 text-sm text-text ${
                  config.enabled ? "" : "opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={config.setSystemProxy}
                  disabled={busy || !config.enabled}
                  onChange={(e) => saveConfig({ ...config, setSystemProxy: e.target.checked })}
                />
                {t("setSystemProxy")}
              </label>

              {config.setSystemProxy && (
                <>
                  <div className={`col-span-2 ${config.enabled ? "" : "opacity-50"}`}>
                    <label className={labelClass}>{t("bypassListLabel")}</label>
                    <input
                      className={inputClass}
                      value={config.bypassList}
                      disabled={busy || !config.enabled}
                      onChange={(e) => setConfig({ ...config, bypassList: e.target.value })}
                      onBlur={() => saveConfig(config)}
                    />
                  </div>
                  <p className="col-span-2 text-[11px] text-muted">
                    <Trans t={t} i18nKey="pacDescription" components={{ code: <code className="font-mono" /> }} />
                    {runtime.pacUrl && (
                      <>
                        {" "}
                        <Trans
                          t={t}
                          i18nKey="pacServing"
                          values={{ url: runtime.pacUrl }}
                          components={{ code: <code className="font-mono text-text" /> }}
                        />
                      </>
                    )}
                  </p>
                </>
              )}
            </>
          )}

          <label
            className={`col-span-2 flex items-center gap-2 text-sm text-text ${
              config.enabled ? "" : "opacity-50"
            }`}
          >
            <input
              type="checkbox"
              checked={config.resolveForIpRules}
              disabled={busy || !config.enabled}
              onChange={(e) => saveConfig({ ...config, resolveForIpRules: e.target.checked })}
            />
            {t("resolveForIpRules")}
          </label>
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

        <div data-tour="router-rules" className="space-y-4">
          <RuleTable
            rules={rules}
            busy={busy}
            tunnelName={tunnelName}
            onMove={move}
            onToggle={(rule) =>
              mutateRule(() =>
                updateRouterRule(rule.id, { ...toRuleInput(rule), enabled: !rule.enabled }),
              )
            }
            onEdit={(rule) => {
              setEditing(rule);
              setDraft(toRuleInput(rule));
            }}
            onDelete={(rule) => mutateRule(() => deleteRouterRule(rule.id))}
          />

          <form
            onSubmit={submitRule}
            className="space-y-2 rounded border border-border bg-bg p-3"
          >
          <p className="text-xs font-medium text-muted">
            {editing ? t("ruleForm.editTitle") : t("ruleForm.addTitle")}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className={`${selectClass} w-32`}
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as RuleKind })}
            >
              {RULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`ruleKind.${kind}`)}
                </option>
              ))}
            </select>

            <input
              className={`${inputClass} min-w-0 flex-1`}
              value={draft.pattern}
              placeholder={
                draft.kind === "all"
                  ? t("ruleKindPlaceholder.all")
                  : (KIND_PATTERN_EXAMPLE[draft.kind] ?? "")
              }
              disabled={draft.kind === "all"}
              required={draft.kind !== "all"}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            />

            <input
              type="number"
              className={`${inputClass} w-24`}
              value={draft.port ?? ""}
              placeholder={t("ruleForm.anyPortPlaceholder")}
              onChange={(e) =>
                setDraft({ ...draft, port: e.target.value ? Number(e.target.value) : null })
              }
            />

            <select
              className={`${selectClass} w-28`}
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value as RuleAction })}
            >
              <option value="tunnel">{t("ruleAction.tunnel")}</option>
              <option value="direct">{t("ruleAction.direct")}</option>
              <option value="block">{t("ruleAction.block")}</option>
            </select>

            {draft.action === "tunnel" && (
              <select
                className={`${selectClass} w-40`}
                value={draft.targetTunnelId ?? ""}
                required
                onChange={(e) => setDraft({ ...draft, targetTunnelId: e.target.value || null })}
              >
                <option value="">{t("ruleForm.tunnelPlaceholder")}</option>
                {tunnels.map((tun) => (
                  <option key={tun.id} value={tun.id}>
                    {tun.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="submit"
              disabled={busy}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {editing ? tc("save") : t("ruleForm.add")}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setDraft(EMPTY_RULE);
                }}
                className={ghostButton}
              >
                {tc("cancel")}
              </button>
            )}
            </div>
          </form>
        </div>

        <div data-tour="router-log">
          <DecisionLog decisions={decisions} tunnelName={tunnelName} />
        </div>
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
    <div className="space-y-1 rounded border border-border bg-bg p-2">
      {rules.map((rule, index) => (
        <div
          key={rule.id}
          className={`flex items-center gap-2 font-mono text-[11px] ${
            rule.enabled ? "text-text" : "text-muted line-through"
          }`}
        >
          <span className="w-5 shrink-0 text-right text-muted">{index + 1}</span>
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={busy}
            title={rule.enabled ? t("ruleTable.disableRule") : t("ruleTable.enableRule")}
            onChange={() => onToggle(rule)}
          />
          <span className="w-24 shrink-0 truncate text-muted">{t(`ruleKind.${rule.kind}`)}</span>
          <span className="min-w-0 flex-1 truncate">{rule.pattern || "*"}</span>
          <span className="w-16 shrink-0 text-muted">
            {rule.port ? `:${rule.port}` : t("ruleTable.anyPort")}
          </span>
          <span className={`w-16 shrink-0 ${ACTION_COLOR[rule.action]}`}>
            {t(`ruleAction.${rule.action}`)}
          </span>
          <span className="w-32 shrink-0 truncate text-muted">
            {rule.action === "tunnel" ? tunnelName(rule.targetTunnelId) : "—"}
          </span>
          <button
            onClick={() => onMove(index, -1)}
            disabled={busy || index === 0}
            title={t("ruleTable.moveUp")}
            className={ghostButton}
          >
            ↑
          </button>
          <button
            onClick={() => onMove(index, 1)}
            disabled={busy || index === rules.length - 1}
            title={t("ruleTable.moveDown")}
            className={ghostButton}
          >
            ↓
          </button>
          <button onClick={() => onEdit(rule)} disabled={busy} className={ghostButton}>
            {tc("edit")}
          </button>
          <button
            onClick={() => onDelete(rule)}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-coral hover:bg-coral/10 disabled:opacity-40"
          >
            {tc("delete")}
          </button>
        </div>
      ))}
    </div>
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
          <div
            key={`${d.at}-${d.host}-${i}`}
            className="flex items-center gap-2 font-mono text-[11px]"
          >
            <span className="w-16 shrink-0 text-muted">
              {new Date(d.at * 1000).toLocaleTimeString()}
            </span>
            <span className="min-w-0 flex-1 truncate text-text">
              {d.host}:{d.port}
            </span>
            <span className={`w-14 shrink-0 ${ACTION_COLOR[d.action]}`}>
              {t(`ruleAction.${d.action}`)}
            </span>
            <span className="w-28 shrink-0 truncate text-muted">
              {d.action === "tunnel" ? tunnelName(d.targetTunnelId) : "—"}
            </span>
            <span
              className={`w-40 shrink-0 truncate ${
                d.outcome === "ok" ? "text-muted" : "text-coral"
              }`}
              title={d.outcome}
            >
              {d.outcome}
            </span>
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
