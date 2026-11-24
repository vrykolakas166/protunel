import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatTimestamp } from "../../format";
import type { FileEntry } from "../../types";
import { isDirLike, joinPath, modeString, viewKind, type SortKey } from "./paths";
import { nextSort } from "./panelLogic";
import { ROW, type Clip } from "./panelStore";

type Sort = { key: SortKey; desc: boolean };

/** Column heads (click to sort) and the virtual list of rows. */
export function FileRows({
  attachList,
  visible,
  first,
  last,
  path,
  home,
  tunnelId,
  loading,
  error,
  filter,
  selected,
  cursor,
  clipboard,
  hoverDir,
  preparing,
  sort,
  setSort,
  columns,
  wide,
  details,
  onKeyDown,
  onScroll,
  onBackgroundMenu,
  onRetry,
  onRowPointerDown,
  onRowMouseDown,
  onRowOpen,
  onRowMenu,
}: {
  attachList: (el: HTMLDivElement | null) => void;
  visible: FileEntry[];
  first: number;
  last: number;
  path: string | null;
  home: string;
  tunnelId: string;
  loading: boolean;
  error: string | null;
  filter: string;
  selected: Set<string>;
  cursor: number;
  clipboard: Clip | null;
  /** The folder a drag is over (row drag or OS drag), if any. */
  hoverDir: string | null;
  preparing: string[] | null;
  sort: Sort;
  setSort: (s: Sort) => void;
  columns: boolean;
  wide: boolean;
  details: string | null;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onScroll: (scrollTop: number) => void;
  onBackgroundMenu: (e: ReactMouseEvent) => void;
  onRetry: (dir: string) => void;
  onRowPointerDown: (e: ReactPointerEvent<HTMLElement>, entry: FileEntry, index: number, isSelected: boolean) => void;
  onRowMouseDown: (e: ReactMouseEvent, index: number, isSelected: boolean) => void;
  onRowOpen: (entry: FileEntry) => void;
  onRowMenu: (e: ReactMouseEvent, entry: FileEntry, index: number) => void;
}) {
  const { t } = useTranslation("terminal");
  const current = visible[cursor];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Column heads: click to sort. */}
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] uppercase tracking-wide text-muted">
        <SortHead label={t("files.col.name")} k="name" sort={sort} setSort={setSort} className="min-w-0 flex-1" />
        <SortHead label={t("files.col.size")} k="size" sort={sort} setSort={setSort} className="w-16 text-right" />
        {columns && <SortHead label={t("files.col.modified")} k="mtime" sort={sort} setSort={setSort} className="w-28" />}
        {wide && !details && <span className="w-20">{t("files.col.mode")}</span>}
      </div>
      <div
        ref={attachList}
        tabIndex={0}
        role="listbox"
        data-file-drop=""
        aria-multiselectable="true"
        aria-label={t("files.listLabel", { path: path ?? "" })}
        aria-activedescendant={current ? `file-row-${cursor}` : undefined}
        onKeyDown={onKeyDown}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("[data-file-row]")) return;
          onBackgroundMenu(e);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none"
      >
        {error ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-xs">
            <p className="text-coral">{error}</p>
            <button onClick={() => onRetry(path ?? home)} className="rounded border border-border px-2.5 py-1 text-text hover:bg-surface-hover">
              {t("files.retry")}
            </button>
          </div>
        ) : visible.length === 0 && !loading ? (
          <p className="p-6 text-center text-xs text-muted">{filter ? t("files.noMatch") : t("files.emptyFolder")}</p>
        ) : (
          <div style={{ height: visible.length * ROW }} className="relative">
            {visible.slice(first, last).map((entry, i) => {
              const index = first + i;
              const isSelected = selected.has(entry.name);
              const isCursor = index === cursor;
              const cut = clipboard?.cut && clipboard.tunnelId === tunnelId && path && clipboard.paths.includes(joinPath(path, entry.name));
              const dropping = hoverDir !== null && path !== null && hoverDir === joinPath(path, entry.name);
              return (
                <div
                  key={entry.name}
                  id={`file-row-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-file-row={entry.name}
                  onPointerDown={(e) => onRowPointerDown(e, entry, index, isSelected)}
                  onMouseDown={(e) => onRowMouseDown(e, index, isSelected)}
                  onDoubleClick={() => onRowOpen(entry)}
                  onContextMenu={(e) => onRowMenu(e, entry, index)}
                  className={`absolute left-0 right-0 flex cursor-default items-center gap-2 px-3 text-xs ${
                    dropping
                      ? "bg-accent/25 ring-1 ring-inset ring-accent"
                      : isSelected
                        ? "bg-accent/15 text-text"
                        : "text-text hover:bg-surface-hover"
                  } ${isCursor ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""} ${
                    cut || (preparing && path && preparing.includes(joinPath(path, entry.name))) ? "opacity-50" : ""
                  }`}
                  style={{ top: index * ROW, height: ROW }}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <EntryIcon entry={entry} />
                    <span className={`truncate ${entry.name.startsWith(".") ? "text-muted" : ""}`}>{entry.name}</span>
                    {entry.kind === "symlink" && <span className="shrink-0 text-[10px] text-muted">↪</span>}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted">
                    {isDirLike(entry) ? "" : formatBytes(entry.size)}
                  </span>
                  {columns && (
                    <span className="w-28 shrink-0 truncate text-[11px] text-muted">
                      {entry.mtime !== null ? formatTimestamp(entry.mtime) : ""}
                    </span>
                  )}
                  {wide && !details && (
                    <span className="w-20 shrink-0 font-mono text-[11px] text-muted">{modeString(entry.mode)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {loading && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-accent" />
        )}
      </div>
    </div>
  );
}

function SortHead({
  label,
  k,
  sort,
  setSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: Sort;
  setSort: (s: Sort) => void;
  className: string;
}) {
  const active = sort.key === k;
  return (
    <button
      onClick={() => setSort(nextSort(sort, k))}
      className={`${className} shrink-0 truncate text-left uppercase hover:text-text ${active ? "text-text" : ""}`}
    >
      {label}
      {active && <span className="ml-0.5">{sort.desc ? "↓" : "↑"}</span>}
    </button>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (isDirLike(entry)) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 text-accent" aria-hidden="true">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  const kind = viewKind(entry.name);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className={`shrink-0 ${kind === "image" ? "text-amber" : "text-muted"}`} aria-hidden="true">
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6ZM9 2v4h4" />
      {kind === "text" && <path d="M5.5 9h5M5.5 11h3.5" strokeLinecap="round" />}
    </svg>
  );
}
