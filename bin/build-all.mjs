#!/usr/bin/env bun
// Build self-contained wfport binaries for every release target with
// `bun build --compile`, then report sizes. Run with `bun run build:all`.
// Per-target artifacts land in dist/ and are attached to GitHub releases
// by .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";

/** @type {string[]} */
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
];

mkdirSync("dist", { recursive: true });

for (const target of TARGETS) {
  const short = target.replace(/^bun-/, "");
  const ext = short.startsWith("windows") ? ".exe" : "";
  const outfile = `dist/wfport-${short}${ext}`;
  execFileSync(
    "bun",
    ["build", "bin/cli.mjs", "--compile", "--target", target, "--outfile", outfile],
    { stdio: "inherit" },
  );
  const bytes = statSync(outfile).size;
  console.log(`${outfile} ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
}
