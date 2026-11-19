import { useEffect, useMemo, useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { forgetKnownHost, listKnownHosts } from "../api";
import { allocatePorts, parseHostRange, rangeName, usedLocalPorts } from "../hostRange";
import { hostKeyId } from "../hooks/useHostKeyMismatches";
import type { AuthMethod, KnownHostEntry, Tunnel, TunnelInput } from "../types";
import { Modal } from "./Modal";

type AuthKind = AuthMethod["kind"];
type FormMode = "add" | "edit" | "clone";

interface Props {
  mode: FormMode;
  initial?: Tunnel | null;
  suggestedPort?: number;
  tunnels: Tunnel[];
  /** SOCKS toggle for a brand-new tunnel; hosts added for the terminal start without one. */
  defaultSocksEnabled?: boolean;
  onSubmit: (input: TunnelInput, secret?: string) => Promise<void>;
  /**
   * Enables address ranges in the host field (10.1.1.1-10.1.1.10): one tunnel
   * per address, all sharing the typed secret. Left out where a range makes no
   * sense (editing one tunnel).
   */
  onSubmitMany?: (inputs: TunnelInput[], secret?: string) => Promise<void>;
  /** The edited tunnel's trusted host key was forgotten (its `host:port`). */
  onHostKeyForgotten?: (keyId: string) => void;
  /** The edited tunnel is up: connection changes restart it on save. */
  running?: boolean;
  onCancel: () => void;
}

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none";
const monoInputClass = `${inputClass} font-mono`;
const labelClass = "block text-xs font-medium text-muted";

export function AddTunnelForm({
  mode,
  initial,
  suggestedPort,
  tunnels,
  defaultSocksEnabled = true,
  onSubmit,
  onSubmitMany,
  onHostKeyForgotten,
  running = false,
  onCancel,
}: Props) {
  const { t } = useTranslation("addTunnelForm");
  const { t: tc } = useTranslation("common");
  const [name, setName] = useState(
    initial ? (mode === "clone" ? t("clonedName", { name: initial.name }) : initial.name) : "",
  );
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(initial?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(
    initial?.auth.kind === "privateKey" ? initial.auth.path : "",
  );
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  // A clone gets a free port: the original's is, by definition, taken.
  const [localSocksPort, setLocalSocksPort] = useState(
    (mode === "clone" ? suggestedPort : initial?.localSocksPort) ?? suggestedPort ?? 1080,
  );
  const [autoConnect, setAutoConnect] = useState(mode === "edit" ? (initial?.autoConnect ?? false) : false);
  const [socksEnabled, setSocksEnabled] = useState(initial?.socksEnabled ?? defaultSocksEnabled);
  const [jumpTunnelId, setJumpTunnelId] = useState(initial?.jumpTunnelId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jumpOptions = tunnels.filter((tun) => tun.id !== initial?.id);

  // Editing shows the host key trusted for this server, the one place a
  // user thinks about "this server's key" without hunting for a global list.
  const savedKeyId = mode === "edit" && initial ? hostKeyId(initial) : null;
  const [hostKey, setHostKey] = useState<KnownHostEntry | null>(null);
  const [hostKeyForgotten, setHostKeyForgotten] = useState(false);
  useEffect(() => {
    if (!savedKeyId) return;
    listKnownHosts()
      .then((list) => setHostKey(list.find((entry) => entry.keyId === savedKeyId) ?? null))
      .catch(() => {});
  }, [savedKeyId]);

  const forgetHostKey = async () => {
    if (!savedKeyId) return;
    try {
      await forgetKnownHost(savedKeyId);
      setHostKey(null);
      setHostKeyForgotten(true);
      onHostKeyForgotten?.(savedKeyId);
    } catch (err) {
      setError(String(err));
    }
  };

  const range = useMemo(
    () => (onSubmitMany ? parseHostRange(host) : ({ kind: "single" } as const)),
    [host, onSubmitMany],
  );
  const rangePorts = useMemo(
    () =>
      range.kind === "range" && socksEnabled
        ? allocatePorts(localSocksPort, range.hosts.length, usedLocalPorts(tunnels))
        : [],
    [range, socksEnabled, localSocksPort, tunnels],
  );
  const rangeShortOfPorts = range.kind === "range" && socksEnabled && rangePorts.length < range.hosts.length;

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const auth: AuthMethod =
        authKind === "privateKey"
          ? { kind: "privateKey", path: keyPath }
          : authKind === "agent"
            ? { kind: "agent" }
            : { kind: "password" };

      const base: TunnelInput = {
        name,
        host,
        port,
        username,
        auth,
        localSocksPort,
        autoConnect,
        socksEnabled,
        jumpTunnelId: jumpTunnelId || null,
      };
      if (range.kind === "range" && onSubmitMany) {
        await onSubmitMany(
          range.hosts.map((rangeHost, i) => ({
            ...base,
            name: rangeName(name, rangeHost),
            host: rangeHost,
            localSocksPort: socksEnabled ? rangePorts[i] : localSocksPort,
          })),
          secret || undefined,
        );
      } else {
        await onSubmit(base, secret || undefined);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      dismissible={false}
      title={<h2 className="font-display text-base font-semibold text-text">{t(`title.${mode}`)}</h2>}
      onClose={onCancel}
      size="md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass}>{t("name")}</label>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className={labelClass}>{t("host")}</label>
            <input
              className={monoInputClass}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={onSubmitMany ? t("hostPlaceholderRange") : undefined}
              required
            />
          </div>
          <div>
            <label className={labelClass}>{t("port")}</label>
            <input
              type="number"
              className={monoInputClass}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
            />
          </div>
        </div>

        {range.kind === "range" && (
          <p className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-2 text-[11px] text-text">
            {t("rangeSummary", {
              count: range.hosts.length,
              first: rangeName(name, range.hosts[0]),
              last: rangeName(name, range.hosts[range.hosts.length - 1]),
            })}
            {socksEnabled && rangePorts.length > 0 && (
              <>
                {" "}
                {t("rangePorts", { first: rangePorts[0], last: rangePorts[rangePorts.length - 1] })}
              </>
            )}{" "}
            <span className="text-muted">{t("rangeNameHint")}</span>
          </p>
        )}
        {range.kind === "error" && (
          <p className="text-[11px] text-coral">
            {range.reason === "order" ? t("rangeOrder") : t("rangeTooMany", { count: range.count })}
          </p>
        )}
        {rangeShortOfPorts && <p className="text-[11px] text-coral">{t("rangeNoPorts")}</p>}

        <div>
          <label className={labelClass}>{t("username")}</label>
          <input
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>

        <div data-tour="add-auth">
          <label className={labelClass}>{t("authentication")}</label>
          <select
            className={inputClass}
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as AuthKind)}
          >
            <option value="password">{t("authKind.password")}</option>
            <option value="privateKey">{t("authKind.privateKey")}</option>
            <option value="agent">{t("authKind.agent")}</option>
          </select>
        </div>

        {authKind === "privateKey" && (
          <div>
            <label className={labelClass}>{t("keyFilePath")}</label>
            <input
              className={monoInputClass}
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="C:\Users\you\.ssh\id_ed25519"
              required
            />
          </div>
        )}

        {(authKind === "password" || authKind === "privateKey") && (
          <div>
            <label className={labelClass}>
              {authKind === "password" ? t("password") : t("keyPassphrase")}
            </label>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                className={`${monoInputClass} pr-9`}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  mode === "edit"
                    ? t("secretPlaceholder.edit")
                    : mode === "clone"
                      ? t("secretPlaceholder.clone")
                      : ""
                }
              />
              <button
                type="button"
                onClick={() => setShowSecret((current) => !current)}
                tabIndex={-1}
                title={showSecret ? t("showSecret.hide") : t("showSecret.show")}
                aria-label={showSecret ? t("showSecretAria.hide") : t("showSecretAria.show")}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-1 text-xs text-muted hover:text-text"
              >
                {showSecret ? "🙈" : "👁"}
              </button>
            </div>
          </div>
        )}

        <div data-tour="add-socks">
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={socksEnabled}
              onChange={(e) => setSocksEnabled(e.target.checked)}
            />
            {t("enableSocks")}
          </label>
        </div>

        {socksEnabled && (
          <div>
            <label className={labelClass}>{t("localSocksPort")}</label>
            <input
              type="number"
              className={monoInputClass}
              value={localSocksPort}
              onChange={(e) => setLocalSocksPort(Number(e.target.value))}
              required
            />
          </div>
        )}

        <div data-tour="add-jump">
          <label className={labelClass}>{t("connectVia")}</label>
          <select
            className={inputClass}
            value={jumpTunnelId}
            onChange={(e) => setJumpTunnelId(e.target.value)}
          >
            <option value="">{t("directConnection")}</option>
            {jumpOptions.map((tun) => (
              <option key={tun.id} value={tun.id}>
                {tun.name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
          />
          {t("connectOnStartup")}
        </label>

        {savedKeyId && (hostKey || hostKeyForgotten) && (
          <div className="rounded-lg border border-border bg-bg px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className={labelClass}>{t("hostKey.label")}</span>
              {hostKey && (
                <button
                  type="button"
                  onClick={() => void forgetHostKey()}
                  title={t("hostKey.forgetHint")}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-coral hover:bg-coral/10"
                >
                  {t("hostKey.forget")}
                </button>
              )}
            </div>
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted">
              {hostKey ? `${hostKey.algorithm} · ${hostKey.fingerprint}` : t("hostKey.forgotten")}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-coral">{error}</p>}

        {mode === "edit" && running && (
          <p className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-2 text-[11px] text-text">
            {t("runningNotice")}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover hover:text-text"
          >
            {tc("cancel")}
          </button>
          <button
            type="submit"
            disabled={busy || range.kind === "error" || rangeShortOfPorts}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {mode === "edit"
              ? tc("save")
              : range.kind === "range"
                ? t("addMany", { count: range.hosts.length })
                : t("add")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
