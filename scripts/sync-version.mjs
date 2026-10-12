#!/usr/bin/env node
/**
 * Copyright 2026 Atemukesu
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Propagate package.json's version to the Tauri config, Android app metadata,
// and the Rust manifest so release artifacts report one consistent version.
// package.json is the single source of truth; this runs before every release
// build (via the `prebuild` script) and can be invoked directly as well.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`[version] package.json has an invalid version: ${version}`);
  process.exit(1);
}

const [major, minor, patchVersion] = version
  .split(/[+-]/, 1)[0]
  .split(".")
  .map(Number);
const androidVersionCode = major * 1_000_000 + minor * 1_000 + patchVersion;

/** Rewrite a file in place, logging only when the content actually changed. */
function patch(relativePath, transform) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`[version] ${relativePath} -> ${version}`);
  }
}

patch("src-tauri/tauri.conf.json", (text) =>
  text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
);

patch("src-tauri/Cargo.toml", (text) =>
  text.replace(/(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m, `$1${version}$2`)
);

patch("src-tauri/Cargo.lock", (text) =>
  text.replace(/(name = "welkinplayer"\r?\nversion = ")[^"]*(")/, `$1${version}$2`)
);

patch("src-tauri/gen/android/app/tauri.properties", (text) =>
  text
    .replace(/^(tauri\.android\.versionName=).*$/m, `$1${version}`)
    .replace(/^(tauri\.android\.versionCode=).*$/m, `$1${androidVersionCode}`)
);
