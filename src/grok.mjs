// Grok Build (Rhai) emitter — derives from the same canonical call-site
// facts as the Muse emitter, per the hub-and-spoke design: Muse's
// host.agent request-object shape is canonical; Claude and Grok are derived.
//
// Grok dialect (xai-workflow, .grok/workflows/*.rhai):
//   let meta = #{ name, description, when_to_use, phases: [#{ title, detail }] };
//   agent(prompt, #{ label, capability_mode, output_schema, phase, model })
//   parallel([#{ prompt, label, ... }])  // barrier; jobs built as a list
//   phase(title), log(msg), complete(value), budget()
// Arbitrary JS control flow has no mechanical Rhai equivalent, so this
// emitter produces a faithful skeleton: meta + every agent call lowered to
// agent()/parallel() with mapped options, and gaps for everything else.

import { matchDelim, splitTopLevel, lineOf } from "./convert.mjs";

/**
 * @typedef {import("./convert.mjs").Gap} Gap
 *
 * @typedef {object} GrokMeta
 * @property {string | null} name
 * @property {string | null} description
 * @property {string | null} whenToUse
 * @property {string[]} phases
 *
 * @typedef {object} AgentCallFact
 * @property {number} line
 * @property {string} promptSrc
 * @property {string | null} agentType
 * @property {string | null} label
 * @property {string | null} phase
 * @property {string | null} model
 * @property {string | null} schema
 * @property {boolean | undefined} inParallel
 *
 * @typedef {object} WorkflowFacts
 * @property {GrokMeta | null} meta
 * @property {AgentCallFact[]} calls
 * @property {number} parallelSites
 * @property {boolean} hasReturn
 *
 * @typedef {object} GrokReport
 * @property {string} input
 * @property {string} target
 * @property {number} agentCallSites
 * @property {number} parallelCallSites
 * @property {string | null} metaName
 * @property {Gap[]} gaps
 */

const READONLY_HINT = /review|readonly|scout|triage|analyst|discover/;

/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
function field(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*(['"\`])([^'"\`]*)\\1`));
  return m ? m[2] : null;
}
/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
function fieldIdent(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`));
  return m ? m[1] : null;
}
/**
 * @param {string} text
 * @returns {string}
 */
function rhaiString(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// Translate a JS prompt expression to a Rhai string, or null if it needs
// hand translation (interpolation / arbitrary expression).
/**
 * @param {string} promptSrc
 * @returns {string | null}
 */
function rhaiPrompt(promptSrc) {
  const t = promptSrc.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return rhaiString(
        JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1).replace(/"/g, '\\"')}"` : t),
      );
    } catch {
      return null;
    }
  }
  if (t.startsWith("`") && t.endsWith("`") && !t.includes("${")) {
    return rhaiString(t.slice(1, -1));
  }
  return null;
}

// Extract canonical facts (the host.agent request shape) from Claude source.
/**
 * @param {string} source
 * @returns {WorkflowFacts}
 */
export function extractFacts(source) {
  /** @type {WorkflowFacts} */
  const facts = {
    meta: null,
    calls: [],
    parallelSites: 0,
    hasReturn: /^\s*return\b/m.test(source),
  };
  const metaMatch = source.match(/export\s+const\s+meta\s*=\s*\{/);
  if (metaMatch) {
    const openIdx = source.indexOf("{", metaMatch.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    const block = closeIdx > 0 ? source.slice(openIdx, closeIdx + 1) : "";
    const titles = [...block.matchAll(/title\s*:\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
    facts.meta = {
      name: field(block, "name"),
      description: field(block, "description"),
      whenToUse: field(block, "whenToUse"),
      phases: titles,
    };
  }
  const agentRe = /(?<![\w$.])agent\s*\(/g;
  let am;
  while ((am = agentRe.exec(source)) !== null) {
    const openIdx = source.indexOf("(", am.index);
    const closeIdx = matchDelim(source, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    const args = splitTopLevel(source.slice(openIdx + 1, closeIdx));
    const opts = args[1] && args[1].startsWith("{") ? args[1] : null;
    const body = opts ? opts.slice(1, matchDelim(opts, 0, "{", "}")) : "";
    facts.calls.push({
      line: lineOf(source, am.index),
      promptSrc: args[0] ?? "",
      agentType: field(body, "agentType"),
      label: field(body, "label"),
      phase: field(body, "phase"),
      model: field(body, "model"),
      schema: fieldIdent(body, "schema"),
      // A call inside parallel([...]) thunks is lowered as a job map instead.
      inParallel:
        /parallel\s*\([^)]*$/.test(source.slice(Math.max(0, am.index - 200), am.index)) ||
        undefined,
    });
  }
  facts.parallelSites = (source.match(/(?<![\w$.])parallel\s*\(/g) || []).length;
  return facts;
}

/**
 * @param {string} source
 * @param {{ inputName?: string }} [options]
 * @returns {{ code: string, facts: WorkflowFacts, gaps: Gap[] }}
 */
export function emitGrok(source, { inputName = "<input>" } = {}) {
  const facts = extractFacts(source);
  /** @type {Gap[]} */
  const gaps = [];
  /** @type {string[]} */
  const out = [];
  out.push(`// Grok Build workflow derived from Claude Workflow ${inputName} via the`);
  out.push("// canonical host.agent form. Skeleton: translate flagged prompts and");
  out.push("// control flow by hand before running.");
  out.push("");

  if (facts.meta) {
    const m = facts.meta;
    out.push("let meta = #{");
    if (m.name) out.push(`    name: ${rhaiString(m.name)},`);
    if (m.description) out.push(`    description: ${rhaiString(m.description)},`);
    if (m.whenToUse) out.push(`    when_to_use: ${rhaiString(m.whenToUse)},`);
    if (m.phases.length) {
      out.push("    phases: [");
      for (const t of m.phases) out.push(`        #{ title: ${rhaiString(t)} },`);
      out.push("    ],");
    }
    out.push("};");
    out.push("");
  } else {
    gaps.push({
      kind: "meta",
      line: 1,
      detail: "no meta block — Grok requires meta as the first statement",
    });
  }

  let seq = 0;
  for (const call of facts.calls) {
    seq += 1;
    const prompt = rhaiPrompt(call.promptSrc);
    if (prompt === null) {
      gaps.push({
        kind: "prompt",
        line: call.line,
        detail:
          "prompt uses JS interpolation/expression — re-express with Rhai concatenation and json_encode for untrusted data",
      });
    }
    const capability = call.agentType && READONLY_HINT.test(call.agentType) ? "read-only" : "all";
    if (call.agentType) {
      gaps.push({
        kind: "capability_mode",
        line: call.line,
        detail: `${call.agentType} -> capability_mode "${capability}" (placeholder — confirm against the agent file's tools)`,
      });
    }
    if (call.schema) {
      gaps.push({
        kind: "output_schema",
        line: call.line,
        detail: `${call.schema}: re-quote keys as a Grok map #{ "type": ... } — Grok validates output_schema host-side`,
      });
    }
    /** @type {string[]} */
    const opts = [];
    if (call.label) opts.push(`label: ${rhaiString(call.label)}`);
    opts.push(`capability_mode: ${rhaiString(capability)}`);
    if (call.phase) opts.push(`phase: ${rhaiString(call.phase)}`);
    if (call.model) opts.push(`model: ${rhaiString(call.model)}`);
    if (call.schema) opts.push(`output_schema: ${call.schema}`);
    const promptExpr = prompt ?? rhaiString(`TODO: translate prompt (source line ${call.line})`);
    out.push(
      `// source line ${call.line}${call.agentType ? `, agentType "${call.agentType}"` : ""}`,
    );
    out.push(`let r${seq} = agent(`);
    out.push(`    ${promptExpr},`);
    out.push(`    #{ ${opts.join(", ")} },`);
    out.push(");");
    out.push("");
  }

  if (facts.parallelSites > 0) {
    gaps.push({
      kind: "parallel",
      line: 1,
      detail: `${facts.parallelSites} parallel() site(s) — Grok parallel takes a prebuilt job list [#{ prompt, label, ... }]; rebuild the job construction, do not port JS thunks`,
    });
    out.push("// TODO: rebuild each parallel() fan-out as a job list, then:");
    out.push("// let panel = parallel(jobs);");
    out.push("");
  }

  gaps.push({
    kind: "control-flow",
    line: 1,
    detail:
      "JS loops/conditionals/helpers were not translated — Rhai control flow must be rewritten by hand",
  });
  if (!facts.hasReturn) {
    gaps.push({
      kind: "complete",
      line: 1,
      detail:
        "no top-level return — end the Rhai script with complete(#{ ... }) carrying the result value",
    });
  }
  out.push("// TODO: map the workflow result value (Muse return / Claude return) here.");
  out.push('complete(#{ status: "converted" });');
  out.push("");

  return { code: out.join("\n"), facts, gaps };
}
