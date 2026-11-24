import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { crumbs, resolvePath } from "./paths";
import { iconButton } from "./PanelHeader";

/** Toolbar: where we are, and what can be done here. */
export function PanelToolbar({
  path,
  home,
  pathEdit,
  setPathEdit,
  pathInputRef,
  filterRef,
  filter,
  onFilter,
  onFilterEnter,
  canDownload,
  load,
  goUp,
  goShellDir,
  refresh,
  upload,
  download,
  downloadTo,
  newDir,
  newFile,
  focusList,
}: {
  path: string | null;
  home: string;
  pathEdit: string | null;
  setPathEdit: (v: string | null) => void;
  pathInputRef: RefObject<HTMLInputElement | null>;
  filterRef: RefObject<HTMLInputElement | null>;
  filter: string;
  onFilter: (v: string) => void;
  /** Enter in the filter box: select the first row (if any). */
  onFilterEnter: () => void;
  canDownload: boolean;
  load: (dir: string) => unknown;
  goUp: () => void;
  goShellDir: () => unknown;
  refresh: () => void;
  upload: () => void;
  download: () => void;
  downloadTo: () => void;
  newDir: () => void;
  newFile: () => void;
  focusList: () => void;
}) {
  const { t } = useTranslation("terminal");
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
      <button onClick={goUp} disabled={!path || path === "/"} className={iconButton} title={t("files.up")} aria-label={t("files.up")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
        </svg>
      </button>
      {pathEdit !== null ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const next = resolvePath(pathEdit, path ?? home, home);
            setPathEdit(null);
            void load(next);
            focusList();
          }}
        >
          <input
            ref={pathInputRef}
            autoFocus
            value={pathEdit}
            onChange={(e) => setPathEdit(e.target.value)}
            onBlur={() => setPathEdit(null)}
            spellCheck={false}
            className="w-full rounded border border-accent bg-bg px-2 py-0.5 font-mono text-xs text-text outline-none"
          />
        </form>
      ) : (
        <nav
          aria-label={t("files.path")}
          onDoubleClick={() => setPathEdit(path ?? "")}
          title={t("files.pathHint")}
          className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-xs"
        >
          {path &&
            crumbs(path).map((c, i, all) => (
              <span key={c.path} className={`flex min-w-0 items-center ${i < all.length - 2 ? "shrink" : "shrink-0"}`}>
                {i > 1 && <span className="px-0.5 text-muted">/</span>}
                <button
                  onClick={() => void load(c.path)}
                  className={`truncate rounded px-1 py-0.5 hover:bg-surface-hover ${i === all.length - 1 ? "text-text" : "text-muted hover:text-text"}`}
                >
                  {c.name}
                </button>
              </span>
            ))}
        </nav>
      )}
      <button onClick={() => void goShellDir()} className={iconButton} title={t("files.shellDir")} aria-label={t("files.shellDir")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M4.5 6.5l2 1.5-2 1.5M8 10h3" />
        </svg>
      </button>
      <button onClick={() => void load(home)} className={iconButton} title={t("files.home", { home })} aria-label={t("files.homeLabel")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 7.5L8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5Z" />
        </svg>
      </button>
      <button onClick={refresh} className={iconButton} title={`${t("files.refresh")} (F5)`} aria-label={t("files.refresh")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />
        </svg>
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button onClick={newDir} className={iconButton} title={`${t("files.newFolder")} (Ctrl+Shift+N)`} aria-label={t("files.newFolder")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5ZM8 7v4M6 9h4" />
        </svg>
      </button>
      <button onClick={newFile} className={iconButton} title={t("files.newFile")} aria-label={t("files.newFile")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6ZM9 2v4h4M8 8v4M6 10h4" />
        </svg>
      </button>
      <button onClick={upload} className={iconButton} title={t("files.uploadHint")} aria-label={t("files.upload")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" />
        </svg>
      </button>
      <button onClick={download} disabled={!canDownload} className={iconButton} title={t("files.downloadHint")} aria-label={t("files.download")}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10" />
        </svg>
      </button>
      <button onClick={downloadTo} disabled={!canDownload} className={iconButton} title={t("files.downloadTo")} aria-label={t("files.downloadTo")}>
        <svg width="9" height="13" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 6l3 3 3-3" />
        </svg>
      </button>
      <input
        ref={filterRef}
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            focusList();
            if (e.key === "Enter") onFilterEnter();
          }
        }}
        placeholder={t("files.filter")}
        aria-label={t("files.filter")}
        spellCheck={false}
        className="ml-1 hidden w-28 rounded border border-border bg-bg px-2 py-0.5 text-xs text-text outline-none placeholder:text-muted focus:border-accent @min-[600px]:block"
      />
    </div>
  );
}
