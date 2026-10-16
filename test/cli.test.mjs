import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures", "sample.workflow.js.txt");

const MUSE_SRC = `export default async function workflow(host) {
  const first = await host.agent({ input: "Do it", label: "first" });
  return { status: "ok", ref: first, text: "done" };
}
`;

/**
 * Run the CLI in a temp dir.
 * @param {string[]} args
 * @param {{ stdin?: string }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runCli(args, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  if (options.stdin != null) writeFileSync(join(dir, "input.txt"), options.stdin);
  const proc = spawnSync(process.execPath, ["bin/cli.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

test("default is claude->muse with stdout and stderr report", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  const report = join(dir, "report.json");
  const proc = spawnSync(process.execPath, ["bin/cli.mjs", fixture, "--report", report], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(proc.status, 2); // fixture has known gaps
  assert.match(proc.stdout, /export default async function workflow\(host\)/);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(parsed.source, "claude");
  assert.equal(parsed.target, "muse");
});

test("--to grok with --out writes a rhai file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  const out = join(dir, "flow.rhai");
  const r = runCli([fixture, "--to", "grok", "--out", out]);
  assert.equal(r.status, 2);
  assert.match(readFileSync(out, "utf8"), /let meta = #\{/);
});

test("muse input without -o fails and asks for a target", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  const src = join(dir, "flow.muse.js");
  writeFileSync(src, MUSE_SRC);
  const r = runCli([src]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /-o\/--output/);
});

test("muse input with -o grok converts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  const src = join(dir, "flow.muse.js");
  writeFileSync(src, MUSE_SRC);
  const r = runCli([src, "-o", "grok"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /let r1 = agent\(/);
  const parsed = JSON.parse(r.stderr);
  assert.equal(parsed.source, "muse");
  assert.equal(parsed.target, "grok");
});

test("same source and target is rejected", () => {
  const r = runCli([fixture, "-o", "claude"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to convert/);
});

test("legacy -o <file> still writes the file with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-cli-"));
  const out = join(dir, "flow.muse.js");
  const r = runCli([fixture, "-o", out]);
  assert.equal(r.status, 2);
  assert.match(readFileSync(out, "utf8"), /export default async function workflow\(host\)/);
  assert.match(r.stderr, /deprecated/);
});

test("--help exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--input/);
});

test("--help documents the flag set, defaults, and exit codes", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  // Flag spellings the skill and README promise must appear in --help.
  assert.match(r.stdout, /--out/);
  assert.match(r.stdout, /--to/);
  assert.match(r.stdout, /--from/);
  assert.match(r.stdout, /--version/);
  // stdout/stderr defaults and exit codes must agree with the docs.
  assert.match(r.stdout, /stdout/);
  assert.match(r.stdout, /stderr/);
  assert.match(r.stdout, /Exit codes: 0.*1.*2/);
});

test("--version prints the version", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /wfport \d+\.\d+\.\d+/);
});
