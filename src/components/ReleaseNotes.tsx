import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { notesFor } from "../releaseNotes";

/** `**bold**` and `` `code` `` inside a line; everything else stays text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-surface-hover px-1 font-mono text-[10px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/**
 * Release notes are Markdown written for GitHub. Only the handful of forms
 * they use (headings, bullets, bold, code) are rendered — as React elements,
 * never as HTML, so a release body can't inject markup into the app. Notes
 * in both languages show only the app language's part (`releaseNotes.ts`).
 */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  const { i18n } = useTranslation();
  markdown = notesFor(markdown, i18n.language);
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={blocks.length} className="ml-4 list-disc space-y-0.5">
        {bullets.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="pt-1 font-display text-xs font-semibold text-text">
          {inline(heading[1])}
        </p>,
      );
    } else {
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-1.5 text-[11px] leading-relaxed text-muted">{blocks}</div>;
}
