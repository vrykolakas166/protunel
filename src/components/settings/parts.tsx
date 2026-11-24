import type { ReactNode } from "react";
import type { Settings } from "../../types";

export type SaveSettings = (next: Settings, base?: Settings) => Promise<void>;

/** What every page that edits settings receives from the panel. */
export interface PageProps {
  settings: Settings;
  save: SaveSettings;
  busy: boolean;
}

export type NumericSetting =
  | "keepaliveIntervalSecs"
  | "reconnectMaxAttempts"
  | "portRangeMin"
  | "portRangeMax"
  | "terminalLongCommandSecs";

export interface NumberDraft {
  key: NumericSetting;
  value: number;
  base: Settings;
}

/** Pages that have number fields get the panel's bound control builder. */
export type NumberControlFn = (key: NumericSetting, tooltip: string) => ReactNode;

const numberInputClass =
  "w-24 rounded border border-border bg-bg px-2 py-1 text-right font-mono text-sm text-text focus:border-accent focus:outline-none disabled:opacity-50";

/**
 * A number field that keeps its draft until blur, then saves against the
 * settings the draft started from (a stale copy cannot revert other fields).
 */
export function NumberControl({
  field,
  tooltip,
  settings,
  busy,
  numberDraft,
  setNumberDraft,
  save,
}: {
  field: NumericSetting;
  tooltip: string;
  settings: Settings;
  busy: boolean;
  numberDraft: NumberDraft | null;
  setNumberDraft: (update: NumberDraft | null | ((current: NumberDraft | null) => NumberDraft | null)) => void;
  save: SaveSettings;
}) {
  const key = field;
  const draft = numberDraft?.key === key ? numberDraft : null;
  return (
    <input
      type="number"
      title={tooltip}
      className={numberInputClass}
      value={draft?.value ?? settings[key]}
      disabled={busy}
      onChange={(e) => {
        const input = Number(e.target.value);
        const value = key === "terminalLongCommandSecs" ? Math.max(0, Math.round(input)) : input;
        setNumberDraft({ key, value, base: draft?.base ?? settings });
      }}
      onBlur={() => {
        if (!draft) return;
        void save({ ...draft.base, [key]: draft.value }, draft.base).finally(() => {
          setNumberDraft((current) => (current === draft ? null : current));
        });
      }}
    />
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
        checked ? "border-accent bg-accent" : "border-muted/60 bg-transparent hover:bg-surface-hover"
      }`}
    >
      <span
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ${
          checked ? "left-[18px] bg-on-accent" : "left-[3px] bg-muted"
        }`}
      />
    </button>
  );
}

/** A titled group of rows on one card. */
export function Group({ title, children, tour }: { title?: string; children: ReactNode; tour?: string }) {
  return (
    <section data-tour={tour} className="space-y-1.5">
      {title && <h4 className="px-1 text-xs font-semibold text-text">{title}</h4>}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg/50">
        {children}
      </div>
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function Row({
  title,
  description,
  control,
  indent = false,
  disabled = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  indent?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`px-3.5 py-3 ${indent ? "pl-8" : ""}`}>
      <div className={`flex items-center gap-4 ${disabled ? "opacity-50" : ""}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text">{title}</p>
          {description && <p className="mt-0.5 text-[11px] leading-snug text-muted">{description}</p>}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

export function timeAgo(at: number, language: string): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}
