import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  launchCapture,
  listActiveCaptures,
  listCaptureConnections,
  listRecentCaptures,
  pickCaptureTarget,
  stopCapture,
} from "../api";
import type { CaptureConnection, CapturedProcess, RecentCapture, RuleAction } from "../types";
import type { RouterRuntimeState } from "../hooks/useRouterEvents";
import { Modal } from "./Modal";

const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none";
const labelClass = "block text-xs font-medium text-muted";
const ACTION_COLOR: Record<RuleAction, string> = {
  tunnel: "text-accent",
  direct: "text-muted",
  block: "text-coral",
};

interface Props {
  runtime: RouterRuntimeState;
  onClose: () => void;
}

export function CapturePanel({ runtime, onClose }: Props) {
  const { t } = useTranslation("capturePanel");
  const [exePath, setExePath] = useState("");
  const [args, setArgs] = useState("");
  const [label, setLabel] = useState("");
  const [captures, setCaptures] = useState<CapturedProcess[]>([]);
  const [recent, setRecent] = useState<RecentCapture[]>([]);
  const [connections, setConnections] = useState<CaptureConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => listActiveCaptures().then(setCaptures).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);

  // Same reasoning as the router's own decision log: too chatty for an
  // event, one per proxied connection, so poll while the panel is open.
  useEffect(() => {
    const load = () => listCaptureConnections().then(setConnections).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    listRecentCaptures().then(setRecent).catch(() => {});
  }, []);

  const pickRecent = (r: RecentCapture) => {
    setExePath(r.exePath);
    setArgs(r.args.join(" "));
    setLabel(r.label ?? "");
  };

  const choose = async () => {
    try {
      const path = await pickCaptureTarget();
      if (path) setExePath(path);
    } catch (err) {
      setError(String(err));
    }
  };

  const launch = async () => {
    if (!exePath) return;
    setBusy(true);
    setError(null);
    try {
      await launchCapture({
        exePath,
        args: args.trim() ? args.trim().split(/\s+/) : [],
        label: label.trim() || null,
      });
      setCaptures(await listActiveCaptures());
      setRecent(await listRecentCaptures());
      setExePath("");
      setArgs("");
      setLabel("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await stopCapture(id);
      setCaptures(await listActiveCaptures());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const running = runtime.status === "running";

  return (
    <Modal
      dismissible={false}
      title={<h2 className="font-display text-base font-semibold text-text">{t("title")}</h2>}
      onClose={onClose}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">{t("description")}</p>

        <p className="rounded border border-amber/40 bg-amber/10 p-2 text-[11px] text-text">
          {t("hookWarning")}
        </p>

        {!running && (
          <p className="rounded border border-coral/40 bg-coral/10 p-2 text-xs text-text">
            {t("routerNotRunning")}
          </p>
        )}

        {error && <p className="text-sm text-coral">{error}</p>}

        <div data-tour="capture-launch" className="space-y-2 rounded border border-border bg-bg p-3">
          <p className="text-xs font-medium text-muted">{t("launch.heading")}</p>

          {recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">{t("launch.recentLabel")}</span>
              {recent.map((r) => (
                <button
                  key={r.exePath}
                  type="button"
                  onClick={() => pickRecent(r)}
                  title={r.exePath}
                  className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text hover:bg-surface-hover"
                >
                  {r.label || r.exePath.split(/[\\/]/).pop()}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className={labelClass}>{t("launch.executableLabel")}</label>
            <div className="flex items-center gap-1.5">
              <input
                className={inputClass}
                value={exePath}
                onChange={(e) => setExePath(e.target.value)}
                placeholder={t("launch.executablePlaceholder")}
              />
              <button
                onClick={choose}
                disabled={busy}
                className="shrink-0 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-50"
              >
                {t("launch.browse")}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>{t("launch.argumentsLabel")}</label>
              <input
                className={inputClass}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t("launch.argumentsPlaceholder")}
              />
            </div>
            <div>
              <label className={labelClass}>{t("launch.labelLabel")}</label>
              <input
                className={inputClass}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("launch.labelPlaceholder")}
              />
            </div>
          </div>
          <button
            onClick={launch}
            disabled={busy || !exePath}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {t("launch.launchButton")}
          </button>
        </div>

        <div data-tour="capture-active" className="space-y-1 rounded border border-border bg-bg p-3">
          <p className="text-xs font-medium text-muted">{t("active.heading")}</p>
          {captures.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-muted">{t("active.empty")}</p>
          ) : (
            <div className="space-y-1">
              {captures.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded border border-border bg-surface p-2 font-mono text-[11px] text-text"
                >
                  <span className="w-16 shrink-0 text-muted">{t("active.pid", { pid: c.pid })}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.exePath}>
                    {c.label || c.exePath}
                  </span>
                  <span className="shrink-0 text-muted">
                    {new Date(c.startedAt * 1000).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={() => stop(c.id)}
                    disabled={busy}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-coral hover:bg-coral/10 disabled:opacity-40"
                  >
                    {t("active.stop")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div data-tour="capture-log" className="space-y-1 rounded border border-border bg-bg p-3">
          <p className="text-xs font-medium text-muted">{t("log.heading")}</p>
          {connections.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-muted">{t("log.empty")}</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {connections.map((c, i) => (
                <div
                  key={`${c.at}-${c.host}-${i}`}
                  className="flex items-center gap-2 font-mono text-[11px]"
                >
                  <span className="w-16 shrink-0 text-muted">
                    {new Date(c.at * 1000).toLocaleTimeString()}
                  </span>
                  <span className="w-16 shrink-0 text-muted">{t("log.pid", { pid: c.pid })}</span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {c.host}:{c.port}
                  </span>
                  <span className={`w-14 shrink-0 ${ACTION_COLOR[c.action]}`}>{c.action}</span>
                  <span
                    className={`w-40 shrink-0 truncate ${
                      c.outcome === "ok" ? "text-muted" : "text-coral"
                    }`}
                    title={c.outcome}
                  >
                    {c.outcome}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
