#!/usr/bin/env node
// Usage:
//   wfport <input.js> [-o output.js] [--report report.json]
//                     [--agents-dir path/to/.claude/agents]
// Without -o the converted source goes to stdout; the gap report
// (JSON) always goes to stderr unless --report writes it to a file.
// Exit 0 = converted; exit 2 = converted with gaps needing review.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convert } from "../src/convert.mjs";
import { emitGrok } from "../src/grok.mjs";

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith("-"));
if (!input) {
  console.error("usage: wfport <input.js> [-o output.js] [--report f] [--agents-dir dir]");
  process.exit(1);
}
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const source = readFileSync(input, "utf8");
const target = opt("--to") ?? "muse";
let code;
let report;
if (target === "grok") {
  const grok = emitGrok(source, { inputName: input });
  code = grok.code;
  report = { input, target: "grok", agentCallSites: grok.facts.calls.length, parallelCallSites: grok.facts.parallelSites, metaName: grok.facts.meta?.name ?? null, gaps: grok.gaps };
} else {
  const agentsDir = opt("--agents-dir") ?? join(dirname(input), "..", "agents");
  ({ code, report } = convert(source, { inputName: input, agentsDir }));
}

const out = opt("-o");
if (out) writeFileSync(out, code);
else process.stdout.write(code);

const reportText = JSON.stringify(report, null, 2);
const reportFile = opt("--report");
if (reportFile) writeFileSync(reportFile, reportText + "\n");
else console.error(reportText);

process.exit(report.gaps.length > 0 ? 2 : 0);
