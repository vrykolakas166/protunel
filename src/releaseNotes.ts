/**
 * Release notes arrive as one Markdown text (`latest.json` `notes`, built by
 * `scripts/changelog.ts`): English first, then `<!-- lang: vi -->` and the
 * Vietnamese notes. Older releases carry English only.
 */
const MARKER = /^<!--\s*lang:\s*([a-z-]+)\s*-->\s*$/i;

/** The notes for `language`, else the English ones; marker and separator lines dropped. */
export function notesFor(markdown: string, language: string): string {
  const parts: Record<string, string[]> = { en: [] };
  let current = "en";
  for (const line of markdown.split(/\r?\n/)) {
    const marker = MARKER.exec(line.trim());
    if (marker) {
      current = marker[1].toLowerCase();
      parts[current] = [];
      continue;
    }
    parts[current].push(line);
  }
  const clean = (lines: string[] | undefined) =>
    (lines ?? [])
      .join("\n")
      .trim()
      // The `---` that separates the languages on GitHub.
      .replace(/(?:^|\n)-{3,}$/, "")
      .trim();
  const base = language.split("-")[0].toLowerCase();
  return clean(parts[base]) || clean(parts.en);
}
