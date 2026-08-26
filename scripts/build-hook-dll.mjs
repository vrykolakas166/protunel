#!/usr/bin/env node
// Builds the capture-hook cdylib and drops it where tauri.conf.json's
// bundle.resources expects it. Run ahead of `vite`/`vite build` via
// tauri.conf.json's beforeDevCommand/beforeBuildCommand — not from
// src-tauri/build.rs, since a nested `cargo build` there risks lock
// contention with the outer build.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = join(root, "src-tauri");
const profile = process.argv[2] === "dev" ? "dev" : "release";
const profileDir = profile === "dev" ? "debug" : "release";

const cargoArgs = ["build", "-p", "capture-hook"];
if (profile === "release") cargoArgs.push("--release");
execFileSync("cargo", cargoArgs, { cwd: srcTauri, stdio: "inherit" });

const builtDll = join(srcTauri, "target", profileDir, "capture_hook.dll");
const resourcesDir = join(srcTauri, "resources");
if (!existsSync(resourcesDir)) mkdirSync(resourcesDir, { recursive: true });
copyFileSync(builtDll, join(resourcesDir, "capture_hook.dll"));

console.log(`capture-hook: copied ${builtDll} -> src-tauri/resources/capture_hook.dll`);
