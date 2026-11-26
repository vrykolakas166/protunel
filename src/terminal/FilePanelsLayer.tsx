import type { FileTransfer, Tunnel } from "../types";
import { FilePanel, type FilePanelHandle, type PaneFiles } from "./files/FilePanel";
import type { Box, FilesGeometry } from "./files/geometry";
import type { PaneHandle, SessionInfo } from "./TerminalView";
import type { PanelItem } from "./useFilePanels";

interface Props {
  panels: PanelItem[];
  filesRefs: { current: Map<string, FilePanelHandle> };
  filesMemory: { current: Map<string, PaneFiles> };
  paneHandles: { current: Map<string, PaneHandle> };
  infos: Record<string, SessionInfo>;
  windowBox: Box;
  transfers: FileTransfer[];
  byId: Record<string, Tunnel>;
  clearFinished: (tunnelId?: string) => void;
  dropHover: { x: number; y: number; paneId: string } | null;
  raiseFiles: (paneId: string) => void;
  setGeometry: (paneId: string, geo: FilesGeometry) => void;
  shellFor: (tunnelId: string, preferPaneId?: string) => string | null;
  shellAlive: (termId: string, tunnelId: string) => boolean;
  closeFiles: (paneId: string) => void;
  focusFilesOwner: (paneId: string) => void;
  setDirtyPanes: (update: (prev: Set<string>) => Set<string>) => void;
}

/**
 * Every open file panel, rendered outside `PaneLayer` (moving one never
 * re-renders a terminal). The DOM order is `filesOpen`'s and never changes.
 */
export function FilePanelsLayer({
  panels,
  filesRefs,
  filesMemory,
  paneHandles,
  infos,
  windowBox,
  transfers,
  byId,
  clearFinished,
  dropHover,
  raiseFiles,
  setGeometry,
  shellFor,
  shellAlive,
  closeFiles,
  focusFilesOwner,
  setDirtyPanes,
}: Props) {
  return (
    <>
      {panels.map(({ paneId, tunnel, owner, geo, box, shown, z }) => (
        <div key={paneId} hidden={!shown} inert={!shown}>
          <FilePanel
            ref={(handle) => {
              if (handle) filesRefs.current.set(paneId, handle);
              else filesRefs.current.delete(paneId);
            }}
            paneId={paneId}
            z={z}
            onRaise={() => raiseFiles(paneId)}
            maximized={!!geo.maximized}
            onToggleMaximize={() => setGeometry(paneId, { ...geo, maximized: !geo.maximized })}
            tunnel={tunnel}
            target={infos[paneId]?.target ?? `${tunnel.username}@${tunnel.host}:${tunnel.port}`}
            box={box}
            owner={owner}
            bounds={windowBox}
            placement={geo.placement}
            onPlacement={(placement, size) => setGeometry(paneId, { placement, size, maximized: false })}
            memory={filesMemory.current.get(paneId)}
            onMemory={(m) => filesMemory.current.set(paneId, m)}
            shellDir={() => paneHandles.current.get(paneId)?.cwd() ?? null}
            shellFor={shellFor}
            shellAlive={shellAlive}
            transfers={transfers}
            byId={byId}
            onClearTransfers={clearFinished}
            dropHover={dropHover?.paneId === paneId ? dropHover : null}
            onClose={() => closeFiles(paneId)}
            onFocusShell={() => focusFilesOwner(paneId)}
            onUnsaved={(dirty) =>
              setDirtyPanes((prev) => {
                if (prev.has(paneId) === dirty) return prev;
                const next = new Set(prev);
                if (dirty) next.add(paneId);
                else next.delete(paneId);
                return next;
              })
            }
          />
        </div>
      ))}
    </>
  );
}
