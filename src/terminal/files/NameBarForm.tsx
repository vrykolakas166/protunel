import { useTranslation } from "react-i18next";
import { validName } from "./paths";
import type { NameBarState } from "./panelStore";

/** New folder / new file / rename: one line under the toolbar. */
export function NameBarForm({
  nameBar,
  setNameBar,
  onSubmit,
}: {
  nameBar: NameBarState;
  setNameBar: (next: NameBarState | null) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b border-border bg-accent/5 px-2.5 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="shrink-0 text-xs text-muted" htmlFor="file-name-bar">
        {nameBar.kind === "rename" ? t("files.renameLabel") : nameBar.kind === "dir" ? t("files.newFolder") : t("files.newFile")}
      </label>
      <input
        id="file-name-bar"
        autoFocus
        value={nameBar.value}
        onChange={(e) => setNameBar({ ...nameBar, value: e.target.value })}
        onFocus={(e) => {
          // Rename selects the name without its extension, like a file manager.
          const v = e.currentTarget.value;
          const dot = v.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
        }}
        spellCheck={false}
        className="min-w-0 flex-1 rounded border border-accent bg-bg px-2 py-0.5 font-mono text-xs text-text outline-none"
      />
      <button type="submit" disabled={!validName(nameBar.value)} className="rounded bg-accent px-2.5 py-0.5 text-xs font-medium text-on-accent disabled:opacity-40">
        {nameBar.kind === "rename" ? t("files.rename") : t("files.create")}
      </button>
      <button type="button" onClick={() => setNameBar(null)} className="rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-hover">
        {t("files.cancel")}
      </button>
    </form>
  );
}
