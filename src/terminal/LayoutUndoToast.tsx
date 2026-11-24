import { useTranslation } from "react-i18next";
import { icons } from "./PaneLayer";
import { UNDO_MS, type LayoutUndo } from "./useLayoutUndo";

/** "Layout tiled / equalized" with Undo, offered for `UNDO_MS`. */
export function LayoutUndoToast({
  layoutUndo,
  onUndo,
  onDismiss,
}: {
  layoutUndo: LayoutUndo;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <div
      role="status"
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 overflow-hidden rounded-md border border-border bg-surface py-1.5 pl-3 pr-1.5 text-xs text-text shadow-lg"
    >
      {icons.layout}
      <span>{t(layoutUndo.kind === "tile" ? "layout.tiled" : "layout.equalized")}</span>
      <button
        onClick={onUndo}
        title={layoutUndo.kind === "tile" ? t("layout.undoTileHint") : undefined}
        className="rounded px-2 py-0.5 font-medium text-accent hover:bg-accent/10"
      >
        {t("layout.undo")}
      </button>
      <button
        onClick={onDismiss}
        aria-label={t("layout.undoDismiss")}
        title={t("layout.undoDismiss")}
        className="rounded p-0.5 text-muted hover:bg-border/50 hover:text-text"
      >
        {icons.close}
      </button>
      <span
        key={layoutUndo.at}
        className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-accent/60"
        style={{ animation: `layout-undo ${UNDO_MS}ms linear forwards` }}
      />
    </div>
  );
}
