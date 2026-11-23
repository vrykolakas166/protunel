// One remote file in the panel: text in the editor (saved back over SFTP),
// an image, or what to do with a file that can't be shown.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filesReadImage, filesReadText, filesSaveDraft, filesWriteText } from "../../api";
import { formatBytes } from "../../format";
import type { FileContent } from "../../types";
import type { Editor } from "./editor";
import { baseName, imageMime, viewKind } from "./paths";

export interface FileViewHandle {
  dirty: () => boolean;
  /** Saves; false when it could not (conflict, lost session…). */
  save: () => Promise<boolean>;
}

interface Props {
  tunnelId: string;
  path: string;
  /** user@host, named in every warning. */
  where: string;
  onBack: () => void;
  onDownload: () => void;
  onOpenLocal: () => void;
  onSaved: () => void;
  /** Unsaved edits appeared or went away (false again when the view unmounts). */
  onDirty?: (dirty: boolean) => void;
  errorText: (e: unknown) => string;
}

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "image"; url: string; size: number }
  | FileContent;

export const FileView = forwardRef<FileViewHandle, Props>(function FileView(
  { tunnelId, path, where, onBack, onDownload, onOpenLocal, onSaved, onDirty, errorText },
  ref,
) {
  const { t } = useTranslation("terminal");
  const name = baseName(path);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Save problem: the file changed on the server, or saving failed. */
  const [problem, setProblem] = useState<{ kind: "conflict" } | { kind: "failed"; message: string } | null>(null);
  const [wrap, setWrap] = useState(() => readWrap());
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  /** What the file looked like when read or last saved: the conflict check. */
  const base = useRef<{ size: number; mtime: number | null }>({ size: 0, mtime: null });
  const original = useRef("");

  const load = async (tail: boolean) => {
    setLoaded({ kind: "loading" });
    setProblem(null);
    try {
      if (viewKind(name) === "image") {
        const bytes = await filesReadImage(tunnelId, path);
        const url = URL.createObjectURL(new Blob([bytes], { type: imageMime(name) }));
        setLoaded({ kind: "image", url, size: bytes.byteLength });
        return;
      }
      const content = await filesReadText(tunnelId, path, tail);
      if (content.kind === "text") {
        base.current = { size: content.size, mtime: content.mtime };
        original.current = content.text;
        setDirty(false);
      }
      setLoaded(content);
    } catch (e) {
      const message = errorText(e);
      setLoaded({ kind: "error", message: e === "too-large" ? t("files.view.imageTooLarge") : message });
    }
  };

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelId, path]);

  // Image blob URLs are freed when the view changes.
  useEffect(() => () => {
    if (loaded.kind === "image") URL.revokeObjectURL(loaded.url);
  }, [loaded]);

  const textReady = loaded.kind === "text";
  const tail = loaded.kind === "text" && loaded.tail;
  const textValue = loaded.kind === "text" ? loaded.text : "";

  // The editor mounts once the text is in; reloading the same file resets it.
  useEffect(() => {
    if (!textReady || !host.current) return;
    let cancelled = false;
    let made: Editor | null = null;
    void import("./editor").then(async ({ createEditor }) => {
      if (cancelled || !host.current) return;
      made = await createEditor(host.current, {
        text: textValue,
        name,
        readOnly: tail,
        wrap: wrapRef.current,
        onChange: (text) => setDirty(text !== original.current),
        onSave: () => void saveRef.current(false),
      });
      if (cancelled) {
        made.destroy();
        return;
      }
      editor.current = made;
      made.focus();
    });
    return () => {
      cancelled = true;
      made?.destroy();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textReady, textValue, tail]);

  useEffect(() => editor.current?.setWrap(wrap), [wrap]);

  const save = async (force: boolean): Promise<boolean> => {
    const ed = editor.current;
    if (!ed || tail) return false;
    const text = ed.text();
    setSaving(true);
    try {
      const saved = await filesWriteText(tunnelId, path, text, base.current.size, base.current.mtime, force);
      base.current = saved;
      original.current = text;
      // Typing while the save was in flight is still unsaved.
      setDirty((editor.current?.text() ?? text) !== text);
      setProblem(null);
      onSaved();
      return true;
    } catch (e) {
      if (e === "conflict") setProblem({ kind: "conflict" });
      else setProblem({ kind: "failed", message: errorText(e) });
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);

  useImperativeHandle(ref, () => ({ dirty: () => dirty, save:() => saveRef.current(false) }), [dirty]);

  const toggleWrap = () => {
    setWrap((w) => {
      writeWrap(!w);
      return !w;
    });
  };

  const button = "rounded px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-40";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <button onClick={onBack} className={`${button} text-muted hover:text-text`} title={t("files.view.back")}>
          ← {t("files.view.back")}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={path}>
          {name}
          {dirty && <span className="ml-1 text-amber">●</span>}
          {tail && <span className="ml-2 rounded bg-amber/15 px-1 font-sans text-[10px] text-amber">{t("files.view.tailBadge")}</span>}
        </span>
        {loaded.kind === "text" && (
          <>
            <span className="hidden text-[10px] text-muted @min-[600px]:inline">{formatBytes(loaded.size)}</span>
            <button onClick={toggleWrap} className={`${button} ${wrap ? "text-accent" : "text-muted hover:text-text"}`} aria-pressed={wrap}>
              {t("files.view.wrap")}
            </button>
            {!tail && (
              <>
                <button
                  onClick={() => editor.current?.reset(original.current)}
                  disabled={!dirty || saving}
                  className={`${button} text-muted hover:text-text`}
                >
                  {t("files.view.revert")}
                </button>
                <button
                  onClick={() => void save(false)}
                  disabled={!dirty || saving}
                  title="Ctrl+S"
                  className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
                >
                  {saving ? t("files.view.saving") : t("files.view.save")}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {problem && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-amber/10 px-3 py-1.5 text-xs text-text">
          <span className="min-w-0 flex-1">
            {problem.kind === "conflict" ? t("files.view.conflict", { where }) : t("files.view.saveFailed", { message: problem.message })}
          </span>
          {problem.kind === "conflict" && (
            <>
              <button onClick={() => void save(true)} className={`${button} text-coral`}>
                {t("files.view.overwrite")}
              </button>
              <button onClick={() => void load(false)} className={`${button} text-muted hover:text-text`}>
                {t("files.view.reloadDiscard")}
              </button>
            </>
          )}
          <button
            onClick={() => editor.current && void filesSaveDraft(name, editor.current.text()).catch(() => {})}
            className={`${button} text-accent`}
          >
            {t("files.view.saveDraft")}
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loaded.kind === "loading" && <p className="p-4 text-xs text-muted">{t("files.loading")}</p>}
        {loaded.kind === "text" && <div ref={host} className="absolute inset-0" />}
        {loaded.kind === "image" && (
          <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--color-surface-hover)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
            <img src={loaded.url} alt={name} className="max-h-full max-w-full object-contain shadow" />
          </div>
        )}
        {(loaded.kind === "binary" || loaded.kind === "tooLarge" || loaded.kind === "error") && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-text">
              {loaded.kind === "binary"
                ? t("files.view.binary", { size: formatBytes(loaded.size) })
                : loaded.kind === "tooLarge"
                  ? t("files.view.tooLarge", { size: formatBytes(loaded.size) })
                  : loaded.message}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {loaded.kind === "tooLarge" && (
                <button onClick={() => void load(true)} className="rounded border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-hover">
                  {t("files.view.showTail")}
                </button>
              )}
              {loaded.kind !== "error" && (
                <>
                  <button onClick={onOpenLocal} className="rounded border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-hover">
                    {t("files.openLocal")}
                  </button>
                  <button onClick={onDownload} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover">
                    {t("files.download")}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

const WRAP_KEY = "protunel.files.wrap";
function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeWrap(on: boolean) {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    // Only a preference.
  }
}
