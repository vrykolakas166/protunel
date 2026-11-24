import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { groupNames, selectGroups, type GroupName } from "./testGroups";

const root = resolve(import.meta.dir, "..");

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function changedPaths(base?: string): string[] {
  const commit = base === undefined
    ? git("merge-base", "HEAD", "origin/master").trim()
    : git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`).trim();

  // Compare committed, staged, and unstaged changes independently, so a local
  // edit that reverts a committed or staged change still selects its tests.
  return [...new Set([
    git("diff", "--no-renames", "--name-only", "-z", commit, "HEAD", "--"),
    git("diff", "--no-renames", "--name-only", "-z", "--cached", "HEAD", "--"),
    git("diff", "--no-renames", "--name-only", "-z", "--"),
    git("ls-files", "--others", "--exclude-standard", "-z"),
  ].flatMap((output) => output.split("\0").filter(Boolean)))];
}

function run(): number {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      all: { type: "boolean" },
      group: { type: "string" },
      "dry-run": { type: "boolean" },
      "emit-github-outputs": { type: "boolean" },
    },
  });

  const group = groupNames.find((name) => name === values.group);
  if (values.group !== undefined && !group) {
    throw new Error(`Unknown test group: ${values.group}. Choose from ${groupNames.join(", ")}.`);
  }
  if (group && (values.base !== undefined || values.all)) {
    throw new Error("--group selects a single group and cannot be combined with --base or --all.");
  }

  const all = values.all || /^0{40}$/.test(values.base ?? "");
  const selection = selectGroups(all || group ? [] : changedPaths(values.base), { all, group });

  if (values["emit-github-outputs"]) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("GITHUB_OUTPUT must be set with --emit-github-outputs.");
    const selected = new Set<GroupName>(selection.groups.map(({ name }) => name));
    appendFileSync(output, [
      `full=${selection.full}`,
      ...groupNames.map((name) => `${name}=${selected.has(name)}`),
      "",
    ].join("\n"));
    return 0;
  }

  console.log(`Selected groups: ${selection.groups.map(({ name }) => name).join(", ") || "none"}`);
  const seen = new Set<string>();
  for (const { name, commands, filters } of selection.groups) {
    if (filters.length) console.log(`${name} filters: ${filters.join(", ")}`);
    for (const { argv, cwd = "." } of commands) {
      // Group overlap can select the same build or test command in the same directory.
      const key = JSON.stringify([cwd, argv]);
      if (seen.has(key)) continue;
      seen.add(key);

      const command = argv.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
      console.log(`[${name}] ${cwd === "." ? command : `(cd ${cwd}) ${command}`}`);
      if (!values["dry-run"]) {
        const result = Bun.spawnSync(argv, { cwd: resolve(root, cwd), stdio: ["inherit", "inherit", "inherit"] });
        if (!result.success) return result.exitCode || 1;
      }
    }
  }
  return 0;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
