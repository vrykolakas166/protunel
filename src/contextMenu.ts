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

/** `checked` (true or false) makes the entry a check item. */
export type MenuEntry =
  | { label: string; action: () => void; enabled?: boolean; checked?: boolean }
  | "separator";

/** Shift + right-click in a dev build: leave the webview menu alone. */
const wantsWebviewMenu = (e: MouseEvent | ReactMouseEvent) => import.meta.env.DEV && e.shiftKey;

/**
 * Every `Menu.new` is a native menu held in the window's Rust resource table,
 * plus one IPC channel per item, until it is closed; the windows live for
 * days (they hide instead of closing), so menus are closed, never left to
 * pile up. Not right after `popup` resolves: on Linux it resolves while the
 * menu is still open, and on Windows the click is delivered after it. A menu
 * is closed once its chosen action has run, and in any case when the next
 * one opens (a new right-click means the old menu is gone). At most one is
 * alive per window.
 */
let live: Menu | null = null;
/** Bumped per right-click, so a menu that finished building late never shows. */
let generation = 0;

function release(menu: Menu) {
  if (live === menu) live = null;
  void menu.close().catch(() => {});
}

async function popup(entries: MenuEntry[], x: number, y: number) {
  if (live) release(live);
  const mine = ++generation;
  let menu: Menu | null = null;
  // The action runs first; the menu (and its channels) goes after, so the
  // close can never race the click it delivered.
  const run = (action: () => void) => () => {
    try {
      action();
    } finally {
      if (menu) {
        const done = menu;
        window.setTimeout(() => release(done), 0);
      }
    }
  };
  const items = entries.map((entry) =>
    entry === "separator"
      ? { item: "Separator" as const }
      : entry.checked !== undefined
        ? { text: entry.label, enabled: entry.enabled ?? true, checked: entry.checked, action: run(entry.action) }
        : { text: entry.label, enabled: entry.enabled ?? true, action: run(entry.action) },
  );
  menu = await Menu.new({ items });
  // A later right-click started while this one was being built: it wins,
  // whichever finishes first.
  if (mine !== generation) {
    release(menu);
    return;
  }
  if (live) release(live);
  live = menu;
  try {
    await menu.popup(new LogicalPosition(x, y));
  } catch {
    release(menu);
  }
}

/** Opens `entries` at the pointer. Returns false (doing nothing) for Shift in dev. */
/** A menu dropped down from a button (mouse or keyboard alike), at its bottom-left corner. */
export function openMenuBelow(button: Element, entries: MenuEntry[]): void {
  const box = button.getBoundingClientRect();
  void popup(entries, box.left, box.bottom);
}

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
