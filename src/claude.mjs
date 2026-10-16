// Claude Workflow as a target.
//
// Muse sources are converted by text transform (both dialects are JS, so
// control flow survives): the workflow(host) wrapper is unwrapped,
// host.agent({ input, ... }) becomes agent(input, { ... }), request objects
// become parallel thunks, and host.phase/log/pipeline go bare. Grok sources
// arrive as canonical facts and are lowered to a skeleton with gaps, the
// same way the Grok emitter treats JS control flow.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { matchDelim, splitTopLevel, splitRequestObject, lineOf } from "./convert.mjs";

/**
 * @typedef {import("./convert.mjs").Gap} Gap
 * @typedef {import("./grok.mjs").WorkflowFacts} WorkflowFacts
 *
 * @typedef {object} MuseToClaudeReport
 * @property {string} input
 * @property {string} source
 * @property {string} target
 * @property {string | null} metaName
 * @property {number} agentCallSites
 * @property {number} parallelCallSites
 * @property {object[]} agentTypes
 * @property {object[]} schemas
 * @property {string[]} banned
 * @property {Gap[]} gaps
 */

/**
 * @param {string} rest
 * @param {Gap[]} gaps
 * @param {number} line
 */
function flagAgentType(rest, gaps, line) {
  const m = rest.match(/agentType\s*:\s*(['"])([^'"]+)\1/);
  if (m) {
    gaps.push({
      kind: "agentType",
      line,
      detail: `"${m[2]}" is a Muse built-in — point the call at a real .claude/agents/<name>.md file`,
    });
  } else if (/agentType\s*:/.test(rest)) {
    gaps.push({
      kind: "agentType",
      line,
      detail: "dynamic agentType — point the call at a real .claude/agents/<name>.md file",
    });
  }
}

// Convert a Muse Workflow module to a Claude Workflow script.
/**
 * @param {string} source
 * @param {{ inputName?: string, agentsDir?: string | null }} [options]
 * @returns {{ code: string, report: MuseToClaudeReport }}
 */
export function convertMuseToClaude(source, { inputName = "<input>", agentsDir = null } = {}) {
  /** @type {Gap[]} */
  const gaps = [];
  let code = source;

  const wrapMatch = code.match(
    /export\s+default\s+async\s+function\s+workflow\s*\(\s*host\s*\)\s*\{/,
  );
  if (wrapMatch && wrapMatch.index != null) {
    code = code.slice(0, wrapMatch.index) + code.slice(wrapMatch.index + wrapMatch[0].length);
    const withoutTrailing = code.replace(/\s+$/, "");
    if (withoutTrailing.endsWith("}")) {
      code = `${withoutTrailing.slice(0, withoutTrailing.lastIndexOf("}"))}\n`;
    } else {
      gaps.push({
        kind: "wrapper",
        line: 1,
        detail: "could not find the workflow(host) closing brace — check the unwrap by hand",
      });
    }
  } else {
    gaps.push({
      kind: "wrapper",
      line: 1,
      detail: "no export default async function workflow(host) wrapper — expected a Muse source",
    });
  }

  /** @type {{ start: number, openIdx: number, closeIdx: number, line: number }[]} */
  const calls = [];
  const agentRe = /host\.agent\s*\(/g;
  let am;
  while ((am = agentRe.exec(code)) !== null) {
    const openIdx = code.indexOf("(", am.index);
    const closeIdx = matchDelim(code, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    calls.push({ start: am.index, openIdx, closeIdx, line: lineOf(code, am.index) });
  }
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    // host.agent takes a single request object, not (prompt, opts).
    const args = splitTopLevel(code.slice(call.openIdx + 1, call.closeIdx));
    const first = args[0] ?? "";
    if (args.length > 1) {
      gaps.push({
        kind: "dynamic-options",
        line: call.line,
        detail: `unexpected extra argument ${args[1].slice(0, 60)} — map it onto agent() by hand`,
      });
    }
    const split = splitRequestObject(first);
    if (!split) {
      gaps.push({
        kind: "dynamic-options",
        line: call.line,
        detail: `request from ${first.slice(0, 60)} — map input/agentType/schema onto agent() by hand`,
      });
      code = `${code.slice(0, call.start)}agent(${first})${code.slice(call.closeIdx + 1)}`;
      continue;
    }
    flagAgentType(split.rest, gaps, call.line);
    code =
      `${code.slice(0, call.start)}agent(${split.prompt}` +
      `${split.rest ? `, { ${split.rest} }` : ""})${code.slice(call.closeIdx + 1)}`;
  }

  const parallelRe = /host\.parallel\s*\(/g;
  /** @type {{ start: number, openIdx: number, closeIdx: number }[]} */
  const parallelSites = [];
  let pm;
  while ((pm = parallelRe.exec(code)) !== null) {
    const openIdx = code.indexOf("(", pm.index);
    const closeIdx = matchDelim(code, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    parallelSites.push({ start: pm.index, openIdx, closeIdx });
  }
  for (let i = parallelSites.length - 1; i >= 0; i -= 1) {
    const site = parallelSites[i];
    const inner = code.slice(site.openIdx + 1, site.closeIdx);
    const arrOpen = inner.indexOf("[");
    const arrClose = arrOpen >= 0 ? matchDelim(inner, arrOpen, "[", "]") : -1;
    if (arrOpen < 0 || arrClose < 0) {
      gaps.push({
        kind: "parallel",
        line: lineOf(code, site.start),
        detail:
          "parallel() argument is not an array literal — rebuild as parallel([() => agent(...)])",
      });
      code = `${code.slice(0, site.start)}parallel(${inner})${code.slice(site.closeIdx + 1)}`;
      continue;
    }
    const elements = splitTopLevel(inner.slice(arrOpen + 1, arrClose)).map((element) => {
      const trimmed = element.trim();
      if (trimmed.startsWith("{")) {
        const split = splitRequestObject(trimmed);
        if (split) {
          flagAgentType(split.rest, gaps, lineOf(code, site.start));
          return `() => agent(${split.prompt}${split.rest ? `, { ${split.rest} }` : ""})`;
        }
      }
      if (/^agent\s*\(/.test(trimmed)) return `() => ${trimmed}`;
      gaps.push({
        kind: "parallel",
        line: lineOf(code, site.start),
        detail: `dynamic parallel entry ${trimmed.slice(0, 60)} — rebuild as () => agent(...)`,
      });
      return `() => ${trimmed}`;
    });
    code =
      `${code.slice(0, site.start)}parallel([${elements.join(", ")}])` +
      `${code.slice(site.closeIdx + 1)}`;
  }

  code = code.replace(/host\.phase\s*\(/g, "phase(");
  code = code.replace(/host\.log\s*\(/g, "log(");
  code = code.replace(/host\.pipeline\s*\(/g, "pipeline(");

  if (/schema\s*:\s*\{/.test(code)) {
    gaps.push({
      kind: "schema",
      line: 1,
      detail: "inline schema object — hoist to a named const for Claude",
    });
  }
  if (/^\s*import\s|require\s*\(/m.test(source)) {
    gaps.push({
      kind: "import",
      line: 1,
      detail: "imports/requires are not allowed in Workflow scripts",
    });
  }
  const banned = [];
  for (const pat of ["Date.now", "Math.random", "new Date("]) {
    if (source.includes(pat)) {
      banned.push(pat);
      gaps.push({
        kind: "banned-api",
        line: 1,
        detail: `${pat} throws under deterministic replay in both dialects`,
      });
    }
  }
  if (!/^\s*return\b/m.test(code)) {
    gaps.push({
      kind: "return",
      line: 1,
      detail: "no return — Claude scripts end with a top-level return carrying the result",
    });
  }

  const agentTypeNames = [
    ...new Set([...code.matchAll(/agentType\s*:\s*(['"])([^'"]+)\1/g)].map((m) => m[2])),
  ].sort();
  const agentTypes = agentTypeNames.map((value) => ({
    value,
    target: "claude",
    agentFile: agentsDir ? join(agentsDir, `${value}.md`) : null,
    agentFileExists: agentsDir ? existsSync(join(agentsDir, `${value}.md`)) : null,
    action:
      "point the call at a real agent file — Muse built-ins have no .claude/agents equivalent",
  }));

  const header = [
    `// Converted from Muse Workflow ${inputName} by workflow-port.`,
    "// Review every TODO/gap in the conversion report before running.",
    "",
    "export const meta = {",
    '  name: "TODO: workflow name",',
    '  description: "TODO: workflow description",',
    '  whenToUse: "TODO: when to use this workflow",',
    "  phases: [],",
    "};",
    "",
  ].join("\n");
  gaps.push({
    kind: "meta",
    line: 1,
    detail: "no meta export in a Muse source — fill in name/description/whenToUse",
  });

  const report = {
    input: inputName,
    source: "muse",
    target: "claude",
    metaName: null,
    agentCallSites: calls.length,
    parallelCallSites: parallelSites.length,
    agentTypes,
    schemas: [],
    banned,
    gaps,
  };
  return { code: `${header}${code}`, report };
}

// Carry a prompt to a Claude (JS) script. Anything that is not a plain JS
// string literal or bare identifier needs a human.
/**
 * @param {string} promptSrc
 * @returns {string | null}
 */
function jsPromptForClaude(promptSrc) {
  const t = promptSrc.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (/^'.*'$/.test(t) || /^`[^`]*$/.test(t)) return t;
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return t;
  return null;
}

// Lower canonical facts (from a Grok source) to a Claude script skeleton.
/**
 * @param {WorkflowFacts} facts
 * @param {{ inputName?: string, sourceName?: string }} [options]
 * @returns {{ code: string, gaps: Gap[] }}
 */
export function emitClaudeFromFacts(
  facts,
  { inputName = "<input>", sourceName = "Grok Build" } = {},
) {
  /** @type {Gap[]} */
  const gaps = [];
  /** @type {string[]} */
  const out = [];
  out.push(`// Converted from ${sourceName} ${inputName} by workflow-port.`);
  out.push("// Review every TODO/gap in the conversion report before running.");
  out.push("");

  if (facts.meta) {
    const m = facts.meta;
    out.push("export const meta = {");
    if (m.name) out.push(`  name: ${JSON.stringify(m.name)},`);
    else out.push('  name: "TODO: workflow name",');
    if (m.description) out.push(`  description: ${JSON.stringify(m.description)},`);
    if (m.whenToUse) out.push(`  whenToUse: ${JSON.stringify(m.whenToUse)},`);
    if (m.phases.length) {
      out.push("  phases: [");
      for (const t of m.phases) out.push(`    { title: ${JSON.stringify(t)} },`);
      out.push("  ],");
      gaps.push({
        kind: "meta",
        line: 1,
        detail: "phases carry titles only — add detail by hand",
      });
    }
    out.push("};");
    out.push("");
    if (!m.name) {
      gaps.push({ kind: "meta", line: 1, detail: "no meta name — fill it in" });
    }
  } else {
    out.push("export const meta = {");
    out.push('  name: "TODO: workflow name",');
    out.push('  description: "TODO: workflow description",');
    out.push('  whenToUse: "TODO: when to use this workflow",');
    out.push("  phases: [],");
    out.push("};");
    out.push("");
    gaps.push({
      kind: "meta",
      line: 1,
      detail: "no meta block — fill in name/description/whenToUse",
    });
  }

  let seq = 0;
  for (const call of facts.calls) {
    seq += 1;
    const prompt = jsPromptForClaude(call.promptSrc);
    if (prompt === null) {
      gaps.push({
        kind: "prompt",
        line: call.line,
        detail: "prompt expression could not be carried — re-express by hand",
      });
    }
    if (call.capability && call.capability !== "all") {
      gaps.push({
        kind: "capability",
        line: call.line,
        detail: `capability_mode "${call.capability}" — pick a .claude/agents/<name>.md file with matching tools`,
      });
    }
    if (call.agentType) {
      gaps.push({
        kind: "agentType",
        line: call.line,
        detail: `"${call.agentType}" — point the call at a real .claude/agents/<name>.md file`,
      });
    }
    if (call.schema) {
      gaps.push({
        kind: "schema",
        line: call.line,
        detail: `${call.schema}: the const was not carried — define it in the Claude script`,
      });
    } else if (call.schemaInline) {
      gaps.push({
        kind: "schema",
        line: call.line,
        detail: "inline output_schema map was not carried — hoist it to a named const",
      });
    }
    /** @type {string[]} */
    const opts = [];
    if (call.agentType) opts.push(`agentType: ${JSON.stringify(call.agentType)}`);
    if (call.label) opts.push(`label: ${JSON.stringify(call.label)}`);
    if (call.phase) opts.push(`phase: ${JSON.stringify(call.phase)}`);
    if (call.model) opts.push(`model: ${JSON.stringify(call.model)}`);
    if (call.schema) opts.push(`schema: ${call.schema}`);
    const promptExpr = prompt ?? `"TODO: translate prompt (source line ${call.line})"`;
    out.push(`// source line ${call.line}`);
    out.push(
      `const r${seq} = await agent(${promptExpr}${opts.length ? `, { ${opts.join(", ")} }` : ""});`,
    );
  }
  if (facts.calls.length) out.push("");

  if (facts.parallelSites > 0) {
    gaps.push({
      kind: "parallel",
      line: 1,
      detail: `${facts.parallelSites} parallel() site(s) — rebuild as parallel([() => agent(...)])`,
    });
    out.push("// TODO: rebuild each parallel() fan-out as parallel([() => agent(...)]), then:");
    out.push("");
  }

  gaps.push({
    kind: "control-flow",
    line: 1,
    detail: "Rhai control flow was not translated — rewrite branching/loops by hand",
  });
  out.push("// TODO: map the Grok complete() value here.");
  out.push(`return { result: ${seq > 0 ? `r${seq}` : "null"} };`);
  if (!facts.hasReturn) {
    gaps.push({
      kind: "return",
      line: 1,
      detail: "no complete() — end the script with a top-level return carrying the result",
    });
  }
  out.push("");

  return { code: out.join("\n"), gaps };
}
