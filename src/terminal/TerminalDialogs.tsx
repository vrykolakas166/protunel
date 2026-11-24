import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import type { Workspace } from "../types";
import { describeUnsaved } from "./files/unsaved";
import { paneIds } from "./layout";
import { saveWorkspace } from "./memory";
import type { Tab } from "./tabs";
import type { PendingUnsaved } from "./useUnsavedGuard";

export interface PendingPaste {
  targets: number;
  lines: number;
  resolve: (ok: boolean) => void;
}

export interface Naming {
  name: string;
  id: string | null;
}

interface Props {
  naming: Naming | null;
  setNaming: (naming: Naming | null) => void;
  namedWorkspaces: Workspace[];
  tabs: Tab[];
  commitWorkspace: () => void;
  pendingPaste: PendingPaste | null;
  setPendingPaste: (pending: PendingPaste | null) => void;
  pendingUnsaved: PendingUnsaved | null;
  setPendingUnsaved: (pending: PendingUnsaved | null) => void;
  saveAllUnsaved: (pending: PendingUnsaved) => Promise<void>;
  whereOf: (paneId: string) => string;
  refocus: () => void;
}

/** The window's modal prompts: save workspace, multi-shell paste, unsaved editors. */
export function TerminalDialogs({
  naming,
  setNaming,
  namedWorkspaces,
  tabs,
  commitWorkspace,
  pendingPaste,
  setPendingPaste,
  pendingUnsaved,
  setPendingUnsaved,
  saveAllUnsaved,
  whereOf,
  refocus,
}: Props) {
  const { t } = useTranslation("terminal");
  return (
    <>
      {naming && (
        <Modal title={naming.id ? t("workspace.renameTitle") : t("workspace.saveTitle")} onClose={() => setNaming(null)} size="sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (naming.id) {
                const workspace = namedWorkspaces.find((w) => w.id === naming.id);
                if (workspace && naming.name.trim()) saveWorkspace({ ...workspace, name: naming.name.trim() });
                setNaming(null);
                refocus();
              } else commitWorkspace();
            }}
            className="space-y-3"
          >
            {!naming.id && (
              <p className="text-sm text-muted">
                {t("workspace.saveHint", { tabs: tabs.length, panes: tabs.reduce((n, tab) => n + paneIds(tab.root).length, 0) })}
              </p>
            )}
            <input
              autoFocus
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
              placeholder={t("workspace.namePlaceholder")}
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNaming(null)}
                className="rounded px-3 py-1.5 text-sm text-muted hover:bg-surface-hover hover:text-text"
              >
                {t("workspace.cancel")}
              </button>
              <button
                type="submit"
                disabled={!naming.name.trim()}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {t("workspace.saveButton")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingPaste && (
        <ConfirmDialog
          title={t("pasteConfirmTitle")}
          message={t("pasteConfirmMessage", {
            lines: pendingPaste.lines,
            targets: pendingPaste.targets,
          })}
          confirmLabel={t("pasteConfirm")}
          tone="danger"
          onConfirm={() => {
            pendingPaste.resolve(true);
            setPendingPaste(null);
            refocus();
          }}
          onCancel={() => {
            pendingPaste.resolve(false);
            setPendingPaste(null);
            refocus();
          }}
        />
      )}
      {pendingUnsaved && (
        <Modal
          title={<h2 className="font-display text-base font-semibold text-text">{t("unsavedClose.title")}</h2>}
          onClose={() => {
            pendingUnsaved.resolve(false);
            setPendingUnsaved(null);
          }}
          size="sm"
          borderClassName="border-coral/40"
          dismissible={false}
        >
          <p className="text-sm text-muted">{t("unsavedClose.message")}</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-text">
            {describeUnsaved(pendingUnsaved.items, whereOf).map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
          {pendingUnsaved.failed && <p className="mt-2 text-sm text-coral">{t("unsavedClose.saveFailed")}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => {
                pendingUnsaved.resolve(false);
                setPendingUnsaved(null);
              }}
              className="rounded px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              {t("unsavedClose.cancel")}
            </button>
            <button
              onClick={() => {
                pendingUnsaved.resolve(true);
                setPendingUnsaved(null);
              }}
              className="rounded px-3 py-1.5 text-xs text-coral hover:bg-coral/10"
            >
              {t("unsavedClose.discard")}
            </button>
            <button
              autoFocus
              onClick={() => void saveAllUnsaved(pendingUnsaved)}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
            >
              {t("unsavedClose.save")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
