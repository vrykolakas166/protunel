import { useEffect, type KeyboardEvent, type RefObject } from "react";

/** What Tab can land on inside a dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // Rendered, and not inside a dialog stacked within this one.
    (el) => el.getClientRects().length > 0 && el.closest("[role='dialog']") === panel,
  );
}

/**
 * Keyboard focus belongs to a modal dialog while it is open: it moves in on
 * open (unless a field already took it with autoFocus — preferring the body
 * over the header's close button), Tab and Shift+Tab wrap around inside, and
 * on close it goes back to whatever had it. Without this, Tab walks out to
 * controls the backdrop covers. Returns the panel's onKeyDown; the panel
 * needs `role="dialog"` and `tabIndex={-1}` (the fallback when it holds
 * nothing focusable).
 */
export function useDialogFocus(panelRef: RefObject<HTMLElement | null>, bodyRef?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.contains(document.activeElement)) {
      const body = bodyRef?.current;
      const items = focusables(panel);
      const first = (body && items.find((el) => body.contains(el))) ?? items[0];
      (first ?? panel).focus();
    }
    return () => {
      if (opener?.isConnected) opener.focus();
    };
    // Once per opening: the refs are stable.
  }, []);

  return (e: KeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (e.key !== "Tab" || !panel || (e.target as HTMLElement).closest("[role='dialog']") !== panel) return;
    const items = focusables(panel);
    e.preventDefault();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
    items[next].focus();
  };
}
