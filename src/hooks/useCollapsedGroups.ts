import { useCallback, useState } from "react";
import { loadCollapsedGroups, saveCollapsedGroups, toggleSections } from "../groups";

/**
 * Collapsed group sections, remembered per window under `storageKey`.
 * `toggle(name, all)` flips one section; `all` (Ctrl+click on a header) makes
 * every listed section follow the clicked one.
 */
export function useCollapsedGroups(storageKey: string) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsedGroups(storageKey));
  const toggle = useCallback(
    (name: string | null, all?: (string | null)[]) =>
      setCollapsed((current) => {
        const next = toggleSections(current, name, all);
        saveCollapsedGroups(storageKey, next);
        return next;
      }),
    [storageKey],
  );
  return [collapsed, toggle] as const;
}
