import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyWorkflow,
  verifyClaude,
  verifyMuse,
  verifyGrok,
  formatAgent,
  formatHuman,
} from "../src/verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const CLAUDE_OK = `export const meta = {
  name: "sweep",
  description: "sweep the board",
  whenToUse: "when sweeping",
  phases: [],
};

const first = await agent("Do it", { label: "one" });
const pair = await parallel([() => agent("Second", { label: "two" })]);

return { status: "ok", ref: first, text: "done" };
`;

const MUSE_OK = `const first = await agent({ input: "Do it", label: "one" });
const pair = await parallel([{ input: "Second", label: "two" }]);

return { status: "ok", ref: first, text: "done" };
`;

const GROK_OK = `let meta = #{ name: "sweep", description: "d", when_to_use: "w", phases: [#{ title: "Boot" }] };

let r1 = agent("Do it", #{ label: "one", capability_mode: "all" });
complete(#{ "r": r1 });
`;

/**
 * Run the verify subcommand in a temp dir.
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runVerify(args) {
  const proc = spawnSync(process.execPath, ["bin/cli.mjs", "verify", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * Write source to a temp file and return its path.
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function writeTemp(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "wfport-verify-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test("valid claude input verifies clean", () => {
  const result = verifyClaude(CLAUDE_OK, { agentsDir: null });
  assert.equal(result.dialect, "claude");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.agentCalls, 2);
  assert.equal(result.stats.parallelSites, 1);
});

test("valid muse input verifies clean", () => {
  const result = verifyMuse(MUSE_OK);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("valid grok input verifies clean", () => {
  const result = verifyGrok(GROK_OK);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("claude: missing meta is an error", () => {
  const result = verifyClaude(`const x = await agent("hi");\nreturn { status: "ok" };\n`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "E_NO_META"));
});

test("claude: muse wrapper and host calls are errors", () => {
  const src = `export default async function workflow(host) {
  const r = await host.agent({ input: "hi" });
  return { status: "ok", ref: r, text: "done" };
}
`;
  const result = verifyWorkflow(src, "claude");
  assert.ok(result.errors.some((e) => e.code === "E_WRAPPER"));
  assert.ok(result.errors.some((e) => e.code === "E_HOST_CALLS"));
});

test("claude: imports, banned APIs, and missing return are errors", () => {
  const src = `export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };
import { x } from "./x.mjs";
const r = await agent("hi");
const t = Date.now();
`;
  const result = verifyClaude(src);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("E_IMPORT"));
  assert.ok(codes.includes("E_BANNED"));
  assert.ok(codes.includes("E_NO_RETURN"));
});

test("claude: bare agent() inside parallel is an error", () => {
  const src = `export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };
const pair = await parallel([agent("hi")]);
return { status: "ok" };
`;
  const result = verifyClaude(src);
  assert.ok(result.errors.some((e) => e.code === "E_PARALLEL_SHAPE"));
});

test("muse: export and custom agentType are errors", () => {
  const src = `export const x = 1;
const r = await agent({ input: "hi", agentType: "bg-fix" });
return { status: "ok", ref: r, text: "done" };
`;
  const result = verifyMuse(src);
  assert.ok(result.errors.some((e) => e.code === "E_EXPORT"));
  const agentErr = result.errors.find((e) => e.code === "E_AGENT_TYPE");
  assert.ok(agentErr);
  assert.match(agentErr.hint ?? "", /general-purpose/);
});

test("muse: converter output with choke routing warns instead of failing", () => {
  const src = `// Converted from Claude Workflow "s" by workflow-port.
// wfport:begin-helpers
const MUSE_ROLE_FOR = { "bg-fix": "role" };
const museDispatchArgs = (input, opts) => ({ ...opts, input });
const museResult = (res) => res;
// wfport:end-helpers
const r = await agent(museDispatchArgs("hi", { agentType: "bg-fix" })).then(museResult);
return { status: "ok", ref: r, text: "done" };
`;
  const result = verifyMuse(src);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === "W_AGENT_TYPE_MAPPED"));
});

test("muse: legacy wrapper fails the preflight check", () => {
  const src = `export default async function workflow(host) {
  const r = await host.agent({ input: "hi" });
  return { status: "ok", ref: r, text: "done" };
}
`;
  const result = verifyMuse(src);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "E_WRAPPER"));
});

test("muse: rejected schema keys and oversize schemas are errors", () => {
  const big = "x".repeat(5000);
  const src = `const S = { type: "object", description: "nope", anyOf: [], note: "${big}" };
const r = await agent({ input: "hi", schema: S });
return { status: "ok", ref: r, text: "done" };
`;
  const result = verifyMuse(src);
  const schemaErrs = result.errors.filter((e) => e.code === "E_SCHEMA");
  assert.ok(schemaErrs.length >= 2);
});

test("muse: request without input and thunk entries are flagged", () => {
  const src = `const r = await agent({ label: "no-input" });
const p = await parallel([() => agent({ input: "hi" })]);
return { status: "ok", ref: r, text: "done" };
`;
  const result = verifyMuse(src);
  assert.ok(result.errors.some((e) => e.code === "E_REQUEST_NO_INPUT"));
  assert.ok(result.warnings.some((w) => w.code === "W_PARALLEL_THUNK"));
});

test("grok: missing meta and missing complete are errors", () => {
  const result = verifyGrok(`let r1 = agent("Do it", #{ label: "one" });\n`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "E_NO_META"));
  assert.ok(result.errors.some((e) => e.code === "E_NO_COMPLETE"));
});

test("grok: unknown option keys and JS syntax are errors", () => {
  const src = `let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [] };
let f = (x) => x;
let r1 = agent("hi", #{ bogus_key: "v" });
complete(#{ "r": r1 });
`;
  const result = verifyGrok(src);
  assert.ok(result.errors.some((e) => e.code === "E_UNKNOWN_OPTION"));
  assert.ok(result.errors.some((e) => e.code === "E_JS_SYNTAX"));
});

test("grok: prebuilt job-list variable warns instead of failing", () => {
  const src = `let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [] };
let jobs = [];
jobs.push(#{ prompt: "hi", label: "a" });
let p = parallel(jobs);
complete(#{ "p": p });
`;
  const result = verifyGrok(src);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === "W_JOB_LIST"));
});

test("agent format is compact with a RESULT line", () => {
  const result = verifyClaude(`const x = 1;\n`);
  const out = formatAgent(result, "flow.js");
  assert.match(out, /^ERROR E_NO_META flow.js:1 /m);
  assert.match(out, /^RESULT valid=false errors=\d+ warnings=\d+ dialect=claude /m);
  assert.doesNotMatch(out, /hint:/);
});

test("human format adds context, hints, and next steps", () => {
  const result = verifyClaude(`const x = 1;\n`);
  const out = formatHuman(result, "flow.js", `const x = 1;\n`);
  assert.match(out, /INVALID/);
  assert.match(out, /hint:/);
  assert.match(out, /Next steps:/);
  assert.match(out, /> const x = 1;/);
});

test("cli: valid file exits 0 in all formats", () => {
  const file = writeTemp("flow.muse.js", MUSE_OK);
  for (const format of ["agent", "human", "json"]) {
    const r = runVerify([file, "--format", format]);
    assert.equal(r.status, 0, `format ${format}: ${r.stdout}${r.stderr}`);
  }
  const parsed = JSON.parse(runVerify([file, "--format", "json"]).stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dialect, "muse");
});

test("cli: invalid file exits 2 with agent output on stdout", () => {
  const file = writeTemp("bad.muse.js", `const x = 1;\n`);
  const r = runVerify([file, "--format", "agent"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^ERROR /m);
  assert.match(r.stdout, /RESULT valid=false/m);
});

test("cli: --strict turns warnings into exit 2", () => {
  const src = `${MUSE_OK}const meta = { name: "stale" };\n`;
  const file = writeTemp("warn.muse.js", src);
  const lax = runVerify([file, "--format", "agent"]);
  assert.equal(lax.status, 0);
  assert.match(lax.stdout, /W_STALE_META/);
  const strict = runVerify([file, "--format", "agent", "--strict"]);
  assert.equal(strict.status, 2);
});

test("cli: dialect inference and explicit -i", () => {
  const rhai = writeTemp("flow.rhai", GROK_OK);
  const inferred = runVerify([rhai, "--format", "agent"]);
  assert.equal(inferred.status, 0);
  assert.match(inferred.stdout, /dialect=grok/);
  const claudeFile = writeTemp("flow.claude.js", CLAUDE_OK);
  const explicit = runVerify([claudeFile, "-i", "claude", "--format", "agent"]);
  assert.equal(explicit.status, 0);
  assert.match(explicit.stdout, /dialect=claude/);
});

test("cli: missing input and unknown format exit 1", () => {
  assert.equal(runVerify([]).status, 1);
  const file = writeTemp("flow.muse.js", MUSE_OK);
  const badFormat = runVerify([file, "--format", "xml"]);
  assert.equal(badFormat.status, 1);
  assert.match(badFormat.stderr, /unknown format/);
  const missing = runVerify([join(tmpdir(), "no-such-file.muse.js")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);
});

test("cli: --help documents verify", () => {
  const proc = spawnSync(process.execPath, ["bin/cli.mjs", "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(proc.status, 0);
  assert.match(proc.stdout, /wfport verify/);
  assert.match(proc.stdout, /--format agent\|human\|json/);
});
