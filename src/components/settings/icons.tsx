import type { ReactNode } from "react";
import type { SettingsPage } from "../SettingsPanel";

/** 16-unit stroke icons for the pages, and the gear for the panel itself. */
const ICON_PATHS: Record<SettingsPage | "settings", ReactNode> = {
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M6.9 1.6h2.2l.4 1.7 1.2.7 1.7-.5 1.1 1.9-1.3 1.2v1.4l1.3 1.2-1.1 1.9-1.7-.5-1.2.7-.4 1.7H6.9l-.4-1.7-1.2-.7-1.7.5-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.7.5 1.2-.7z" />
    </>
  ),
  general: (
    <>
      <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
      <circle cx="11" cy="4.5" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </>
  ),
  tunnels: (
    <>
      <path d="M2 13.5V8a6 6 0 0 1 12 0v5.5" />
      <path d="M5.2 13.5V8.6a2.8 2.8 0 0 1 5.6 0v4.9" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6.5L6.5 8.5L4.5 10.5M8.5 10.5H11.5" />
    </>
  ),
  backup: (
    <>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.8-.5 3 3 0 0 1 .1 6.5" />
      <path d="M6 10L8 8L10 10M8 8V14" />
    </>
  ),
  about: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.3V11M8 5V5.1" />
    </>
  ),
  devtools: (
    <>
      <path d="M6 1.8h4M6.6 1.8v4.4L2.8 12.6a1 1 0 0 0 .9 1.6h8.6a1 1 0 0 0 .9-1.6L9.4 6.2V1.8" />
      <path d="M4.6 9.6h6.8" />
    </>
  ),
};

export function SettingsIcon({ name, size = 15 }: { name: SettingsPage | "settings"; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
