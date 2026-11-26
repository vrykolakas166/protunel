// en and vi must define the same keys, plural forms included: a key only in
// one language falls back silently and hides untranslated text.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "src", "locales");

function keys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("locales", () => {
  for (const file of readdirSync(join(root, "en"))) {
    test(`${file}: en and vi have the same keys`, () => {
      const read = (lang: string) => JSON.parse(readFileSync(join(root, lang, file), "utf8"));
      const en = new Set(keys(read("en")));
      const vi = new Set(keys(read("vi")));
      expect([...en].filter((k) => !vi.has(k))).toEqual([]);
      expect([...vi].filter((k) => !en.has(k))).toEqual([]);
    });
  }
});
