// Building blocks shared by the export and import screens.

import { useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { ImportSections, TunnelDisposition } from "../../types";

export const inputClass =
  "w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono focus:border-accent focus:outline-none disabled:opacity-50";
export const primaryButton =
  "inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50";
export const ghostButton =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-50";

export const DISPOSITION_COLOR: Record<TunnelDisposition, string> = {
  new: "text-accent",
  overwrite: "text-amber",
  nameConflict: "text-coral",
};

export type View = "hub" | "export" | "import" | "imported";

export type ImportToggles = Omit<ImportSections, "secrets" | "overwriteNameConflicts">;

export const DEFAULT_IMPORT_TOGGLES: ImportToggles = {
  tunnels: true,
  router: true,
  settings: true,
  knownHosts: true,
  uiMode: false,
};

/** Errors from `apply_import` that belong next to the passphrase field. */
export const isPassphraseError = (err: string) =>
  err.includes("wrong passphrase") || err.includes("passphrase required");

export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

// ── Building blocks ─────────────────────────────────────────────────────────

export const TILE_TONE = {
  accent: { ring: "hover:border-accent", badge: "bg-accent/15 text-accent" },
  amber: { ring: "hover:border-amber", badge: "bg-amber/15 text-amber" },
} as const;

export function HubTile({
  tone,
  icon,
  title,
  description,
  disabled,
  onClick,
}: {
  tone: keyof typeof TILE_TONE;
  icon: ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const style = TILE_TONE[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group flex flex-col items-center gap-3 rounded-xl border-2 border-border bg-bg px-4 py-7 text-center transition-all hover:-translate-y-0.5 hover:bg-surface-hover hover:shadow-lg disabled:pointer-events-none disabled:opacity-50 ${style.ring}`}
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-transform group-hover:scale-110 ${style.badge}`}
      >
        {icon}
      </span>
      <span className="font-display text-base font-semibold text-text">{title}</span>
      <span className="text-xs text-muted">{description}</span>
    </button>
  );
}

export function OptionCard({
  checked,
  onChange,
  icon,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${
        checked ? "border-accent/60 bg-accent/10" : "border-border bg-bg hover:bg-surface-hover"
      }`}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={`mt-0.5 ${checked ? "text-accent" : "text-muted"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium ${checked ? "text-text" : "text-muted"}`}>
          {title}
        </span>
        <span className="block text-[11px] text-muted">{detail}</span>
      </span>
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked ? "border-accent bg-accent text-on-accent" : "border-border"
        }`}
      >
        {checked && <CheckIcon size={11} />}
      </span>
    </label>
  );
}

export function PasswordInput({
  value,
  onChange,
  onEnter,
  placeholder,
  disabled,
  invalid,
  autoFocus,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const { t } = useTranslation("configPanel");
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type={shown ? "text" : "password"}
        className={`${inputClass} pr-8 ${invalid ? "border-coral" : ""}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 right-0 flex items-center px-2 text-muted hover:text-text"
        aria-label={shown ? t("hidePassphrase") : t("showPassphrase")}
        title={shown ? t("hidePassphrase") : t("showPassphrase")}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</p>
  );
}

export const CALLOUT_TONE = {
  coral: "border-coral/40 bg-coral/10",
  amber: "border-amber/50 bg-amber/10",
  muted: "border-border bg-surface",
} as const;

export function Callout({ tone, children }: { tone: keyof typeof CALLOUT_TONE; children: ReactNode }) {
  return (
    <div className={`rounded-lg border p-2.5 text-[11px] text-text ${CALLOUT_TONE[tone]}`}>
      {children}
    </div>
  );
}

export function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-bg px-1 py-2.5">
      <span className={`font-display text-xl font-semibold ${value > 0 ? "text-accent" : "text-muted"}`}>
        {value}
      </span>
      <span className="text-center text-[10px] text-muted">{label}</span>
    </div>
  );
}

// ── Icons (24-unit stroke icons, sized by `size`) ───────────────────────────

export function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const UploadIcon = ({ size = 28 }: IconProps) => (
  <Icon size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Icon>
);
export const DownloadIcon = ({ size = 28 }: IconProps) => (
  <Icon size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Icon>
);
export const ServerIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  </Icon>
);
export const RouteIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <circle cx="6" cy="19" r="3" />
    <circle cx="18" cy="5" r="3" />
    <path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-8a3.5 3.5 0 0 1 0-7H12" />
  </Icon>
);
export const SlidersIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
);
export const ShieldIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);
export const LockIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Icon>
);
export const CheckIcon = ({ size = 16 }: IconProps) => (
  <Icon size={size}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);
export const FileIcon = ({ size = 22 }: IconProps) => (
  <Icon size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Icon>
);
export const EyeIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const EyeOffIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22" />
  </Icon>
);
export const AlertIcon = () => (
  <span className="mt-0.5 shrink-0">
    <Icon size={14}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
    </Icon>
  </span>
);
