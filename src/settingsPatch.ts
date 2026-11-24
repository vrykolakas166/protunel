/** Top-level changes between two JSON settings snapshots. */
export function settingsPatch<T extends object>(base: T, next: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => JSON.stringify(base[key as keyof T]) !== JSON.stringify(value),
    ),
  ) as Partial<T>;
}
