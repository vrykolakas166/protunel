import { useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

interface Props {
  text: string;
}

/** One command or config line, monospace, with a copy button beside it. */
export function CopyLine({ text }: Props) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={text}>
        {text}
      </code>
      <button onClick={copy} className="shrink-0 text-[11px] text-muted hover:text-text">
        {copied ? t("copied") : t("copy")}
      </button>
    </div>
  );
}
