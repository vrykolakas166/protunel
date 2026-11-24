import { describe, expect, test } from "bun:test";
import { acceptsFilter, commandFilter, runCommands, selectGroups } from "../scripts/testGroups";

const allGroups = ["frontend", "rust", "ssh-it", "windows"];
const namesFor = (...paths: string[]) => selectGroups(paths).groups.map(({ name }) => name);

describe("test group selection", () => {
  test.each([
    ["src/terminal/layout.ts", ["frontend"]],
    ["tests/testGroups.test.ts", ["frontend"]],
    ["tsconfig.node.json", ["frontend"]],
    ["vite.config.ts", ["frontend"]],
    ["src-tauri/build.rs", ["rust"]],
    ["src-tauri/src/db.rs", ["rust"]],
    ["src-tauri/src/config_io.rs", ["rust"]],
    ["src-tauri/src/settings.rs", ["rust"]],
    ["src-tauri/src/commands/terminal_window.rs", ["rust", "ssh-it"]],
    ["src-tauri/tests/it/support/mod.rs", ["rust", "ssh-it"]],
    ["src-tauri/src/it/network.rs", ["rust", "ssh-it"]],
    ["docker/it/compose.yaml", ["ssh-it"]],
    ["src-tauri/src/router/system_proxy.rs", ["rust", "ssh-it", "windows"]],
    ["src-tauri\\src\\ssh\\drag_out\\mod.rs", ["rust", "ssh-it", "windows"]],
    ["src-tauri/src/secrets.rs", ["rust", "windows"]],
    ["docs/src/guide.md", []],
  ] as const)("selects relevant groups for %s", (path, expected) => {
    expect(namesFor(path)).toEqual(expected);
  });

  test.each([
    "Cargo.lock",
    "Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "bun.lock",
    "package.json",
    ".github/workflows/check.yml",
    "scripts/test-groups.json",
  ])("selects every group for %s", (path) => {
    expect(selectGroups([path]).full).toBe(true);
    expect(namesFor(path)).toEqual(allGroups);
  });

  test("can select all groups or just one group without changed paths", () => {
    expect(selectGroups([], { all: true }).groups.map(({ name }) => name)).toEqual(allGroups);
    expect(selectGroups([], { group: "rust" }).groups.map(({ name }) => name)).toEqual(["rust"]);
    expect(namesFor()).toEqual([]);
  });

  test("combines SSH filters when each SSH path has a filter", () => {
    const selection = selectGroups([
      "src/App.tsx",
      "src-tauri/src/ssh/sftp/copy_across.rs",
      "src-tauri/src/ssh/sftp/mod.rs",
      "src-tauri/src/router/rules.rs",
      "src-tauri/src/commands/connection.rs",
    ]);
    expect(selection.groups.map(({ name }) => name)).toEqual(["frontend", "rust", "ssh-it"]);
    expect(selection.groups.find(({ name }) => name === "ssh-it")?.filters).toEqual([
      "it_copy", "it_sftp", "it_router", "it_tunnel",
    ]);
  });

  test("prefers the copy filter over the broader SFTP filter", () => {
    const selection = selectGroups(["src-tauri/src/ssh/sftp/copy_across.rs"]);
    expect(selection.groups.find(({ name }) => name === "ssh-it")?.filters).toEqual(["it_copy"]);
  });

  test("uses the whole SSH group when any SSH path has no filter or the run is full", () => {
    const router = "src-tauri/src/router/rules.rs";
    for (const extra of ["src-tauri/src/commands/files.rs", "bun.lock"]) {
      const selection = selectGroups([router, extra]);
      expect(selection.groups.find(({ name }) => name === "ssh-it")?.filters).toEqual([]);
    }
  });

  test("runs a single SSH filter only when all relevant paths select it", () => {
    const filterFor = (...paths: string[]) =>
      commandFilter(selectGroups(paths, { group: "ssh-it" }).groups[0]);
    expect(filterFor("src-tauri/src/it/copy.rs", "src-tauri/src/ssh/copy_across.rs")).toBe("it_copy");
    expect(filterFor("src-tauri/src/ssh/sftp/mod.rs", "src-tauri/src/router/rules.rs")).toBe("it_");
    expect(filterFor("docker/it/Dockerfile", "src-tauri/src/it/copy.rs")).toBe("it_");
    expect(filterFor("bun.lock", "src-tauri/src/it/copy.rs")).toBe("it_");
    expect(filterFor()).toBe("it_");
    expect(acceptsFilter("ssh-it", "it_")).toBe(true);
    expect(acceptsFilter("ssh-it", "it_router")).toBe(true);
    expect(acceptsFilter("ssh-it", "--help")).toBe(false);
  });

  test.each([
    ["up", 19, ["up", "logs", "down"]],
    ["test", 19, ["up", "test", "logs", "down"]],
    ["logs", 19, ["up", "test", "logs", "down"]],
    ["down", 19, ["up", "test", "logs", "down"]],
    ["", 0, ["up", "test", "logs", "down"]],
  ] as const)("runs Compose teardown after %s", (failure, status, expected) => {
    const calls: string[] = [];
    const commands = selectGroups([], { group: "ssh-it" }).groups[0].commands;
    expect(runCommands(commands, ({ argv }) => {
      const step = argv[0] === "xvfb-run" ? "test" : argv[0] === "bash" ? "logs" : argv[4];
      calls.push(step);
      return step === failure ? 19 : 0;
    })).toBe(status);
    expect(calls).toEqual(expected);
  });

  test("preserves the test failure if teardown also fails", () => {
    expect(runCommands([{ argv: ["test"] }, { argv: ["down"], always: true }],
      ({ argv }) => argv[0] === "test" ? 19 : 1,
    )).toBe(19);
  });
});
