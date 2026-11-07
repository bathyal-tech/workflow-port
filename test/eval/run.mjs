#!/usr/bin/env node
// Local-only launcher for the wfport conversion eval (docs/roundtrip-harness.md).
// Probes PATH for claude/grok/muse, checks the wfport skill per host, and
// launches each available host's own harness workflow non-interactively.
// No host (or no skill) is a skip, never a failure. LLM runs never happen
// in CI or bun test; CI only verifies the seed/harness files parse.
//
// Usage: bun test/eval/run.mjs [--dry-run] [--only claude|grok|muse]
// Env: WFPORT_EVAL_TIMEOUT_MS (default 1800000), WFPORT_EVAL_<HOST>_CMD
// overrides the launch command template ({harness} is substituted).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "test", "eval", "out");

/**
 * @typedef {object} HostDef
 * @property {string} name
 * @property {string} bin
 * @property {string} harness repo-relative harness workflow path
 * @property {string} requestedModel floating-latest alias asked of the host
 * @property {string[]} skillPaths candidate wfport SKILL.md locations
 * @property {(harness: string) => { cmd: string, args: string[] }} launch
 */

/** @type {HostDef[]} */
const HOSTS = [
  {
    name: "claude",
    bin: "claude",
    harness: "test/eval/harness/harness.claude.js",
    requestedModel: "sonnet (latest alias)",
    skillPaths: [
      ".claude/skills/wfport/SKILL.md",
      join(homedir(), ".claude/skills/wfport/SKILL.md"),
    ],
    launch: (harness) => {
      const agents = claudeAgentsArg();
      return {
        cmd: "claude",
        args: [
          "-p",
          `Run the workflow file ${harness} from this repo with the latest Sonnet model. Work from the repo root. Return the workflow result JSON.`,
          "--model",
          "sonnet",
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Workflow",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          ...(agents ? ["--agents", agents] : []),
        ],
      };
    },
  },
  {
    name: "grok",
    bin: "grok",
    harness: "test/eval/harness/harness.grok.rhai",
    requestedModel: "grok latest",
    skillPaths: [".grok/skills/wfport/SKILL.md", join(homedir(), ".grok/skills/wfport/SKILL.md")],
    launch: (harness) => ({
      cmd: "grok",
      args: [
        "-p",
        `Run the workflow file ${harness} from this repo with the latest Grok model. Work from the repo root. Return the workflow result JSON.`,
      ],
    }),
  },
  {
    name: "muse",
    bin: "muse",
    harness: "test/eval/harness/harness.muse.js",
    requestedModel: "muse-spark latest (host default)",
    skillPaths: [".agents/skills/wfport/SKILL.md"],
    launch: (harness) => ({
      cmd: "muse",
      args: [
        "exec",
        `Use the Workflow tool to run the workflow script at ${harness} in this repo (Workflow scriptPath), with the latest muse-spark model. Return the complete workflow result: conversions, verdicts, and summary.`,
      ],
    }),
  },
];

/**
 * Build the Claude `--agents` JSON registering the eval agent types
 * (seed-runner, readonly-reviewer, seed-fixer) from test/eval/agents,
 * so the Claude harness resolves its agentTypes without installing
 * anything into .claude/agents. Null when a role file is missing.
 * @returns {string | null}
 */
function claudeAgentsArg() {
  /** @type {Record<string, { description: string, prompt: string, tools: string[] }>} */
  const agents = {};
  for (const name of ["seed-runner", "readonly-reviewer", "seed-fixer"]) {
    const path = join(root, "test", "eval", "agents", `${name}.md`);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!fm) return null;
    const head = fm[1] ?? "";
    const description = /description:\s*(.*)/.exec(head)?.[1]?.trim() ?? name;
    const tools = (/tools:\s*(.*)/.exec(head)?.[1] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    agents[name] = { description, prompt: (fm[2] ?? "").trim(), tools };
  }
  return JSON.stringify(agents);
}

/**
 * Probe a host binary: present when `<bin> --version` spawns.
 * @param {string} bin
 * @returns {string | null} version line, or null when unavailable
 */
function probeVersion(bin) {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
  if (res.error) return null;
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n")[0];
  return out || "present";
}

/**
 * Best-effort resolved model from host output: the concrete model id
 * when the host reports one, else null (never a fabricated label).
 * @param {string} text combined host stdout/stderr
 * @returns {string | null}
 */
function extractResolvedModel(text) {
  for (const re of [
    /\b(muse-spark-[\w.]+)\b/,
    /\b(claude-(?:sonnet|opus|haiku)-[\w.-]+)\b/,
    /\b(grok-\d[\w.-]*)\b/,
  ]) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  if (/\bmuse spark\b/i.test(text)) return "muse-spark";
  const grokPhrase = /\bgrok\s+(\d[\w.]*)/i.exec(text);
  if (grokPhrase) return `grok-${grokPhrase[1]}`;
  return null;
}

/**
 * Check the wfport skill for a host by candidate SKILL.md paths.
 * @param {HostDef} host
 * @returns {string | null} evidence path, or null when not installed
 */
function probeSkill(host) {
  for (const p of host.skillPaths) {
    const full = p.startsWith("/") ? p : join(root, p);
    if (existsSync(full)) return p;
  }
  return null;
}

/**
 * Apply a WFPORT_EVAL_<HOST>_CMD template override, if set.
 * @param {HostDef} host
 * @returns {{ cmd: string, args: string[] }}
 */
function launchCommand(host) {
  const override = process.env[`WFPORT_EVAL_${host.name.toUpperCase()}_CMD`];
  if (override) {
    const parts = override.replaceAll("{harness}", host.harness).split(/\s+/).filter(Boolean);
    return { cmd: /** @type {string} */ (parts[0]), args: parts.slice(1) };
  }
  return host.launch(host.harness);
}

/**
 * Run one host: probe, skill-check, then launch unless dry-run.
 * @param {HostDef} host
 * @param {boolean} dryRun
 * @param {number} timeoutMs
 * @returns {Record<string, unknown>}
 */
function runHost(host, dryRun, timeoutMs) {
  const cliVersion = probeVersion(host.bin);
  const skill = probeSkill(host);
  const base = {
    host: host.name,
    available: cliVersion !== null,
    cliVersion,
    requestedModel: host.requestedModel,
    resolvedModel: null,
    skillInstalled: skill !== null,
    skillEvidence: skill,
    harness: host.harness,
  };
  if (!cliVersion) return { ...base, status: "skipped", reason: `${host.bin} not on PATH` };
  if (!skill)
    return { ...base, status: "skipped", reason: "wfport skill not installed for this host" };
  const { cmd, args } = launchCommand(host);
  const command = [cmd, ...args].join(" ");
  if (dryRun) return { ...base, status: "would-run", command };
  const logFile = join(outDir, `${host.name}.log`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 67108864,
  });
  writeFileSync(logFile, `${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  const timedOut =
    res.error != null && /** @type {NodeJS.ErrnoException} */ (res.error).code === "ETIMEDOUT";
  return {
    ...base,
    resolvedModel: extractResolvedModel(`${res.stdout ?? ""}\n${res.stderr ?? ""}`),
    status: timedOut ? "timeout" : res.status === 0 ? "completed" : "failed",
    command,
    exitCode: res.status,
    logFile: `test/eval/out/${host.name}.log`,
  };
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: bun test/eval/run.mjs [--dry-run] [--only claude|grok|muse]");
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
if (onlyIdx >= 0 && (!only || only.startsWith("-") || !HOSTS.some((h) => h.name === only))) {
  console.error(
    `wfport eval: --only requires one of ${HOSTS.map((h) => h.name).join("|")}\nusage: bun test/eval/run.mjs [--dry-run] [--only claude|grok|muse]`,
  );
  process.exit(1);
}
const timeoutMs = Number(process.env.WFPORT_EVAL_TIMEOUT_MS ?? 1800000);

mkdirSync(outDir, { recursive: true });
const startedAt = new Date().toISOString();
const hosts = HOSTS.filter((h) => !only || h.name === only).map((h) =>
  runHost(h, dryRun, timeoutMs),
);
const report = { startedAt, finishedAt: new Date().toISOString(), dryRun, hosts };
const stamp = startedAt.replaceAll(":", "-").replace(/\..*/, "");
const reportPath = join(outDir, `run-${stamp}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
for (const h of hosts) {
  console.log(`${h.host}: ${h.status}${h.reason ? ` (${h.reason})` : ""}`);
}
console.log(`report: test/eval/out/run-${stamp}.json`);
const launched = hosts.filter(
  (h) => h.status === "completed" || h.status === "failed" || h.status === "timeout",
);
process.exit(launched.every((h) => h.status === "completed") ? 0 : 1);
