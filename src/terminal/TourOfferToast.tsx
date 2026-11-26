import { useTranslation } from "react-i18next";
import { icons } from "./PaneLayer";

/** After the short tour (no shell then), the first shell offers the rest. */
export function TourOfferToast({ onAccept, onDismiss }: { onAccept: () => void; onDismiss: () => void }) {
  const { t } = useTranslation("terminal");
  return (
    <div
      role="status"
      className="absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-surface py-1.5 pl-3 pr-1.5 text-xs text-text shadow-lg"
    >
      <span className="min-w-0">{t("tourOffer.text")}</span>
      <button onClick={onAccept} className="shrink-0 rounded px-2 py-0.5 font-medium text-accent hover:bg-accent/10">
        {t("tourOffer.accept")}
      </button>
      <button
        onClick={onDismiss}
        aria-label={t("tourOffer.dismiss")}
        title={t("tourOffer.dismiss")}
        className="shrink-0 rounded p-0.5 text-muted hover:bg-border/50 hover:text-text"
      >
        {icons.close}
      </button>
    </div>
  );
}
