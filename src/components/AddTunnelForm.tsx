import { useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AuthMethod, Tunnel, TunnelInput } from "../types";
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
  const [localSocksPort, setLocalSocksPort] = useState(
    initial?.localSocksPort ?? suggestedPort ?? 1080,
  );
  const [autoConnect, setAutoConnect] = useState(mode === "edit" ? (initial?.autoConnect ?? false) : false);
  const [socksEnabled, setSocksEnabled] = useState(initial?.socksEnabled ?? defaultSocksEnabled);
  const [jumpTunnelId, setJumpTunnelId] = useState(initial?.jumpTunnelId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jumpOptions = tunnels.filter((tun) => tun.id !== initial?.id);

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

      await onSubmit(
        {
          name,
          host,
          port,
          username,
          auth,
          localSocksPort,
          autoConnect,
          socksEnabled,
          jumpTunnelId: jumpTunnelId || null,
        },
        secret || undefined,
      );
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

        {error && <p className="text-sm text-coral">{error}</p>}

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
            disabled={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {mode === "edit" ? tc("save") : t("add")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
