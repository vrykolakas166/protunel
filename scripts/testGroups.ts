import config from "./test-groups.json";

export type GroupName = keyof typeof config.groups;

export interface Command {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  always?: boolean;
}

interface TestGroup {
  paths: string[];
  commands: Command[];
  filters?: Record<string, string[]>;
  defaultFilter?: string;
}

export interface SelectedGroup {
  name: GroupName;
  commands: Command[];
  filters: string[];
}

const groups: Record<GroupName, TestGroup> = config.groups;
export const groupNames = Object.keys(groups) as GroupName[];

export function commandFilter({ name, filters }: SelectedGroup): string | undefined {
  return filters.length === 1 ? filters[0] : groups[name].defaultFilter;
}

export function acceptsFilter(group: GroupName, filter: string): boolean {
  return groups[group].defaultFilter === filter || Object.hasOwn(groups[group].filters ?? {}, filter);
}

export function runCommands(commands: Command[], execute: (command: Command) => number): number {
  let status = 0;
  for (const command of commands) {
    if (status !== 0 && !command.always) continue;
    try {
      const result = execute(command);
      status ||= result;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      status ||= 1;
    }
  }
  return status;
}

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

export function selectGroups(
  changedPaths: readonly string[],
  options: { all?: boolean; group?: GroupName } = {},
): { full: boolean; groups: SelectedGroup[] } {
  const paths = changedPaths.map((path) => path.replaceAll("\\", "/"));
  const full = Boolean(options.all || paths.some((path) => matches(path, config.globalPaths)));
  const selected: SelectedGroup[] = [];

  for (const name of groupNames) {
    if (options.group && name !== options.group) continue;
    const group = groups[name];
    const changed = paths.filter((path) => matches(path, group.paths));
    if (!options.group && !full && changed.length === 0) continue;

    const filters = Object.entries(group.filters ?? {});
    // More specific filters come first. An uncovered path needs the whole suite.
    const matched = new Set(changed.map((path) => filters.find(([, patterns]) => matches(path, patterns))?.[0]));
    const selectedFilters = full || matched.has(undefined)
      ? []
      : filters.map(([filter]) => filter).filter((filter) => matched.has(filter));
    selected.push({ name, commands: group.commands, filters: selectedFilters });
  }

  return { full, groups: selected };
}
