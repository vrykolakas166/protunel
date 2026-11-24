import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FILES, LANG_MARKER, UNRELEASED, joinNotes, release, section, versions } from "../scripts/changelog";
import { notesFor } from "../src/releaseNotes";

const LOG = `# Changelog

Intro.

## [Unreleased]

### Fixes
- New fix.

## [1.1.0] - 2026-01-02

### Highlights
- Big thing.

## [1.0.0] - 2025-12-01

- First.
`;

describe("changelog sections", () => {
  test("section returns a version's body without its heading", () => {
    expect(section(LOG, "1.1.0")).toBe("### Highlights\n- Big thing.");
    expect(section(LOG, "1.0.0")).toBe("- First.");
    expect(section(LOG, UNRELEASED)).toBe("### Fixes\n- New fix.");
    expect(section(LOG, "9.9.9")).toBeNull();
    expect(section(LOG.replaceAll("\n", "\r\n"), "1.0.0")).toBe("- First.");
  });

  test("versions lists released versions only", () => {
    expect(versions(LOG)).toEqual(["1.1.0", "1.0.0"]);
  });

  test("release moves Unreleased under the version and leaves it empty", () => {
    const next = release(LOG, "1.2.0", "2026-02-03");
    expect(section(next, UNRELEASED)).toBe("");
    expect(section(next, "1.2.0")).toBe("### Fixes\n- New fix.");
    expect(versions(next)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(next).toContain("Intro.\n\n## [Unreleased]\n\n## [1.2.0] - 2026-02-03\n\n### Fixes");
    expect(section(next, "1.1.0")).toBe(section(LOG, "1.1.0"));
  });

  test("release refuses an empty Unreleased, a released version, or no Unreleased", () => {
    const empty = release(LOG, "1.2.0", "2026-02-03");
    expect(() => release(empty, "1.3.0", "2026-02-04")).toThrow("empty");
    expect(() => release(LOG, "1.1.0", "2026-02-03")).toThrow("already");
    expect(() => release("# Changelog\n", "1.0.0", "2026-02-03")).toThrow("no");
  });
});

describe("bilingual notes", () => {
  const joined = joinNotes("### Fixes\n- Fixed it.", "### Sửa lỗi\n- Đã sửa.");

  test("joinNotes puts English first and Vietnamese after the marker", () => {
    expect(joined).toBe(`### Fixes\n- Fixed it.\n\n---\n\n${LANG_MARKER}\n\n### Sửa lỗi\n- Đã sửa.\n`);
    expect(joinNotes("- Only English.", null)).toBe("- Only English.\n");
  });

  test("notesFor picks the app language and falls back to English", () => {
    expect(notesFor(joined, "vi")).toBe("### Sửa lỗi\n- Đã sửa.");
    expect(notesFor(joined, "en")).toBe("### Fixes\n- Fixed it.");
    expect(notesFor(joined, "fr")).toBe("### Fixes\n- Fixed it.");
    expect(notesFor(joined, "vi-VN")).toBe("### Sửa lỗi\n- Đã sửa.");
  });

  test("notesFor keeps English-only notes and inner rules as they are", () => {
    expect(notesFor("- Old release.\n", "vi")).toBe("- Old release.");
    expect(notesFor("- A\n\n---\n\n- B", "en")).toBe("- A\n\n---\n\n- B");
  });
});

describe("the repository's changelogs", () => {
  const en = readFileSync(FILES.en, "utf8");
  const vi = readFileSync(FILES.vi, "utf8");

  test("both have an Unreleased section and the same versions", () => {
    expect(section(en, UNRELEASED)).not.toBeNull();
    expect(section(vi, UNRELEASED)).not.toBeNull();
    expect(versions(vi)).toEqual(versions(en));
  });

  test("every released version has notes in both languages", () => {
    for (const version of versions(en)) {
      expect(section(en, version)).toBeTruthy();
      expect(section(vi, version)).toBeTruthy();
    }
  });
});
