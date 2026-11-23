// Remote paths and listings for the file panel. Pure (`tests/filePanel.test.ts`).

import type { FileEntry } from "../../types";

/** `/a/b` + `c` → `/a/b/c`. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/** The parent of an absolute path; `/` stays `/`. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/** Breadcrumb parts: `/var/log` → [["/", "/"], ["var", "/var"], ["log", "/var/log"]]. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of parts) {
    at += `/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

/** A path typed by the user: `~` and relative paths resolve against home / dir. */
export function resolvePath(input: string, dir: string, home: string): string {
  const text = input.trim();
  if (!text) return dir;
  if (text === "~") return home;
  if (text.startsWith("~/")) return joinPath(home, text.slice(2));
  if (text.startsWith("/")) return text;
  return joinPath(dir, text);
}

/** A name a user may give a file: no slashes, not `.`/`..`, not blank. */
export function validName(name: string): boolean {
  const n = name.trim();
  return n !== "" && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\0");
}

/**
 * OSC 7 (`file://host/path`, percent-encoded): the shell's directory, when the
 * shell reports it. Null for anything else.
 */
export function cwdFromOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * The directory in a prompt such as `root@web01:/var/www# ` or
 * `admin@host:~/app$ `. Only the `user@host:path` shape is trusted: `[user@host
 * www]$` shows a folder name, not a path. `~` is left for the caller to resolve.
 */
export function cwdFromPrompt(line: string): string | null {
  const m = /[\w.-]+@[\w.-]+:\s*(~[^\s]*|\/[^\s]*)\s*[$#%>]\s*$/.exec(line.replace(/\s+$/, " "));
  if (!m) return null;
  return m[1].replace(/\/+$/, "") || "/";
}

export type SortKey = "name" | "size" | "mtime";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const isDirLike = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.linkDir);

/** Folders first, then by `key`; hidden files only when asked. */
export function sortEntries(entries: FileEntry[], key: SortKey, desc: boolean, showHidden: boolean, filter: string): FileEntry[] {
  const q = filter.trim().toLowerCase();
  const list = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
  const dir = (e: FileEntry) => (isDirLike(e) ? 0 : 1);
  const by = (a: FileEntry, b: FileEntry) => {
    if (key === "size") return a.size - b.size || collator.compare(a.name, b.name);
    if (key === "mtime") return (a.mtime ?? 0) - (b.mtime ?? 0) || collator.compare(a.name, b.name);
    return collator.compare(a.name, b.name);
  };
  return list.sort((a, b) => dir(a) - dir(b) || (desc ? -by(a, b) : by(a, b)));
}

/** `0o755` → `rwxr-xr-x` (with setuid/setgid/sticky). */
export function modeString(mode: number | null): string {
  if (mode === null) return "—";
  const chars = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
  const set = (at: number, on: boolean, lower: string, upper: string) => {
    if (!on) return;
    out = out.slice(0, at) + (out[at] === "x" ? lower : upper) + out.slice(at + 1);
  };
  set(2, (mode & 0o4000) !== 0, "s", "S");
  set(5, (mode & 0o2000) !== 0, "s", "S");
  set(8, (mode & 0o1000) !== 0, "t", "T");
  return out;
}

export const octal = (mode: number | null) => (mode === null ? "—" : mode.toString(8).padStart(4, "0"));

const TEXT_EXT = new Set(
  "txt log md markdown json jsonc yaml yml toml ini conf cfg cnf env properties xml html htm css scss js mjs cjs ts tsx jsx py rb php go rs java kt c h cpp hpp cs sh bash zsh fish ps1 bat sql csv tsv service timer socket rules list repo gitignore dockerignore editorconfig lock pem crt key pub".split(
    " ",
  ),
);
const TEXT_NAMES = new Set(
  "Dockerfile Makefile Vagrantfile Jenkinsfile Procfile Caddyfile authorized_keys known_hosts hosts fstab crontab passwd group sudoers".split(" "),
);
const IMAGE_EXT = new Set("png jpg jpeg gif webp bmp ico svg".split(" "));

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** How the panel opens a file: in the editor, as an image, or by asking. */
export function viewKind(name: string): "text" | "image" | "unknown" {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name) || name.startsWith(".") || /\.(log|conf)\.\d+$/.test(name)) return "text";
  return "unknown";
}

export function imageMime(name: string): string {
  const ext = extOf(name);
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}
