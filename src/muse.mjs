// Muse Workflow as a source and target.
//
// Muse sources already use the canonical host.agent request-object shape,
// so extraction is mechanical: input becomes the prompt, the remaining
// object fields map one-to-one. Muse has no meta export (name/description
// move to the Workflow launch), so every conversion away from Muse reports
// a meta gap, and every conversion to Muse reports one when the incoming
// meta has nowhere to go.

import { matchDelim, splitTopLevel, splitRequestObject, lineOf } from "./convert.mjs";
import { field, fieldIdent } from "./grok.mjs";

/**
 * @typedef {import("./convert.mjs").Gap} Gap
 * @typedef {import("./grok.mjs").WorkflowFacts} WorkflowFacts
 */

// Extract canonical facts from a Muse Workflow module.
/**
 * @param {string} source
 * @returns {WorkflowFacts}
 */
export function extractMuseFacts(source) {
  /** @type {WorkflowFacts} */
  const facts = {
    meta: null,
    calls: [],
    parallelSites: (source.match(/host\.parallel\s*\(/g) || []).length,
    hasReturn: /^\s*return\b/m.test(source),
  };
  const agentRe = /host\.agent\s*\(/g;
  let am;
  while ((am = agentRe.exec(source)) !== null) {
    const openIdx = source.indexOf("(", am.index);
    const closeIdx = matchDelim(source, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    // host.agent takes a single request object; fields other than input
    // are read from the remainder so a prompt mentioning "label:" cannot
    // shadow the real options.
    const args = splitTopLevel(source.slice(openIdx + 1, closeIdx));
    const split = args[0] ? splitRequestObject(args[0]) : null;
    const restBody = split ? `{ ${split.rest} }` : "";
    const schema = split ? fieldIdent(restBody, "schema") : null;
    facts.calls.push({
      line: lineOf(source, am.index),
      promptSrc: split ? split.prompt : (args[0] ?? ""),
      agentType: split ? field(restBody, "agentType") : null,
      label: split ? field(restBody, "label") : null,
      phase: split ? field(restBody, "phase") : null,
      model: split ? field(restBody, "model") : null,
      schema,
      schemaInline: split != null && !schema && /schema\s*:/.test(restBody) ? true : undefined,
      capability: undefined,
      dynamicOpts: split == null ? true : undefined,
      inParallel:
        /parallel\s*\([^)]*$/.test(source.slice(Math.max(0, am.index - 200), am.index)) ||
        undefined,
    });
  }
  return facts;
}

// Carry a prompt expression to a Muse (JS) module. Rhai prompts arrive
// pre-normalized as JSON strings, which are valid JS too; JS expressions
// pass through untouched. Only an unparseable quoted string needs a human.
/**
 * @param {string} promptSrc
 * @returns {string | null}
 */
function jsPrompt(promptSrc) {
  const t = promptSrc.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return null;
    }
  }
  return t;
}

/**
 * @param {string | null} value
 * @param {string} key
 * @returns {string | null}
 */
function jsField(value, key) {
  return value == null ? null : `${key}: ${JSON.stringify(value)}`;
}

// Lower canonical facts to a Muse Workflow module skeleton.
/**
 * @param {WorkflowFacts} facts
 * @param {{ inputName?: string, sourceName?: string }} [options]
 * @returns {{ code: string, gaps: Gap[] }}
 */
export function emitMuseFromFacts(
  facts,
  { inputName = "<input>", sourceName = "Grok Build" } = {},
) {
  /** @type {Gap[]} */
  const gaps = [];
  /** @type {string[]} */
  const out = [];
  out.push(`// Converted from ${sourceName} ${inputName} by workflow-port.`);
  out.push("// Review every TODO/gap in the conversion report before running.");
  out.push("export default async function workflow(host) {");

  if (facts.meta?.name)
    out.push(`  // Meta "${facts.meta.name}" — pass name/description at the Workflow launch.`);
  gaps.push({
    kind: "meta",
    line: 1,
    detail: facts.meta?.name
      ? `"${facts.meta.name}" lives in Grok meta — move it to the Workflow launch`
      : "no meta block — Muse takes name/description at launch",
  });

  let seq = 0;
  for (const call of facts.calls) {
    seq += 1;
    const prompt = jsPrompt(call.promptSrc);
    if (prompt === null) {
      gaps.push({
        kind: "prompt",
        line: call.line,
        detail: "prompt string could not be carried — re-express by hand",
      });
    }
    if (call.capability && call.capability !== "all") {
      gaps.push({
        kind: "capability",
        line: call.line,
        detail: `capability_mode "${call.capability}" has no Muse equivalent — scope the call down by hand`,
      });
    }
    if (call.schema) {
      gaps.push({
        kind: "output_schema",
        line: call.line,
        detail: `${call.schema}: confirm keys against the Muse inline-schema subset (type/enum/required/properties/items)`,
      });
    } else if (call.schemaInline) {
      gaps.push({
        kind: "output_schema",
        line: call.line,
        detail: "inline output_schema map was not carried — re-add a Muse schema by hand",
      });
    }
    if (call.dynamicOpts) {
      gaps.push({
        kind: "dynamic-options",
        line: call.line,
        detail:
          "options built dynamically — map agentType/schema onto the host.agent request by hand",
      });
    }
    /** @type {string[]} */
    const opts = [];
    for (const rendered of [
      call.agentType ? `agentType: ${JSON.stringify(call.agentType)}` : null,
      jsField(call.label, "label"),
      jsField(call.phase, "phase"),
      jsField(call.model, "model"),
      call.schema ? `schema: ${call.schema}` : null,
    ]) {
      if (rendered) opts.push(rendered);
    }
    const promptExpr = prompt ?? `"TODO: translate prompt (source line ${call.line})"`;
    out.push(`  // source line ${call.line}`);
    out.push(
      `  const r${seq} = await host.agent({ input: ${promptExpr}${opts.length ? `, ${opts.join(", ")}` : ""} });`,
    );
  }

  if (facts.parallelSites > 0) {
    gaps.push({
      kind: "parallel",
      line: 1,
      detail: `${facts.parallelSites} parallel() site(s) — rebuild the job list as host.parallel([requests])`,
    });
    out.push("  // TODO: rebuild each parallel() fan-out as host.parallel([requests]), then:");
  }

  gaps.push({
    kind: "control-flow",
    line: 1,
    detail: "Rhai control flow was not translated — rewrite branching/loops by hand",
  });
  out.push("  // TODO: map the Grok complete() value here.");
  out.push(
    `  return { status: "converted", ref: ${seq > 0 ? `r${seq}` : "null"}, text: "converted" };`,
  );
  if (!facts.hasReturn) {
    gaps.push({
      kind: "return",
      line: 1,
      detail: "no complete() — end the run with return { status, ref, text }",
    });
  }
  out.push("}");
  out.push("");

  return { code: out.join("\n"), gaps };
}
