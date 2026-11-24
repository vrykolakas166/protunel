export type SelectMode = "only" | "toggle" | "range";

/**
 * Row selection in the file list. `names` is the visible order; `index` the
 * clicked row. "only" selects it, "toggle" flips it, "range" selects from the
 * anchor to it. Only/toggle move the anchor; range keeps it.
 * An out-of-range index changes nothing.
 */
export function applySelection(
  names: readonly string[],
  selected: ReadonlySet<string>,
  anchor: number,
  index: number,
  mode: SelectMode,
): { selected: Set<string>; anchor: number } {
  const name = names[index];
  if (name === undefined) return { selected: new Set(selected), anchor };
  if (mode === "only") return { selected: new Set([name]), anchor: index };
  if (mode === "toggle") {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return { selected: next, anchor: index };
  }
  const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
  return { selected: new Set(names.slice(a, b + 1)), anchor };
}
