// Claude Workflow as a target.
//
// Muse sources are converted by text transform (both dialects are JS, so
// control flow survives): the legacy workflow(host) wrapper is unwrapped
// (V1 body sources have no wrapper), choke-routed dispatches
// (agent(museDispatchArgs(prompt, opts)).then(museResult), in either the
// bare or the legacy host.agent form) are restored to agent(prompt, opts),
// request objects become parallel thunks, converter-injected shims are
// stripped, and host.phase/log/pipeline go bare. Grok sources arrive as
// canonical facts and are lowered to a skeleton with gaps, the same way
// the Grok emitter treats JS control flow.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { matchDelim, splitTopLevel, splitRequestObject, lineOf, codeOnly } from "./convert.mjs";
import { splitMuseDispatch } from "./muse.mjs";

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

// A Muse V1 body source carries converter fingerprints: the choke call,
// the role map, or a wfport Muse header. Anything else without the legacy
// wrapper is ambiguous with Claude (both use bare agent calls), so only
// then is the wrapper gap reported.
/**
 * @param {string} code
 * @returns {boolean}
 */
export function isMuseBody(code) {
  if (/museDispatchArgs|MUSE_ROLE_FOR|wfport:begin-helpers/.test(code)) return true;
  if (/Converted from (Claude Workflow|Grok) .*by workflow-port/.test(code)) return true;
  const masked = codeOnly(code);
  const re = /(?<![\w$.])(?:host\.)?agent\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (masked[m.index] === " ") continue;
    const openIdx = code.indexOf("(", m.index);
    const closeIdx = matchDelim(code, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    const args = splitTopLevel(code.slice(openIdx + 1, closeIdx));
    // agent({ input, ... }) with a single request object is the Muse call
    // shape — Claude always passes the prompt first.
    if (args.length === 1 && splitRequestObject(args[0])) return true;
    // host.agent in any form is Muse-shaped.
    if (/^host\./.test(code.slice(m.index, m.index + 5))) return true;
  }
  return false;
}

// Strip the converter-injected Muse shim block (wfport:begin-helpers
// through wfport:end-helpers) so it does not pollute the Claude script.
/**
 * @param {string} code
 * @returns {string}
 */
function stripMuseHelpers(code) {
  const begin = code.indexOf("// wfport:begin-helpers");
  if (begin < 0) return code;
  const endMarker = "// wfport:end-helpers";
  const endIdx = code.indexOf(endMarker, begin);
  if (endIdx < 0) return code;
  const endNl = code.indexOf("\n", endIdx);
  const after = endNl < 0 ? code.length : endNl + 1;
  const lineStart = code.lastIndexOf("\n", begin - 1) + 1;
  return code.slice(0, lineStart) + code.slice(after);
}

// Remove the `host.` prefix from host.<name>( calls in code, leaving
// comments and string/template text untouched.
/**
 * @param {string} code
 * @param {string} name
 * @returns {string}
 */
function unhost(code, name) {
  const re = new RegExp(`(?<![\\w$.])host\\.${name}\\s*\\(`, "g");
  const masked = codeOnly(code);
  /** @type {number[]} */
  const starts = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    if (masked[m.index] === " ") continue;
    starts.push(m.index);
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const s = starts[i];
    code = code.slice(0, s) + code.slice(s + "host.".length);
  }
  return code;
}

// Convert a Muse Workflow script (legacy wrapper or V1 body shape) to a
// Claude Workflow script.
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
  } else if (!isMuseBody(code)) {
    gaps.push({
      kind: "wrapper",
      line: 1,
      detail: "no export default async function workflow(host) wrapper — expected a Muse source",
    });
  }

  code = stripMuseHelpers(code);

  // A carried Claude meta (`const meta /* Muse: ... */ =`, left by a
  // Claude -> Muse run) becomes the export again instead of a TODO stub.
  let carriedMeta = false;
  const metaCarry = /const meta\s*\/\* Muse:[^*]*\*\/\s*=\s*\{/.exec(code);
  if (metaCarry && codeOnly(code)[metaCarry.index] !== " ") {
    code =
      code.slice(0, metaCarry.index) +
      "export const meta = {" +
      code.slice(metaCarry.index + metaCarry[0].length);
    carriedMeta = true;
  }

  /** @type {{ start: number, openIdx: number, closeIdx: number, line: number, isHost: boolean }[]} */
  const calls = [];
  const maskedCalls = codeOnly(code);
  for (const shape of [
    { re: /(?<![\w$.])host\.agent\s*\(/g, isHost: true },
    { re: /(?<![\w$.])agent\s*\(/g, isHost: false },
  ]) {
    let am;
    while ((am = shape.re.exec(code)) !== null) {
      if (maskedCalls[am.index] === " ") continue;
      const openIdx = code.indexOf("(", am.index);
      const closeIdx = matchDelim(code, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      calls.push({
        start: am.index,
        openIdx,
        closeIdx,
        line: lineOf(code, am.index),
        isHost: shape.isHost,
      });
    }
  }
  calls.sort((a, b) => b.start - a.start);
  for (const call of calls) {
    const inner = code.slice(call.openIdx + 1, call.closeIdx);
    // Choke-routed dispatch (new body shape and legacy 0.1.2 output):
    // agent(museDispatchArgs(prompt, opts)).then(museResult).
    const choke = splitMuseDispatch(inner);
    if (choke) {
      flagAgentType(choke.rest, gaps, call.line);
      let end = call.closeIdx + 1;
      const thenMatch = /^\s*\.then\s*\(\s*museResult\s*\)/.exec(code.slice(end));
      if (thenMatch) end += thenMatch[0].length;
      code =
        `${code.slice(0, call.start)}agent(${choke.prompt}` +
        `${choke.rest ? `, { ${choke.rest} }` : ""})${code.slice(end)}`;
      continue;
    }
    if (!call.isHost) continue; // already a Claude-shape bare call
    // host.agent takes a single request object, not (prompt, opts).
    const args = splitTopLevel(inner);
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

  /** @type {{ start: number, openIdx: number, closeIdx: number, isHost: boolean }[]} */
  const parallelSites = [];
  const maskedParallel = codeOnly(code);
  for (const shape of [
    { re: /(?<![\w$.])host\.parallel\s*\(/g, isHost: true },
    { re: /(?<![\w$.])parallel\s*\(/g, isHost: false },
  ]) {
    let pm;
    while ((pm = shape.re.exec(code)) !== null) {
      if (maskedParallel[pm.index] === " ") continue;
      const openIdx = code.indexOf("(", pm.index);
      const closeIdx = matchDelim(code, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      parallelSites.push({ start: pm.index, openIdx, closeIdx, isHost: shape.isHost });
    }
  }
  parallelSites.sort((a, b) => b.start - a.start);
  for (const site of parallelSites) {
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
      // Already a thunk — the agent pass above normalized its inner call.
      if (/^\(\)\s*=>\s*agent\s*\(/.test(trimmed)) return trimmed;
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

  code = unhost(code, "phase");
  code = unhost(code, "log");
  code = unhost(code, "pipeline");

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

  // A carried meta was restored to its export above, so no TODO stub and
  // no meta gap; every other Muse source needs name/description/whenToUse.
  const header = carriedMeta
    ? [
        `// Converted from Muse Workflow ${inputName} by workflow-port.`,
        "// Review every TODO/gap in the conversion report before running.",
        "",
      ].join("\n")
    : [
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
  if (!carriedMeta) {
    gaps.push({
      kind: "meta",
      line: 1,
      detail: "no meta export in a Muse source — fill in name/description/whenToUse",
    });
  }

  /** @type {string | null} */
  let metaName = null;
  if (carriedMeta) {
    const nameHit = code.match(/export\s+const\s+meta\s*=\s*\{[^}]*?name\s*:\s*(['"])([^'"]+)\1/);
    metaName = nameHit ? nameHit[2] : null;
  }
  const report = {
    input: inputName,
    source: "muse",
    target: "claude",
    metaName,
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
