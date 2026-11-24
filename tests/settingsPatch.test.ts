import { expect, test } from "bun:test";
import { settingsPatch } from "../src/settingsPatch";

test("includes only settings changed from the edited snapshot", () => {
  const base = { language: "en", theme: "system", terminalAppMouse: true };
  const next = { ...base, theme: "protunel_dark", terminalAppMouse: false };

  expect(settingsPatch(base, next)).toEqual({ theme: "protunel_dark", terminalAppMouse: false });
});

test("compares nested settings by JSON value", () => {
  const base = { nested: { values: [1, 2] } };

  expect(settingsPatch(base, { nested: { values: [1, 2] } })).toEqual({});
  expect(settingsPatch(base, { nested: { values: [2, 1] } })).toEqual({ nested: { values: [2, 1] } });
});

test("includes explicit nulls that clear a setting", () => {
  const base = { uiMode: "full" as string | null };

  expect(settingsPatch(base, { uiMode: null })).toEqual({ uiMode: null });
});
