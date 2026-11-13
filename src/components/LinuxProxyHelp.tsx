import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { getPlatformStatus } from "../platform";
import { CopyLine } from "./CopyLine";

interface Props {
  port: number;
}

/**
 * Linux stand-in for the Windows "system proxy" toggle. There is no one
 * system-wide proxy store to write on Linux — least of all on a compositor
 * like Hyprland — so instead of pretending, this hands over the exact lines to
 * paste, already filled in with the router's port. `socks5h` (not `socks5`) so
 * hostnames reach the router's rules instead of being resolved locally.
 */
export function LinuxProxyHelp({ port }: Props) {
  const { t } = useTranslation("routerPanel");
  const [desktop, setDesktop] = useState("");

  useEffect(() => {
    getPlatformStatus()
      .then((s) => setDesktop(s.desktop))
      .catch(() => setDesktop(""));
  }, []);

  const proxy = `socks5h://127.0.0.1:${port}`;
  const hyprland = desktop.includes("hyprland");
  const code = <code className="font-mono text-text" />;

  return (
    <details className="col-span-2 rounded border border-border bg-surface p-2 text-[11px] text-muted">
      <summary className="cursor-pointer text-sm text-text">{t("linuxProxy.title")}</summary>
      <div className="mt-2 space-y-3">
        <section className="space-y-1">
          <p className="text-text">
            {hyprland ? t("linuxProxy.hyprlandHeading") : t("linuxProxy.sessionHeading")}
          </p>
          {hyprland ? (
            <>
              <CopyLine text={`env = all_proxy,${proxy}`} />
              <CopyLine text="env = no_proxy,localhost,127.0.0.1,::1" />
            </>
          ) : (
            <>
              <CopyLine text={`export all_proxy=${proxy}`} />
              <CopyLine text="export no_proxy=localhost,127.0.0.1,::1" />
            </>
          )}
          <p>
            <Trans t={t} i18nKey="linuxProxy.sessionNote" components={{ code }} />
          </p>
        </section>

        <section className="space-y-1">
          <p className="text-text">{t("linuxProxy.chromiumHeading")}</p>
          <CopyLine text={`--proxy-server="socks5://127.0.0.1:${port}"`} />
        </section>

        <section className="space-y-1">
          <p className="text-text">{t("linuxProxy.firefoxHeading")}</p>
          <p>
            <Trans t={t} i18nKey="linuxProxy.firefoxSteps" values={{ port }} components={{ code }} />
          </p>
        </section>

        <p className="text-coral">{t("linuxProxy.failClosed")}</p>
      </div>
    </details>
  );
}
