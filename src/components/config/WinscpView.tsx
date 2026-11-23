// WinSCP import: the preview Rust built (no passwords in it), what to import,
// then what happened. See `winscp.rs`.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { winscpImport } from "../../api";
import { groupSections } from "../../groups";
import type { WinscpOutcome, WinscpPreview, WinscpRow, WinscpWarning } from "../../types";
import { Callout, CheckIcon, ghostButton, primaryButton, Stat } from "./parts";

interface Props {
  preview: WinscpPreview;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onDone: (outcome: WinscpOutcome) => void;
  onCancel: () => void;
}

const selectable = (row: WinscpRow) => row.status.kind === "new";

export function WinscpView({ preview, busy, setBusy, setError, onDone, onCancel }: Props) {
  const { t } = useTranslation("configPanel");
  // New hosts start ticked; hosts already here start skipped.
  const [adds, setAdds] = useState(() => new Set(preview.rows.filter(selectable).map((r) => r.index)));
  const [groupOnly, setGroupOnly] = useState<Set<number>>(new Set());
  // Each jump host: an existing one when there is exactly one match, else
  // created (none) or left for the user to pick (several).
  const [bastionUse, setBastionUse] = useState<Record<number, string | null | undefined>>(() =>
    Object.fromEntries(
      preview.bastions.map((b) => [b.index, b.candidates.length === 1 ? b.candidates[0].id : b.candidates.length === 0 ? null : undefined]),
    ),
  );

  const sections = useMemo(() => groupSections(preview.rows, (r) => r.group), [preview.rows]);
  const counts = {
    fresh: preview.rows.filter((r) => r.status.kind === "new").length,
    existing: preview.rows.filter((r) => r.status.kind === "existing").length,
    unsupported: preview.rows.filter((r) => r.status.kind === "unsupported").length,
  };
  /** Jump hosts the ticked rows go through. */
  const neededBastions = new Set(
    preview.rows.filter((r) => adds.has(r.index) && r.bastion !== null).map((r) => r.bastion!),
  );
  const unresolved = [...neededBastions].filter((i) => bastionUse[i] === undefined);
  const total = adds.size + groupOnly.size;

  const toggle = (set: Set<number>, index: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(index);
    else next.delete(index);
    return next;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await winscpImport({
        token: preview.token,
        rows: [
          ...[...adds].map((index) => ({ index, action: "add" as const })),
          ...[...groupOnly].map((index) => ({ index, action: "setGroup" as const })),
        ],
        bastions: [...neededBastions].map((index) => ({ index, useTunnel: bastionUse[index] ?? null })),
      });
      onDone(outcome);
    } catch (err) {
      const text = String(err);
      setError(text === "expired" ? t("winscp.expired") : text);
    } finally {
      setBusy(false);
    }
  };

  const warningText = (w: WinscpWarning) => {
    switch (w.kind) {
      case "nameHost":
        return t("winscp.warn.nameHost", { named: w.named });
      case "nameUser":
        return t("winscp.warn.nameUser", { named: w.named });
      case "noPassword":
        return t("winscp.warn.noPassword");
      case "passwordUnreadable":
        return t("winscp.warn.passwordUnreadable");
      case "keyPathMissing":
        return t("winscp.warn.keyPathMissing", { path: w.path });
      case "bastionCredentialsDiffer":
        return t("winscp.warn.bastionCredentialsDiffer");
    }
  };

  const bastionLabel = (index: number) => {
    const use = bastionUse[index];
    const b = preview.bastions[index];
    if (use) return b.candidates.find((c) => c.id === use)?.name ?? b.target;
    return b.target;
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        {t("winscp.summary", { file: preview.fileName, fresh: counts.fresh, existing: counts.existing })}
        {counts.unsupported > 0 && <> {t("winscp.unsupportedCount", { count: counts.unsupported })}</>}
      </p>

      {preview.bastions.length > 0 && (
        <section className="space-y-1.5">
          <h4 className="px-1 text-xs font-semibold text-text">{t("winscp.bastions")}</h4>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg/50">
            {preview.bastions.map((b) => (
              <div key={b.index} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={b.target}>
                  {b.target}
                </span>
                <select
                  value={bastionUse[b.index] ?? (bastionUse[b.index] === null ? "" : "?")}
                  onChange={(e) =>
                    setBastionUse((prev) => ({ ...prev, [b.index]: e.target.value === "" ? null : e.target.value }))
                  }
                  disabled={busy}
                  className={`rounded border bg-bg px-1.5 py-1 text-xs text-text ${
                    bastionUse[b.index] === undefined && neededBastions.has(b.index) ? "border-amber" : "border-border"
                  }`}
                >
                  {bastionUse[b.index] === undefined && (
                    <option value="?" disabled>
                      {t("winscp.pickBastion")}
                    </option>
                  )}
                  {b.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t("winscp.useExisting", { name: c.name })}
                    </option>
                  ))}
                  <option value="">{t("winscp.createBastion")}</option>
                </select>
                {b.warnings.map((w, i) => (
                  <p key={i} className="w-full text-[11px] text-amber">
                    {warningText(w)}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="max-h-[46vh] space-y-3 overflow-y-auto pr-1">
        {sections.map((section) => {
          const rows = section.items;
          const pickable = rows.filter(selectable);
          const allOn = pickable.length > 0 && pickable.every((r) => adds.has(r.index));
          return (
            <section key={section.name ?? ""} className="space-y-1.5">
              <label className="flex items-center gap-2 px-1 text-xs font-semibold text-text">
                <input
                  type="checkbox"
                  checked={allOn}
                  disabled={busy || pickable.length === 0}
                  onChange={(e) =>
                    setAdds((prev) => {
                      const next = new Set(prev);
                      for (const r of pickable) {
                        if (e.target.checked) next.add(r.index);
                        else next.delete(r.index);
                      }
                      return next;
                    })
                  }
                />
                <span className={section.name ? "" : "italic text-muted"}>{section.name ?? t("winscp.noGroup")}</span>
                <span className="font-mono text-[10px] font-normal text-muted">{rows.length}</span>
              </label>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg/50">
                {rows.map((row) => (
                  <li key={row.index} className={`flex items-start gap-2.5 px-3 py-2 ${row.status.kind === "unsupported" ? "opacity-50" : ""}`}>
                    {row.status.kind === "new" ? (
                      <input
                        type="checkbox"
                        aria-label={row.name}
                        className="mt-0.5"
                        checked={adds.has(row.index)}
                        disabled={busy}
                        onChange={(e) => setAdds((prev) => toggle(prev, row.index, e.target.checked))}
                      />
                    ) : (
                      <span className="w-[13px]" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm text-text">{row.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted">{row.target}</span>
                        {row.bastion !== null && (
                          <span className="text-[11px] text-muted">{t("winscp.via", { name: bastionLabel(row.bastion) })}</span>
                        )}
                      </div>
                      {row.remoteDir && (
                        <p className="truncate font-mono text-[10px] text-muted" title={row.remoteDir}>
                          {row.remoteDir}
                        </p>
                      )}
                      {row.warnings.map((w, i) => (
                        <p key={i} className="text-[11px] text-amber">
                          {warningText(w)}
                        </p>
                      ))}
                    </div>
                    {row.status.kind === "new" && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {t("winscp.new")}
                      </span>
                    )}
                    {row.status.kind === "unsupported" && (
                      <span className="shrink-0 rounded bg-border px-1.5 py-0.5 text-[10px] text-muted">{t("winscp.notSsh")}</span>
                    )}
                    {row.status.kind === "existing" && (
                      <select
                        aria-label={row.name}
                        value={groupOnly.has(row.index) ? "group" : "skip"}
                        disabled={busy || !row.group || row.status.group?.toLowerCase() === row.group.toLowerCase()}
                        onChange={(e) => setGroupOnly((prev) => toggle(prev, row.index, e.target.value === "group"))}
                        title={t("winscp.existingAs", { name: row.status.name })}
                        className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-text"
                      >
                        <option value="skip">{t("winscp.skipExisting", { name: row.status.name })}</option>
                        {row.group && <option value="group">{t("winscp.setGroupOnly", { group: row.group })}</option>}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <Callout tone="muted">{t("winscp.safety")}</Callout>
      {unresolved.length > 0 && <Callout tone="amber">{t("winscp.pickBastionFirst")}</Callout>}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className={ghostButton}>
          {t("winscp.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={busy || total === 0 || unresolved.length > 0}
          className={primaryButton}
        >
          {t("winscp.import", { count: total })}
        </button>
      </div>
    </div>
  );
}

export function WinscpDoneView({ outcome, onClose }: { outcome: WinscpOutcome; onClose: () => void }) {
  const { t } = useTranslation("configPanel");
  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
        <CheckIcon size={24} />
      </span>
      <p className="text-sm font-medium text-text">{t("winscp.done")}</p>
      <div className="grid w-full grid-cols-4 gap-2">
        <Stat value={outcome.added} label={t("winscp.statAdded")} />
        <Stat value={outcome.bastionsCreated} label={t("winscp.statBastions")} />
        <Stat value={outcome.grouped} label={t("winscp.statGrouped")} />
        <Stat value={outcome.failed.length} label={t("winscp.statFailed")} />
      </div>
      {outcome.groups.length > 0 && (
        <p className="text-center text-xs text-muted">{t("winscp.groups", { groups: outcome.groups.join(", ") })}</p>
      )}
      {outcome.failed.length > 0 && (
        <div className="w-full">
          <Callout tone="coral">
            <ul className="space-y-0.5">
              {outcome.failed.map((f, i) => (
                <li key={i}>
                  <span className="font-medium">{f.name}</span>: {f.error}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
      <Callout tone="amber">{t("winscp.cleanup")}</Callout>
      <button onClick={onClose} className={primaryButton}>
        {t("result.close")}
      </button>
    </div>
  );
}
