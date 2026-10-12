/**
 * Copyright 2026 Atemukesu
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Build the ALAC wasm decoder from source and place it where Vite's `public`
// dir will copy it into the bundle. Requires the `wasm32-unknown-unknown`
// rustup target; CI installs it before building.
//
// Usage: node scripts/build-alac-wasm.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(root, "src-tauri", "alac-wasm");
const outDir = join(root, "public");
const artifact = join(
  crateDir,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "alac_wasm.wasm",
);

console.log("[alac-wasm] building wasm decoder (release)...");
execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], {
  cwd: crateDir,
  stdio: "inherit",
});

mkdirSync(outDir, { recursive: true });
copyFileSync(artifact, join(outDir, "alac.wasm"));
console.log("[alac-wasm] copied to public/alac.wasm");