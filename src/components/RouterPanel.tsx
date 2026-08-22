import { useEffect, useMemo, useState, type FormEvent } from "react";
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

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const selectClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const ghostButton =
  "rounded px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40";

const KIND_LABEL: Record<RuleKind, string> = {
  hostWildcard: "Host wildcard",
  hostRegex: "Host regex",
  ipCidr: "IP CIDR",
  all: "Everything",
};

const KIND_PLACEHOLDER: Record<RuleKind, string> = {
  hostWildcard: "*.example.com",
  hostRegex: "\\.corp\\.net$",
  ipCidr: "10.0.0.0/8",
  all: "(matches everything)",
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
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [rules, setRules] = useState<RouterRule[]>([]);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [editing, setEditing] = useState<RouterRule | null>(null);
  const [draft, setDraft] = useState<RouterRuleInput>(EMPTY_RULE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const tunnelName = useMemo(() => {
    const byId = new Map(tunnels.map((t) => [t.id, t.name]));
    return (id: string | null) => (id ? (byId.get(id) ?? "(deleted tunnel)") : "—");
  }, [tunnels]);

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

  const submitRule = async (e: FormEvent) => {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-base font-semibold text-text">Proxy router</h2>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${running ? "bg-accent" : "bg-slate"}`}
            />
            {running ? `listening on :${runtime.port ?? config.port}` : "stopped"}
          </span>
          {running && runtime.stats && (
            <span className="font-mono text-[11px] text-muted">
              ↑ {formatBytes(runtime.stats.bytesUp)} ↓ {formatBytes(runtime.stats.bytesDown)} ·{" "}
              {runtime.stats.activeConnections} open
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-sm text-muted hover:bg-surface-hover hover:text-text"
          >
            Close
          </button>
        </div>

        <p className="text-xs text-muted">
          One local SOCKS5 port that picks a tunnel per destination. Rules are evaluated top
          to bottom and the first enabled match wins; anything unmatched takes the default
          action. Point tools at it with{" "}
          <code className="font-mono text-text">--socks5-hostname</code> so the hostname
          reaches the rules.
        </p>

        <div className="grid grid-cols-2 gap-3 rounded border border-border bg-bg p-3">
          <label
            data-tour="router-enable"
            className="col-span-2 flex items-center gap-2 text-sm text-text"
          >
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={busy}
              onChange={(e) => saveConfig({ ...config, enabled: e.target.checked })}
            />
            Run the router
          </label>

          <div>
            <label className={labelClass}>Listen port (127.0.0.1 only)</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                className={inputClass}
                value={config.port}
                disabled={busy}
                onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                onBlur={() => saveConfig(config)}
              />
              <button onClick={copyAddress} className={ghostButton} title="Copy address">
                {copied ? "copied" : "copy"}
              </button>
            </div>
          </div>

          <div>
            <label className={labelClass}>When nothing matches</label>
            <select
              className={selectClass}
              value={config.defaultAction}
              disabled={busy}
              onChange={(e) =>
                saveConfig({ ...config, defaultAction: e.target.value as RuleAction })
              }
            >
              <option value="direct">Direct</option>
              <option value="tunnel">Tunnel</option>
              <option value="block">Block</option>
            </select>
          </div>

          {config.defaultAction === "tunnel" && (
            <div className="col-span-2">
              <label className={labelClass}>Default tunnel</label>
              <select
                className={selectClass}
                value={config.defaultTunnelId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  saveConfig({ ...config, defaultTunnelId: e.target.value || null })
                }
              >
                <option value="">Select a tunnel…</option>
                {tunnels.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label
            data-tour="router-proxy"
            className="col-span-2 flex items-center gap-2 text-sm text-text"
          >
            <input
              type="checkbox"
              checked={config.setSystemProxy}
              disabled={busy}
              onChange={(e) => saveConfig({ ...config, setSystemProxy: e.target.checked })}
            />
            Point the Windows system proxy here while running
          </label>

          {config.setSystemProxy && (
            <>
              <div className="col-span-2">
                <label className={labelClass}>
                  Bypass list (semicolon-separated; these never reach the router)
                </label>
                <input
                  className={inputClass}
                  value={config.bypassList}
                  disabled={busy}
                  onChange={(e) => setConfig({ ...config, bypassList: e.target.value })}
                  onBlur={() => saveConfig(config)}
                />
              </div>
              <p className="col-span-2 text-[11px] text-muted">
                Wired up with a PAC script, because Windows' plain{" "}
                <code className="font-mono">socks=</code> proxy setting means SOCKS4 and
                this listener speaks SOCKS5.
                {runtime.pacUrl && (
                  <>
                    {" "}
                    Serving <code className="font-mono text-text">{runtime.pacUrl}</code>
                  </>
                )}
              </p>
            </>
          )}

          <label className="col-span-2 flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={config.resolveForIpRules}
              disabled={busy}
              onChange={(e) => saveConfig({ ...config, resolveForIpRules: e.target.checked })}
            />
            Resolve hostnames locally so IP/CIDR rules can match them
          </label>
        </div>

        {error && <p className="text-sm text-coral">{error}</p>}
        {runtime.message && <p className="text-xs text-amber">{runtime.message}</p>}
        {runtime.compileErrors.length > 0 && (
          <div className="rounded border border-coral/40 bg-coral/10 p-2 text-[11px] text-coral">
            {runtime.compileErrors.map((e) => (
              <p key={e}>Rule ignored — {e}</p>
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
            {editing ? "Edit rule" : "Add rule"}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className={`${selectClass} w-32`}
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as RuleKind })}
            >
              {(Object.keys(KIND_LABEL) as RuleKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>

            <input
              className={`${inputClass} min-w-0 flex-1`}
              value={draft.pattern}
              placeholder={KIND_PLACEHOLDER[draft.kind]}
              disabled={draft.kind === "all"}
              required={draft.kind !== "all"}
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            />

            <input
              type="number"
              className={`${inputClass} w-24`}
              value={draft.port ?? ""}
              placeholder="any port"
              onChange={(e) =>
                setDraft({ ...draft, port: e.target.value ? Number(e.target.value) : null })
              }
            />

            <select
              className={`${selectClass} w-28`}
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value as RuleAction })}
            >
              <option value="tunnel">Tunnel</option>
              <option value="direct">Direct</option>
              <option value="block">Block</option>
            </select>

            {draft.action === "tunnel" && (
              <select
                className={`${selectClass} w-40`}
                value={draft.targetTunnelId ?? ""}
                required
                onChange={(e) => setDraft({ ...draft, targetTunnelId: e.target.value || null })}
              >
                <option value="">Select tunnel…</option>
                {tunnels.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="submit"
              disabled={busy}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {editing ? "Save" : "Add"}
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
                Cancel
              </button>
            )}
            </div>
          </form>
        </div>

        <div data-tour="router-log">
          <DecisionLog decisions={decisions} tunnelName={tunnelName} />
        </div>
      </div>
    </div>
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
  if (rules.length === 0) {
    return (
      <p className="rounded border border-border bg-bg p-3 text-[11px] text-muted">
        No rules yet. Without any, every connection takes the default action.
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
            title={rule.enabled ? "Disable rule" : "Enable rule"}
            onChange={() => onToggle(rule)}
          />
          <span className="w-24 shrink-0 truncate text-muted">{KIND_LABEL[rule.kind]}</span>
          <span className="min-w-0 flex-1 truncate">{rule.pattern || "*"}</span>
          <span className="w-16 shrink-0 text-muted">
            {rule.port ? `:${rule.port}` : "any"}
          </span>
          <span className={`w-16 shrink-0 ${ACTION_COLOR[rule.action]}`}>{rule.action}</span>
          <span className="w-32 shrink-0 truncate text-muted">
            {rule.action === "tunnel" ? tunnelName(rule.targetTunnelId) : "—"}
          </span>
          <button
            onClick={() => onMove(index, -1)}
            disabled={busy || index === 0}
            title="Move up"
            className={ghostButton}
          >
            ↑
          </button>
          <button
            onClick={() => onMove(index, 1)}
            disabled={busy || index === rules.length - 1}
            title="Move down"
            className={ghostButton}
          >
            ↓
          </button>
          <button onClick={() => onEdit(rule)} disabled={busy} className={ghostButton}>
            Edit
          </button>
          <button
            onClick={() => onDelete(rule)}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-coral hover:bg-coral/10 disabled:opacity-40"
          >
            Delete
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
  // Held independently of `decisions` so the 2s poll refreshing the data does
  // not collapse the list back while you are reading it.
  const [visible, setVisible] = useState(DECISION_PAGE);
  const shown = decisions.slice(0, visible);

  return (
    <div className="space-y-1 rounded border border-border bg-bg p-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted">Recent decisions</p>
        {decisions.length > 0 && (
          <span className="text-[11px] text-muted">
            showing {shown.length} of {decisions.length}
          </span>
        )}
      </div>

      {decisions.length === 0 && (
        <p className="text-[11px] text-muted">Nothing routed yet.</p>
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
            <span className={`w-14 shrink-0 ${ACTION_COLOR[d.action]}`}>{d.action}</span>
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
          Show more
        </button>
      )}
    </div>
  );
}
