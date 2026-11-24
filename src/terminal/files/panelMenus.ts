import type { TFunction } from "i18next";
import type { MenuEntry } from "../../contextMenu";
import type { FileEntry } from "../../types";
import { isDirLike } from "./paths";

/** Entries of the right-click menu on a row. */
export function rowMenuEntries(
  t: TFunction,
  a: {
    entry: FileEntry;
    many: boolean;
    full: string;
    canPaste: boolean;
    open: () => void;
    download: () => void;
    downloadTo: () => void;
    openLocal: () => void;
    copy: () => void;
    cut: () => void;
    paste: () => void;
    rename: () => void;
    copyPath: () => void;
    properties: () => void;
    del: () => void;
  },
): MenuEntry[] {
  const { entry, many } = a;
  return [
    { label: isDirLike(entry) ? t("files.menu.openFolder") : t("files.menu.open"), action: a.open, enabled: !many },
    { label: t("files.download"), action: a.download },
    { label: t("files.downloadTo"), action: a.downloadTo },
    { label: t("files.openLocal"), action: a.openLocal, enabled: !many && !isDirLike(entry) },
    "separator",
    { label: t("files.menu.copy"), action: a.copy },
    { label: t("files.menu.cut"), action: a.cut },
    { label: t("files.menu.paste"), action: a.paste, enabled: a.canPaste },
    "separator",
    { label: t("files.menu.rename"), action: a.rename, enabled: !many },
    { label: t("files.copyPath"), action: a.copyPath, enabled: !many },
    { label: t("files.menu.properties"), action: a.properties, enabled: !many },
    "separator",
    { label: t("files.menu.delete"), action: a.del },
  ];
}

/** Entries of the right-click menu on the list's empty area. */
export function backgroundMenuEntries(
  t: TFunction,
  a: {
    path: string | null;
    canPaste: boolean;
    showHidden: boolean;
    newDir: () => void;
    newFile: () => void;
    paste: () => void;
    upload: () => void;
    refresh: () => void;
    toggleHidden: () => void;
    copyPath: (p: string) => void;
  },
): MenuEntry[] {
  const { path } = a;
  return [
    { label: t("files.newFolder"), action: a.newDir },
    { label: t("files.newFile"), action: a.newFile },
    { label: t("files.menu.paste"), action: a.paste, enabled: a.canPaste },
    "separator",
    { label: t("files.upload"), action: a.upload },
    { label: t("files.refresh"), action: a.refresh },
    { label: t("files.showHidden"), checked: a.showHidden, action: a.toggleHidden },
    ...(path ? ([{ label: t("files.copyPath"), action: () => a.copyPath(path) }] as MenuEntry[]) : []),
  ];
}
