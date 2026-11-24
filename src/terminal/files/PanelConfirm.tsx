import { useTranslation } from "react-i18next";
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
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-scrim p-4">
      <div role="alertdialog" aria-modal="false" className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl">
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
          />
        ) : (
          <>
            <p className="text-sm text-text">{t("files.dirty.message", { where })}</p>
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
}: {
  confirm: Extract<Confirm, { kind: "delete" }>;
  where: string;
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
      <h3 className="text-sm font-semibold text-text">{t("files.del.title", { where })}</h3>
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
