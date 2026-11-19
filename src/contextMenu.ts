import type { MouseEvent as ReactMouseEvent } from "react";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import i18n from "./i18n";

/**
 * Right-click menus drawn by the OS (Win32 / GTK), like the tray menu,
 * instead of the webview's own (Reload, Inspect…), which gives the page away.
 * Components open one with `openMenu`; `installContextMenuGuard` blocks the
 * webview menu everywhere else and gives text fields Cut/Copy/Paste.
 * In a dev build, Shift + right-click still reaches the webview's menu.
 */

export type MenuEntry = { label: string; action: () => void; enabled?: boolean } | "separator";

/** Shift + right-click in a dev build: leave the webview menu alone. */
const wantsWebviewMenu = (e: MouseEvent | ReactMouseEvent) => import.meta.env.DEV && e.shiftKey;

async function popup(entries: MenuEntry[], x: number, y: number) {
  const items = entries.map((entry) =>
    entry === "separator"
      ? { item: "Separator" as const }
      : { text: entry.label, enabled: entry.enabled ?? true, action: entry.action },
  );
  const menu = await Menu.new({ items });
  await menu.popup(new LogicalPosition(x, y));
}

/** Opens `entries` at the pointer. Returns false (doing nothing) for Shift in dev. */
export function openMenu(e: MouseEvent | ReactMouseEvent, entries: MenuEntry[]): boolean {
  if (wantsWebviewMenu(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  void popup(entries, e.clientX, e.clientY);
  return true;
}

type Editable = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "number", "password", ""]);

function editableTarget(target: EventTarget | null): Editable | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)) return target;
  return null;
}

/**
 * Cut/Copy/Paste/Select all for an input. Menu actions arrive after the
 * native menu closes, so the field's focus and selection are put back first,
 * and edits go through `execCommand("insertText")`, which fires the `input`
 * event React's onChange listens to (setting `.value` would not).
 */
function textMenu(el: Editable): MenuEntry[] {
  const t = i18n.getFixedT(null, "common");
  // Number fields have no selection API: treat them as all-or-nothing.
  const hasRange = el.selectionStart !== null;
  const start = hasRange ? el.selectionStart! : 0;
  const end = hasRange ? el.selectionEnd! : el.value.length;
  const selected = el.value.slice(start, end);
  const secret = el instanceof HTMLInputElement && el.type === "password";
  const readOnly = el.readOnly || el.disabled;

  const restore = () => {
    el.focus();
    if (hasRange) el.setSelectionRange(start, end);
    else el.select();
  };
  const insert = (text: string) => {
    restore();
    document.execCommand(text ? "insertText" : "delete", false, text);
  };

  return [
    {
      label: t("contextMenu.cut"),
      enabled: !!selected && !secret && !readOnly,
      action: () => void writeText(selected).then(() => insert("")),
    },
    {
      label: t("contextMenu.copy"),
      enabled: !!selected && !secret,
      action: () => void writeText(selected),
    },
    {
      label: t("contextMenu.paste"),
      enabled: !readOnly,
      action: () =>
        void readText()
          .then((text) => text && insert(text))
          .catch(() => {}),
    },
    "separator",
    {
      label: t("contextMenu.selectAll"),
      enabled: !!el.value,
      action: () => {
        el.focus();
        el.select();
      },
    },
  ];
}

/**
 * Window-level fallback, after components had their turn (bubble phase, so a
 * row's own menu has already called `preventDefault`): text fields get the
 * edit menu, selected text gets Copy, everything else gets nothing.
 */
export function installContextMenuGuard(): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented || wantsWebviewMenu(e)) return;
    e.preventDefault();
    const field = editableTarget(e.target);
    if (field) {
      void popup(textMenu(field), e.clientX, e.clientY);
      return;
    }
    const selection = window.getSelection()?.toString() ?? "";
    if (selection) {
      const t = i18n.getFixedT(null, "common");
      void popup([{ label: t("contextMenu.copy"), action: () => void writeText(selection) }], e.clientX, e.clientY);
    }
  };
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
