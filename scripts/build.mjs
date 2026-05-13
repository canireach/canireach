#!/usr/bin/env node
// Build dist/canireach.mjs using Bun's bundler. Runs from npm scripts where
// $PATH might not include Bun (e.g. zsh-only installs), so we probe a couple
// of common locations before giving up.
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";

const candidates = ["bun", `${process.env.HOME ?? ""}/.bun/bin/bun`];
let bunBin = null;
for (const c of candidates) {
  if (!c) continue;
  const r = spawnSync(c, ["--version"], { stdio: "ignore" });
  if (r.status === 0) { bunBin = c; break; }
}
if (!bunBin) {
  console.error("canireach build requires Bun (https://bun.sh). Install it, then re-run.");
  process.exit(1);
}

const r = spawnSync(bunBin, [
  "build",
  "--target=node",
  "--format=esm",
  "--banner=#!/usr/bin/env node",
  "--outfile=dist/canireach.mjs",
  "src/cli.ts",
], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

try { chmodSync("dist/canireach.mjs", 0o755); } catch {}
