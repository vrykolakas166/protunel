import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { FileEntry } from "../../types";
import { jumpIndex, pageRows, stepCursor } from "./panelLogic";
import { ROW, type NameBarState } from "./panelStore";
import { joinPath } from "./paths";

/** Everything the list's keyboard handling reads or calls. */
export interface ListKeyContext {
  visible: FileEntry[];
  cursor: number;
  current: FileEntry | undefined;
  path: string | null;
  listHeight: number;
  filterRef: RefObject<HTMLInputElement | null>;
  selectAt: (index: number, mode: "only" | "toggle" | "range") => void;
  open: (entry: FileEntry) => void;
  goUp: () => void;
  /** Back (-1) / Forward (+1) through the panel's folders. */
  go: (delta: -1 | 1) => void;
  refresh: () => void;
  askDelete: () => void;
  paste: () => Promise<void>;
  copyToClipboard: (cut: boolean) => void;
  setDetails: (path: string) => void;
  setNameBar: (bar: NameBarState) => void;
  selectAll: () => void;
  setPathEdit: (value: string) => void;
}

export function handleListKey(e: ReactKeyboardEvent, c: ListKeyContext) {
  const { visible, cursor, current, path } = c;
  const mod = e.ctrlKey || e.metaKey;
  const step = (delta: number) => {
    e.preventDefault();
    const next = stepCursor(cursor, delta, visible.length);
    c.selectAt(next, e.shiftKey ? "range" : "only");
  };
  switch (true) {
    case e.key === "ArrowDown":
      return step(1);
    case e.key === "ArrowUp" && !e.altKey:
      return step(-1);
    case e.key === "PageDown":
      return step(pageRows(c.listHeight, ROW));
    case e.key === "PageUp":
      return step(-pageRows(c.listHeight, ROW));
    case e.key === "Home":
      return step(-visible.length);
    case e.key === "End":
      return step(visible.length);
    case e.key === "Enter" && e.altKey:
      e.preventDefault();
      if (current && path) c.setDetails(joinPath(path, current.name));
      return;
    case e.key === "Enter":
      e.preventDefault();
      if (current) c.open(current);
      return;
    case (e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !mod && !e.shiftKey:
      e.preventDefault();
      c.go(e.key === "ArrowLeft" ? -1 : 1);
      return;
    case e.key === "Backspace" || (e.key === "ArrowUp" && e.altKey):
      e.preventDefault();
      c.goUp();
      return;
    case e.key === "F2":
      e.preventDefault();
      if (current) c.setNameBar({ kind: "rename", from: current.name, value: current.name });
      return;
    case e.key === "F5":
      e.preventDefault();
      c.refresh();
      return;
    case e.key === "Delete":
      e.preventDefault();
      c.askDelete();
      return;
    case mod && e.shiftKey && e.key.toLowerCase() === "n":
      e.preventDefault();
      c.setNameBar({ kind: "dir", value: "" });
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "a":
      e.preventDefault();
      c.selectAll();
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "c":
      e.preventDefault();
      c.copyToClipboard(false);
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "x":
      e.preventDefault();
      c.copyToClipboard(true);
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "v":
      e.preventDefault();
      void c.paste();
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "l":
      e.preventDefault();
      c.setPathEdit(path ?? "");
      return;
    case mod && !e.shiftKey && e.key.toLowerCase() === "f":
      e.preventDefault();
      c.filterRef.current?.focus();
      return;
    case !mod && !e.altKey && e.key.length === 1 && e.key !== " ":
      // Type to jump: the next name starting with that letter.
      {
        const hit = jumpIndex(visible.map((x) => x.name), cursor, e.key);
        if (hit >= 0) c.selectAt(hit, "only");
      }
      return;
  }
}
