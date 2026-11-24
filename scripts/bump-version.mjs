#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: bun run bump <x.y.z>");
  process.exit(1);
}

// Release notes first: an empty "## [Unreleased]" stops the bump before any
// file changes (scripts/changelog.ts, CHANGELOG.md + CHANGELOG.vi.md).
try {
  execFileSync("bun", ["scripts/changelog.ts", "release", version], { cwd: root, stdio: "inherit" });
} catch {
  process.exit(1);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
const tauriConf = readFileSync(tauriConfPath, "utf8");
writeFileSync(
  tauriConfPath,
  tauriConf.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
);

const cargoTomlPath = join(root, "src-tauri", "Cargo.toml");
const cargoToml = readFileSync(cargoTomlPath, "utf8");
writeFileSync(
  cargoTomlPath,
  cargoToml.replace(/^version = "[^"]+"/m, `version = "${version}"`),
);

// Arch package: keep pkgver in step. The checksum belongs to the old .deb, so
// it is cleared until `updpkgsums` (or the pacman-repo workflow) refills it.
const pkgbuildPath = join(root, "packaging", "arch", "PKGBUILD");
const pkgbuild = readFileSync(pkgbuildPath, "utf8");
writeFileSync(
  pkgbuildPath,
  pkgbuild
    .replace(/^pkgver=.*$/m, `pkgver=${version}`)
    .replace(/^pkgrel=.*$/m, "pkgrel=1")
    .replace(/^sha256sums=.*$/m, "sha256sums=('SKIP')"),
);

execFileSync("cargo", ["update", "-p", "protunel", "--precise", version], {
  cwd: join(root, "src-tauri"),
  stdio: "inherit",
});

console.log(`\nBumped to v${version}. Next:`);
console.log(`  (after the release is built: cd packaging/arch && updpkgsums)`);
console.log(`  (check CHANGELOG.md / CHANGELOG.vi.md: their [${version}] sections are the release notes)`);
console.log(`  git add CHANGELOG.md CHANGELOG.vi.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock packaging/arch/PKGBUILD`);
console.log(`  git commit -m "Bump version to ${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin master v${version}`);
