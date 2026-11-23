// Properties of one remote file or folder.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { filesDirSize, filesProperties } from "../../api";
import { formatBytes, formatTimestamp } from "../../format";
import type { FileProperties } from "../../types";
import { modeString, octal } from "./paths";

interface Props {
  tunnelId: string;
  path: string;
  onClose: () => void;
  errorText: (e: unknown) => string;
}

export function FileDetails({ tunnelId, path, onClose, errorText }: Props) {
  const { t } = useTranslation("terminal");
  const [props, setProps] = useState<FileProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirSize, setDirSize] = useState<number | "busy" | null>(null);

  useEffect(() => {
    let alive = true;
    setProps(null);
    setError(null);
    setDirSize(null);
    filesProperties(tunnelId, path)
      .then((p) => alive && setProps(p))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId, path]);

  const measure = () => {
    setDirSize("busy");
    filesDirSize(tunnelId, path)
      .then(setDirSize)
      .catch((e) => {
        setDirSize(null);
        setError(errorText(e));
      });
  };

  const isDir = props?.kind === "dir" || (props?.kind === "symlink" && props.linkDir);
  const row = (label: string, value: React.ReactNode, mono = false) => (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-all text-text ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{t("files.props.title")}</h3>
        <button onClick={onClose} className="rounded px-1.5 text-xs text-muted hover:bg-surface-hover hover:text-text" aria-label={t("files.close")}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
        {error && <p className="mb-2 text-coral">{error}</p>}
        {!props && !error && <p className="text-muted">{t("files.loading")}</p>}
        {props && (
          <dl>
            {row(t("files.props.name"), props.name, true)}
            {row(
              t("files.props.path"),
              <span className="flex items-start gap-1">
                <span className="min-w-0 flex-1">{props.path}</span>
                <button
                  onClick={() => void writeText(props.path).catch(() => {})}
                  className="shrink-0 rounded px-1 font-sans text-[10px] text-accent hover:bg-accent/10"
                >
                  {t("files.copyPath")}
                </button>
              </span>,
              true,
            )}
            {row(t("files.props.type"), t(`files.kind.${props.kind}`))}
            {props.linkTarget && row(t("files.props.target"), props.linkTarget, true)}
            {row(
              t("files.props.size"),
              isDir ? (
                dirSize === "busy" ? (
                  t("files.props.measuring")
                ) : dirSize !== null ? (
                  formatBytes(dirSize)
                ) : (
                  <button onClick={measure} className="rounded text-accent hover:underline">
                    {t("files.props.measure")}
                  </button>
                )
              ) : (
                `${formatBytes(props.size)} (${props.size.toLocaleString()} B)`
              ),
            )}
            {props.mtime !== null && row(t("files.props.modified"), formatTimestamp(props.mtime))}
            {props.atime !== null && row(t("files.props.accessed"), formatTimestamp(props.atime))}
            {row(t("files.props.mode"), `${modeString(props.mode)}  ${octal(props.mode)}`, true)}
            {row(
              t("files.props.owner"),
              `${props.owner ?? props.uid ?? "?"} : ${props.group ?? props.gid ?? "?"}`,
              true,
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
