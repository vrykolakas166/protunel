// Which file panels hold an editor with unsaved changes (pure; tests/unsaved.test.ts).

import { baseName } from "./paths";

export interface Unsaved {
  paneId: string;
  /** Remote path of the edited file. */
  path: string;
}

/** The panes among `paneIds` whose panel has unsaved edits, in the given order.
 * `probe` returns the dirty file's path for a pane, or null. */
export function collectUnsaved(paneIds: readonly string[], probe: (paneId: string) => string | null): Unsaved[] {
  const seen = new Set<string>();
  const out: Unsaved[] = [];
  for (const paneId of paneIds) {
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    const path = probe(paneId);
    if (path) out.push({ paneId, path });
  }
  return out;
}

/** "user@host: a.txt, b.conf" lines for the confirmation, one per file. */
export function describeUnsaved(items: readonly Unsaved[], whereOf: (paneId: string) => string): string[] {
  return items.map((x) => `${whereOf(x.paneId)}: ${baseName(x.path)}`);
}
