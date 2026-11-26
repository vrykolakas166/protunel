import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Conflict } from "../../types";
import { baseName } from "./paths";
import { deleteConfirmed, deleteNeedsTyping } from "./panelLogic";
import { TYPE_TO_CONFIRM, type Confirm } from "./panelStore";

/** Delete / unsaved-changes confirmation over the panel. */
export function PanelConfirm({
  confirm,
  where,
  setConfirm,
  onDelete,
  focusList,
}: {
  confirm: Confirm;
  where: string;
  setConfirm: (next: Confirm | null) => void;
  onDelete: (paths: string[]) => void;
  focusList: () => void;
}) {
  const { t } = useTranslation("terminal");
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  // Tab stays inside the question while it is up.
  const wrapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !boxRef.current) return;
    const items = [...boxRef.current.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-scrim p-4">
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        onKeyDown={wrapTab}
        className="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-lg border border-border bg-surface p-4 shadow-xl"
      >
        {confirm.kind === "delete" ? (
          <DeleteConfirm
            confirm={confirm}
            where={where}
            onTyped={(typed) => setConfirm({ ...confirm, typed })}
            onCancel={() => {
              setConfirm(null);
              focusList();
            }}
            onConfirm={() => onDelete(confirm.paths)}
            titleId={titleId}
          />
        ) : confirm.kind === "clash" ? (
          <ClashConfirm confirm={confirm} where={where} titleId={titleId} />
        ) : (
          <>
            <p id={titleId} className="text-sm text-text">{t("files.dirty.message", { where })}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => confirm.resolve("cancel")} className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
                {t("files.cancel")}
              </button>
              <button onClick={() => confirm.resolve("discard")} className="rounded px-3 py-1.5 text-xs text-coral hover:bg-coral/10">
                {t("files.dirty.discard")}
              </button>
              <button autoFocus onClick={() => confirm.resolve("save")} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent">
                {t("files.view.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DeleteConfirm({
  confirm,
  where,
  onTyped,
  onCancel,
  onConfirm,
  titleId,
}: {
  confirm: Extract<Confirm, { kind: "delete" }>;
  where: string;
  titleId: string;
  onTyped: (typed: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("terminal");
  const { paths, count, typed } = confirm;
  const needsTyping = deleteNeedsTyping(count, TYPE_TO_CONFIRM);
  const word = baseName(paths[0]);
  const ok = deleteConfirmed(count, typed, word, TYPE_TO_CONFIRM);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onConfirm();
      }}
    >
      <h3 id={titleId} className="text-sm font-semibold text-text">{t("files.del.title", { where })}</h3>
      <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto rounded bg-bg px-2 py-1.5 font-mono text-[11px] text-text">
        {paths.slice(0, 6).map((p) => (
          <li key={p} className="truncate" title={p}>
            {p}
          </li>
        ))}
        {paths.length > 6 && <li className="text-muted">{t("files.del.andMore", { count: paths.length - 6 })}</li>}
      </ul>
      <p className="mt-2 text-xs text-muted">
        {count === null
          ? t("files.del.counting")
          : t(count.more ? "files.del.countMore" : "files.del.count", { files: count.files, dirs: count.dirs })}
      </p>
      <p className="mt-1 text-xs text-coral">{t("files.del.noTrash")}</p>
      {needsTyping && (
        <label className="mt-3 block text-xs text-muted">
          {t("files.del.typeName", { name: word })}
          <input
            autoFocus
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            spellCheck={false}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-text outline-none focus:border-coral"
          />
        </label>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
          {t("files.cancel")}
        </button>
        <button
          type="submit"
          autoFocus={!needsTyping}
          disabled={!ok}
          className="rounded bg-coral px-3 py-1.5 text-xs font-medium text-on-coral disabled:opacity-40"
        >
          {t("files.del.confirm")}
        </button>
      </div>
    </form>
  );
}

const CHOICES: Conflict[] = ["skip", "replace", "keepBoth"];

/**
 * Names already taken where files are arriving: one list, every name on
 * Skip until changed, set one by one or all at once. Enter starts with what
 * is set, so a quick Enter never replaces anything.
 */
function ClashConfirm({ confirm, where, titleId }: { confirm: Extract<Confirm, { kind: "clash" }>; where: string; titleId: string }) {
  const { t } = useTranslation("terminal");
  const [choices, setChoices] = useState<Map<string, Conflict>>(() => new Map(confirm.names.map((n) => [n, "skip"])));
  const set = (name: string, c: Conflict) => setChoices((prev) => new Map(prev).set(name, c));
  const setAll = (c: Conflict) => setChoices(new Map(confirm.names.map((n) => [n, c])));
  const count = (c: Conflict) => [...choices.values()].filter((x) => x === c).length;
  const fresh = confirm.total - confirm.names.length;
  const label = (c: Conflict) => t(`files.clash.${c}`);
  return (
    <div className="flex min-h-0 flex-col">
      <h3 id={titleId} className="text-sm font-semibold text-text">
        {t("files.clash.title", { count: confirm.names.length })}
      </h3>
      <p className="mt-1 break-all text-xs text-muted">{t("files.clash.where", { where, dir: confirm.dir })}</p>
      {confirm.names.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-muted">
          <span className="mr-1">{t("files.clash.setAll")}</span>
          {CHOICES.map((c) => (
            <button
              key={c}
              onClick={() => setAll(c)}
              className={`rounded border border-border px-2 py-0.5 hover:bg-surface-hover ${c === "replace" ? "text-coral" : "text-text"}`}
            >
              {label(c)}
            </button>
          ))}
        </div>
      )}
      {/* Shrinks first on a small panel, so the buttons stay on screen. */}
      <ul className="mt-2 max-h-56 min-h-12 shrink space-y-1 overflow-y-auto pr-1">
        {confirm.names.map((name) => {
          const chosen = choices.get(name) ?? "skip";
          return (
            <li key={name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={name}>
                {name}
              </span>
              {/* Native radios: one Tab stop per name, arrows change the choice. */}
              <div role="radiogroup" aria-label={name} className="flex shrink-0 overflow-hidden rounded border border-border">
                {CHOICES.map((c) => (
                  <label
                    key={c}
                    className={`cursor-pointer px-2 py-0.5 text-[11px] has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-accent ${
                      chosen === c
                        ? c === "replace"
                          ? "bg-coral text-on-coral"
                          : "bg-accent text-on-accent"
                        : "text-muted hover:bg-surface-hover"
                    }`}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name={`${titleId}-${name}`}
                      checked={chosen === c}
                      onChange={() => set(name, c)}
                    />
                    {label(c)}
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {count("replace") > 0 && <p className="mt-2 text-[11px] text-coral">{t("files.clash.replaceNote")}</p>}
      <p className="mt-2 text-[11px] text-muted">
        {[
          fresh > 0 && t("files.clash.sumNew", { count: fresh }),
          count("skip") > 0 && t("files.clash.sumSkip", { count: count("skip") }),
          count("replace") > 0 && t("files.clash.sumReplace", { count: count("replace") }),
          count("keepBoth") > 0 && t("files.clash.sumKeepBoth", { count: count("keepBoth") }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={() => confirm.resolve(null)} className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">
          {t("files.cancel")}
        </button>
        <button autoFocus onClick={() => confirm.resolve(choices)} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent">
          {t("files.clash.start")}
        </button>
      </div>
    </div>
  );
}
