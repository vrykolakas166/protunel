#!/usr/bin/env bun
/**
 * Release notes, kept in CHANGELOG.md (English) and CHANGELOG.vi.md
 * (Vietnamese) in the Keep a Changelog layout:
 *
 *   ## [Unreleased]          what the next release will say
 *   ## [0.10.0] - 2026-11-24 one section per released version
 *
 *   bun scripts/changelog.ts notes <x.y.z>    release notes for that version
 *   bun scripts/changelog.ts release <x.y.z>  Unreleased becomes <x.y.z> (run by `bun run bump`)
 *   bun scripts/changelog.ts pending          commits since the last tag, to check Unreleased against
 *
 * `notes` joins both languages into one Markdown text: English first, then
 * `LANG_MARKER` and the Vietnamese section. That text becomes the GitHub
 * release body and `latest.json` `notes`, which the app's "What's new"
 * shows; `src/releaseNotes.ts` picks the part for the app's language.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UNRELEASED = "Unreleased";
export const FILES = { en: "CHANGELOG.md", vi: "CHANGELOG.vi.md" } as const;
/** Starts the Vietnamese part of joined notes (invisible on GitHub). */
export const LANG_MARKER = "<!-- lang: vi -->";

const HEADING = /^## \[([^\]]+)\](.*)$/;

interface Section {
  name: string;
  /** Index of the `## [name]` line. */
  start: number;
  /** Index just past the section's last line. */
  end: number;
}

function sections(lines: string[]): Section[] {
  const found: Section[] = [];
  lines.forEach((line, i) => {
    const match = HEADING.exec(line);
    if (!match) return;
    if (found.length) found[found.length - 1].end = i;
    found.push({ name: match[1], start: i, end: lines.length });
  });
  return found;
}

/** The body of `## [name]` (without its heading), trimmed; null when the section is missing. */
export function section(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const found = sections(lines).find((s) => s.name === name);
  return found ? lines.slice(found.start + 1, found.end).join("\n").trim() : null;
}

/** Every released version, newest first as written. */
export function versions(text: string): string[] {
  return sections(text.split(/\r?\n/))
    .map((s) => s.name)
    .filter((name) => name !== UNRELEASED);
}

/**
 * Moves the Unreleased body under a new `## [version] - date` heading and
 * leaves an empty Unreleased above it. Throws when Unreleased is missing or
 * empty, or the version already has a section.
 */
export function release(text: string, version: string, date: string): string {
  const lines = text.split(/\r?\n/);
  const all = sections(lines);
  const unreleased = all.find((s) => s.name === UNRELEASED);
  if (!unreleased) throw new Error(`no "## [${UNRELEASED}]" section`);
  if (all.some((s) => s.name === version)) throw new Error(`${version} already has a section`);
  const body = lines.slice(unreleased.start + 1, unreleased.end).join("\n").trim();
  if (!body) throw new Error(`"## [${UNRELEASED}]" is empty: write the release notes first`);
  const before = lines.slice(0, unreleased.start);
  const after = lines.slice(unreleased.end).join("\n").trimEnd();
  const out = [...before, `## [${UNRELEASED}]`, "", `## [${version}] - ${date}`, "", body, ""];
  return out.join("\n") + (after ? `\n${after}\n` : "");
}

/** English notes, then the Vietnamese ones after `LANG_MARKER` when there are any. */
export function joinNotes(en: string, vi: string | null): string {
  return vi ? `${en}\n\n---\n\n${LANG_MARKER}\n\n${vi}\n` : `${en}\n`;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (lang: keyof typeof FILES) => readFileSync(join(root, FILES[lang]), "utf8");

function main(args: string[]): number {
  const [command, version] = args;
  if (command === "notes" && version) {
    const en = section(read("en"), version);
    if (!en) {
      console.error(`${FILES.en} has no "## [${version}]" section with notes`);
      return 1;
    }
    process.stdout.write(joinNotes(en, section(read("vi"), version)));
    return 0;
  }
  if (command === "release" && version) {
    const date = new Date().toISOString().slice(0, 10);
    // Compute both first so a refusal leaves neither file changed.
    const next = { en: release(read("en"), version, date), vi: release(read("vi"), version, date) };
    for (const lang of ["en", "vi"] as const) writeFileSync(join(root, FILES[lang]), next[lang]);
    console.log(`${FILES.en} and ${FILES.vi}: Unreleased is now [${version}] - ${date}`);
    return 0;
  }
  if (command === "pending") {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
    console.log(`Commits since ${tag}; check each user-visible one is in "## [${UNRELEASED}]":\n`);
    console.log(execFileSync("git", ["log", "--no-merges", "--format=%h %s", `${tag}..HEAD`], { cwd: root, encoding: "utf8" }));
    console.log(`## [${UNRELEASED}] (${FILES.en}):\n\n${section(read("en"), UNRELEASED) || "(empty)"}`);
    return 0;
  }
  console.error("Usage: bun scripts/changelog.ts notes <x.y.z> | release <x.y.z> | pending");
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
