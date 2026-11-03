#!/usr/bin/env node
// wfport — convert a workflow script from any dialect to another.
//
//   wfport <input> [-i claude|muse|grok] [-o muse|grok|claude]
//          [--out file] [--report file] [--agents-dir dir]
//
// The source dialect (-i/--input/--from) is inferred from the input path,
// then from the file content, and defaults to claude. The target
// (-o/--output/--to) defaults to muse for claude inputs and is required
// otherwise. Converted source goes to --out or stdout; the gap report
// (JSON) goes to --report or stderr.
// Exit 0 = converted; exit 1 = usage/config error; exit 2 = gaps need review.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../src/version.mjs";
import { maybeSelfUpdate } from "../src/self-update.mjs";
import { convert } from "../src/convert.mjs";
import { emitGrok, emitGrokFromFacts, extractGrokFacts } from "../src/grok.mjs";
import { extractMuseFacts, emitMuseFromFacts } from "../src/muse.mjs";
import { convertMuseToClaude, emitClaudeFromFacts } from "../src/claude.mjs";
import { detectSource, resolveTarget, isDialect, DIALECTS } from "../src/route.mjs";
import { verifyWorkflow, formatAgent, formatHuman } from "../src/verify.mjs";

/**
 * @typedef {import("../src/route.mjs").Dialect} Dialect
 * @typedef {import("../src/convert.mjs").Gap} Gap
 */

const USAGE = `usage: wfport <input> [-i dialect] [-o dialect] [--out file] [--report f] [--agents-dir dir]

  <input>                    source workflow file (any dialect)
  -i, --input, --from D      source dialect (${DIALECTS.join("|")}); inferred from path/content when omitted
  -o, --output, --to D      target dialect (${DIALECTS.join("|")}); default muse for claude inputs,
                             required otherwise
  --out, --out-file F        write converted source to F (default: stdout)
  --report F                 write gap report JSON to F (default: stderr)
  --agents-dir DIR           .claude/agents dir for agent-file checks (default: sibling ../agents)
  --no-update-check          skip the startup self-update check
  -h, --help                 show this help
  --version                  show the version

  wfport verify <input> [-i dialect] [--format agent|human|json]
                        [--agents-dir DIR] [--strict]
    validate a workflow file in any dialect; exits 0 when valid,
    2 when errors are found (or warnings with --strict)

Examples:
  wfport flow.js                                        # claude -> muse to stdout
  wfport flow.js --to grok --out flow.rhai
  wfport .grok/workflows/flow.rhai -o muse --out flow.muse.js
  wfport verify flow.js --format agent                  # compact check for agents
  wfport verify flow.rhai                               # human-readable check

Exit codes: 0 clean (or valid for verify), 1 usage or config error, 2 gaps/errors need review.
Without --out the converted source goes to stdout; without --report the
gap report JSON goes to stderr.`;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`wfport: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
if (argv.includes("--version")) {
  console.log(`wfport ${VERSION}`);
  process.exit(0);
}

const updateResult = await maybeSelfUpdate();
if (updateResult === "updated") process.exit(0);
if (updateResult === "update-failed") process.exit(1);

if (argv[0] === "verify") {
  runVerify(argv.slice(1));
}

/**
 * Validate a workflow file in any dialect and report the result.
 * --format agent is a compact line protocol for agents; human (default)
 * adds source context, hints, and next steps; json emits the raw result.
 * Exits 0 when valid, 2 on errors (or warnings with --strict), 1 on usage.
 * @param {string[]} args
 * @returns {never}
 */
function runVerify(args) {
  /** @type {string | null} */
  let verifyInput = null;
  /** @type {string | null} */
  let verifyDialectOpt = null;
  /** @type {string} */
  let format = "human";
  /** @type {string | null} */
  let verifyAgentsDir = null;
  let strict = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-i" || arg === "--input" || arg === "--from") {
      const value = args[i + 1];
      if (value == null || value.startsWith("-")) fail(`${arg} requires a value`);
      verifyDialectOpt = /** @type {string} */ (value);
      i += 1;
    } else if (arg === "--format") {
      const value = args[i + 1];
      if (value == null || value.startsWith("-")) fail("--format requires a value");
      format = value;
      i += 1;
    } else if (arg === "--agents-dir") {
      const value = args[i + 1];
      if (value == null || value.startsWith("-")) fail("--agents-dir requires a value");
      verifyAgentsDir = value;
      i += 1;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--no-update-check") {
      // Handled before parsing by maybeSelfUpdate(); accepted here so it parses.
    } else if (arg.startsWith("-")) {
      fail(`unknown flag ${arg}\n${USAGE}`);
    } else if (verifyInput) {
      fail("only one input file is allowed");
    } else {
      verifyInput = arg;
    }
  }
  if (!verifyInput) fail(`missing <input>\n${USAGE}`);
  if (verifyDialectOpt && !isDialect(verifyDialectOpt))
    fail(`unknown dialect "${verifyDialectOpt}" — expected one of ${DIALECTS.join("|")}`);
  if (format !== "agent" && format !== "human" && format !== "json")
    fail(`unknown format "${format}" — expected one of agent|human|json`);

  /** @type {string} */
  let verifyText;
  try {
    verifyText = readFileSync(/** @type {string} */ (verifyInput), "utf8");
  } catch {
    fail(`cannot read ${/** @type {string} */ (verifyInput)}`);
    throw new Error("unreachable");
  }
  const inputName = /** @type {string} */ (verifyInput);
  const dialect = detectSource(inputName, verifyText, verifyDialectOpt);
  const agentsDir = verifyAgentsDir ?? join(dirname(inputName), "..", "agents");
  const result = verifyWorkflow(verifyText, dialect, { agentsDir });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (format === "agent") {
    process.stdout.write(formatAgent(result, inputName));
  } else {
    process.stdout.write(formatHuman(result, inputName, verifyText));
  }
  const failed = !result.ok || (strict && result.warnings.length > 0);
  process.exit(failed ? 2 : 0);
}

/** @type {string | null} */
let input = null;
/** @type {string | null} */
let inputOpt = null;
/** @type {string[]} */
const targetRaws = [];
/** @type {string | null} */
let outFile = null;
/** @type {string | null} */
let reportFile = null;
/** @type {string | null} */
let agentsDirOpt = null;

/**
 * Consume the next argv element as a flag value.
 * @param {string} flag
 * @param {number} i
 * @returns {string}
 */
function takeValue(flag, i) {
  const value = argv[i + 1];
  if (value == null || value.startsWith("-")) fail(`${flag} requires a value`);
  return /** @type {string} */ (argv[i + 1]);
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "-i" || arg === "--input" || arg === "--from") {
    inputOpt = takeValue(arg, i);
    i += 1;
  } else if (arg === "-o" || arg === "--output" || arg === "--to") {
    targetRaws.push(takeValue(arg, i));
    i += 1;
  } else if (arg === "--out" || arg === "--out-file") {
    if (outFile) fail("only one output file is allowed");
    outFile = takeValue(arg, i);
    i += 1;
  } else if (arg === "--report") {
    reportFile = takeValue(arg, i);
    i += 1;
  } else if (arg === "--agents-dir") {
    agentsDirOpt = takeValue(arg, i);
    i += 1;
  } else if (arg === "--no-update-check") {
    // Handled before parsing by maybeSelfUpdate(); accepted here so it parses.
  } else if (arg.startsWith("-")) {
    fail(`unknown flag ${arg}\n${USAGE}`);
  } else if (input) {
    fail("only one input file is allowed");
  } else {
    input = arg;
  }
}
if (!input) fail(`missing <input>\n${USAGE}`);
if (inputOpt && !isDialect(inputOpt))
  fail(`unknown input "${inputOpt}" — expected one of ${DIALECTS.join("|")}`);

/** @type {Dialect | null} */
let targetOpt = null;
/** @type {string | null} */
let legacyOutFile = null;
for (const raw of targetRaws) {
  if (isDialect(raw)) {
    if (targetOpt && targetOpt !== raw) fail(`conflicting targets ${targetOpt} and ${raw}`);
    targetOpt = raw;
  } else if (legacyOutFile && legacyOutFile !== raw) {
    fail("only one output file is allowed");
  } else {
    legacyOutFile = raw;
  }
}
if (legacyOutFile) {
  console.error(
    "wfport: warning: -o <file> is deprecated — use --out <file>; -o now selects the target dialect",
  );
  if (outFile) fail("cannot combine --out with -o <file>");
  outFile = legacyOutFile;
}

/** @type {string} */
let sourceText;
try {
  sourceText = readFileSync(/** @type {string} */ (input), "utf8");
} catch {
  fail(`cannot read ${/** @type {string} */ (input)}`);
  throw new Error("unreachable");
}

const source = detectSource(/** @type {string} */ (input), sourceText, inputOpt);
let target;
try {
  target = resolveTarget(source, targetOpt);
} catch (/** @type {unknown} */ err) {
  fail(/** @type {Error} */ (err).message);
  throw new Error("unreachable");
}

const agentsDir = agentsDirOpt ?? join(dirname(/** @type {string} */ (input)), "..", "agents");

/** @type {string} */
let code;
/** @type {Record<string, unknown>} */
let report;
if (source === "claude" && target === "muse") {
  const out = convert(sourceText, {
    inputName: /** @type {string} */ (input),
    agentsDir,
  });
  code = out.code;
  report = { ...out.report, source, target };
} else if (source === "claude" && target === "grok") {
  const grok = emitGrok(sourceText, {
    inputName: /** @type {string} */ (input),
    agentsDir,
  });
  code = grok.code;
  report = {
    input,
    source,
    target,
    agentCallSites: grok.facts.calls.length,
    parallelCallSites: grok.facts.parallelSites,
    metaName: grok.facts.meta?.name ?? null,
    gaps: grok.gaps,
  };
} else if (source === "muse" && target === "grok") {
  const facts = extractMuseFacts(sourceText);
  const grok = emitGrokFromFacts(facts, {
    inputName: /** @type {string} */ (input),
    sourceName: "Muse Workflow",
    agentsDir,
  });
  code = grok.code;
  report = {
    input,
    source,
    target,
    agentCallSites: facts.calls.length,
    parallelCallSites: facts.parallelSites,
    metaName: null,
    gaps: grok.gaps,
  };
} else if (source === "muse" && target === "claude") {
  const out = convertMuseToClaude(sourceText, {
    inputName: /** @type {string} */ (input),
    agentsDir,
  });
  code = out.code;
  report = { ...out.report };
} else if (source === "grok" && target === "muse") {
  const facts = extractGrokFacts(sourceText);
  const muse = emitMuseFromFacts(facts, { inputName: /** @type {string} */ (input) });
  code = muse.code;
  report = {
    input,
    source,
    target,
    agentCallSites: facts.calls.length,
    parallelCallSites: facts.parallelSites,
    metaName: facts.meta?.name ?? null,
    gaps: muse.gaps,
  };
} else {
  const facts = extractGrokFacts(sourceText);
  const claude = emitClaudeFromFacts(facts, { inputName: /** @type {string} */ (input) });
  code = claude.code;
  report = {
    input,
    source,
    target,
    agentCallSites: facts.calls.length,
    parallelCallSites: facts.parallelSites,
    metaName: facts.meta?.name ?? null,
    gaps: claude.gaps,
  };
}

/**
 * Write a file, creating missing parent directories (e.g. `.grok/workflows/`
 * on first conversion into a project) instead of crashing with ENOENT.
 * @param {string} file
 * @param {string} content
 * @returns {void}
 */
function writeOutputFile(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

if (outFile) writeOutputFile(outFile, code);
else process.stdout.write(code);

const reportText = JSON.stringify(report, null, 2);
if (reportFile) writeOutputFile(reportFile, reportText + "\n");
else console.error(reportText);

process.exit(/** @type {Gap[]} */ (report.gaps).length > 0 ? 2 : 0);
