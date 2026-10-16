// Claude Workflow -> Muse Workflow converter (codemod + gap report).
//
// Source dialect (Claude Workflow tool):
//   export const meta = { name, description, whenToUse, phases }
//   top-level await; globals agent(prompt, opts), parallel(thunks),
//   phase(title), log(msg), args. Custom opts.agentType names a file under
//   .claude/agents/<name>.md. Schemas are named consts, passed by reference.
//
// Target dialect (Muse Workflow tool):
//   export default async function workflow(host) { ... }
//   host.agent({ input, agentType, model, effort, schema, label }),
//   host.parallel([requestObjects]), host.phase(title), host.log(msg);
//   args / budget remain globals. Inline schemas may only use the keys
//   type, enum, required, properties, items (<=4 KiB, depth <=16, <=16
//   entries). Custom agentTypes do not exist: the catalogue is
//   general-purpose | workflow-subagent, so a custom type is rewritten to
//   general-purpose and reported; the agent file's prompt must be inlined
//   by hand (semantic port) before the output is runnable.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A single item needing human review in the conversion report.
 * @typedef {object} Gap
 * @property {string} kind
 * @property {number} line
 * @property {string} detail
 *
 * @typedef {object} SchemaInfo
 * @property {string} name
 * @property {number} line
 * @property {string[]} issues
 *
 * @typedef {object} AgentCallSite
 * @property {number} start
 * @property {number} openIdx
 * @property {number} closeIdx
 * @property {number} line
 *
 * @typedef {object} AgentTypeReport
 * @property {string} value
 * @property {string} muse
 * @property {string | null} agentFile
 * @property {boolean | null} agentFileExists
 * @property {string} action
 *
 * @typedef {object} ConvertReport
 * @property {string} input
 * @property {string | null} metaName
 * @property {number} agentCallSites
 * @property {number} parallelCallSites
 * @property {AgentTypeReport[]} agentTypes
 * @property {SchemaInfo[]} schemas
 * @property {string[]} banned
 * @property {Gap[]} gaps
 */

export const MUSE_AGENT_TYPES = new Set(["general-purpose", "workflow-subagent"]);
export const SCHEMA_KEYWORDS_OK = new Set(["type", "enum", "required", "properties", "items"]);
const SCHEMA_KEYWORDS_BAD = [
  "description",
  "additionalProperties",
  "$ref",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "default",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "examples",
  "title",
  "$schema",
];

// Find the index of the close char matching source[openIdx], skipping
// strings, template literals (with ${} nesting), and comments.
/**
 * @param {string} source
 * @param {number} openIdx
 * @param {string} open
 * @param {string} close
 * @returns {number} index of the match, or -1
 */
export function matchDelim(source, openIdx, open, close) {
  let depth = 0;
  let i = openIdx;
  let state = "code"; // code | sq | dq | tmpl | line | block
  const tmplStack = [];
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
      } else i += 1;
      continue;
    }
    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"';
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) state = "code";
      i += 1;
      continue;
    }
    if (state === "tmpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        i += 1;
        continue;
      }
      if (c === "$" && n === "{") {
        tmplStack.push(depth);
        state = "code";
        depth += 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // code
    if (c === "/" && n === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "'") {
      state = "sq";
      i += 1;
      continue;
    }
    if (c === '"') {
      state = "dq";
      i += 1;
      continue;
    }
    if (c === "`") {
      state = "tmpl";
      i += 1;
      continue;
    }
    if (c === "}" && tmplStack.length && depth === tmplStack[tmplStack.length - 1] + 1) {
      depth -= 1;
      tmplStack.pop();
      state = "tmpl";
      i += 1;
      continue;
    }
    if (c === open) depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Split a call's argument text on top-level commas.
/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let state = "code";
  const tmplStack = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1] ?? "";
    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"';
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === q) state = "code";
      continue;
    }
    if (state === "tmpl") {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "code";
        continue;
      }
      if (c === "$" && n === "{") {
        tmplStack.push(depth);
        state = "code";
        depth += 1;
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      state = "sq";
      continue;
    }
    if (c === '"') {
      state = "dq";
      continue;
    }
    if (c === "`") {
      state = "tmpl";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (tmplStack.length && depth === tmplStack[tmplStack.length - 1]) {
        tmplStack.pop();
        state = "tmpl";
      }
      continue;
    }
    if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * @param {string} source
 * @param {number} idx
 * @returns {number}
 */
export function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

// Split a { input: EXPR, ...rest } request object. Returns null when the
// text is not an object literal or the object has no input field.
/**
 * @param {string} obj
 * @returns {{ prompt: string, rest: string } | null}
 */
export function splitRequestObject(obj) {
  const trimmed = obj.trimStart();
  if (!trimmed.startsWith("{")) return null;
  const openIdx = obj.indexOf("{");
  const closeIdx = matchDelim(obj, openIdx, "{", "}");
  if (closeIdx < 0) return null;
  const parts = splitTopLevel(obj.slice(openIdx + 1, closeIdx));
  const at = parts.findIndex((p) => /^input\s*:/.test(p));
  if (at < 0) return null;
  const prompt = parts[at].slice(parts[at].indexOf(":") + 1).trim();
  const rest = parts.filter((_, i) => i !== at).join(", ");
  return { prompt, rest };
}

// Rewrite one agent(prompt[, opts]) call. Returns { code, gaps }.
/**
 * @param {string} inner
 * @param {Gap[]} gaps
 * @param {number} line
 * @returns {{ code: string }}
 */
function convertAgentCall(inner, gaps, line) {
  const args = splitTopLevel(inner);
  const prompt = args[0] ?? "";
  const opts = args[1];
  if (!opts) return { code: `host.agent({ input: ${prompt} })` };
  if (!opts.startsWith("{")) {
    gaps.push({
      kind: "dynamic-options",
      line,
      detail: `options from ${opts.slice(0, 60)} — spread as-is; verify agentType/schema by hand`,
    });
    return { code: `host.agent({ input: ${prompt}, ...${opts} })` };
  }
  const closeIdx = matchDelim(opts, 0, "{", "}");
  const body = opts.slice(1, closeIdx).trim();
  const typeMatch = body.match(/agentType\s*:\s*(['"])([^'"]+)\1/);
  let outBody = body;
  if (typeMatch && !MUSE_AGENT_TYPES.has(typeMatch[2])) {
    gaps.push({ kind: "agentType", line, detail: typeMatch[2] });
    outBody = body.replace(
      /agentType\s*:\s*(['"])([^'"]+)\1/,
      `agentType: "general-purpose" /* was: "${typeMatch[2]}" — inline .claude/agents/${typeMatch[2]}.md */`,
    );
  }
  return { code: `host.agent({ input: ${prompt}${outBody ? `, ${outBody}` : ""} })` };
}

/**
 * @param {string} source
 * @param {Gap[]} gaps
 * @returns {SchemaInfo[]}
 */
function analyzeSchemas(source, gaps) {
  /** @type {SchemaInfo[]} */
  const schemas = [];
  const re = /const\s+([A-Za-z_$][\w$]*(?:SCHEMA|Schema)[\w$]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const openIdx = source.indexOf("{", m.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    if (closeIdx < 0) continue;
    const literal = source.slice(openIdx, closeIdx + 1);
    const issues = [];
    for (const kw of SCHEMA_KEYWORDS_BAD) {
      const hit = new RegExp(`(^|[^\\w$])${kw.replace("$", "\\$")}\\s*:`).test(literal);
      if (hit) issues.push(`uses "${kw}", not allowed in Muse inline schemas`);
    }
    if (Buffer.byteLength(literal, "utf8") > 4096) issues.push("exceeds 4 KiB inline limit");
    schemas.push({ name: m[1], line: lineOf(source, m.index), issues });
    for (const issue of issues)
      gaps.push({ kind: "schema", line: lineOf(source, m.index), detail: `${m[1]}: ${issue}` });
  }
  return schemas;
}

// Convert Claude Workflow source to Muse Workflow source + gap report.
/**
 * @param {string} source
 * @param {{ inputName?: string, agentsDir?: string | null }} [options]
 * @returns {{ code: string, report: ConvertReport }}
 */
export function convert(source, { inputName = "<input>", agentsDir = null } = {}) {
  /** @type {Gap[]} */
  const gaps = [];
  let code = source;

  // meta: drop the export; the object stays as data (Muse takes the
  // workflow name/description at launch, not from an export).
  const metaMatch = code.match(/export\s+const\s+meta\s*=\s*\{/);
  let metaName = null;
  if (metaMatch) {
    const nameHit = code.slice(metaMatch.index).match(/name\s*:\s*(['"])([^'"]+)\1/);
    metaName = nameHit ? nameHit[2] : null;
    code = code.replace(
      /export\s+const\s+meta\b/,
      "const meta /* Muse: name/description move to the Workflow launch */",
    );
  } else {
    gaps.push({ kind: "meta", line: 1, detail: "no export const meta found" });
  }

  // agent(...) calls, rewritten right-to-left so offsets stay valid.
  /** @type {AgentCallSite[]} */
  const calls = [];
  const agentRe = /(?<![\w$.])agent\s*\(/g;
  let am;
  while ((am = agentRe.exec(code)) !== null) {
    const openIdx = code.indexOf("(", am.index);
    const closeIdx = matchDelim(code, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    calls.push({ start: am.index, openIdx, closeIdx, line: lineOf(code, am.index) });
  }
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    const inner = code.slice(call.openIdx + 1, call.closeIdx);
    const { code: replacement } = convertAgentCall(inner, gaps, call.line);
    code = code.slice(0, call.start) + replacement + code.slice(call.closeIdx + 1);
  }

  // Bare orchestration globals -> host.* methods.
  code = code.replace(/(?<![\w$.])phase\s*\(/g, "host.phase(");
  code = code.replace(/(?<![\w$.])log\s*\(/g, "host.log(");
  code = code.replace(/(?<![\w$.])parallel\s*\(/g, "host.parallel(");
  code = code.replace(/(?<![\w$.])pipeline\s*\(/g, "host.pipeline(");

  const schemas = analyzeSchemas(source, gaps);
  const agentTypes = [
    ...new Set(gaps.filter((g) => g.kind === "agentType").map((g) => g.detail)),
  ].sort();
  const agentTypeReport = agentTypes.map((value) => ({
    value,
    muse: "general-purpose",
    agentFile: agentsDir ? join(agentsDir, `${value}.md`) : null,
    agentFileExists: agentsDir ? existsSync(join(agentsDir, `${value}.md`)) : null,
    action:
      "inline the agent file's prompt into the call (or a shared prefix) — Muse has no per-file agent definitions",
  }));

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
  if (/^\s*import\s|require\s*\(/m.test(source))
    gaps.push({
      kind: "import",
      line: 1,
      detail: "imports/requires are not allowed in Workflow scripts",
    });

  const parallelSites = (source.match(/(?<![\w$.])parallel\s*\(/g) || []).length;
  if (calls.length > 15)
    gaps.push({
      kind: "fanout",
      line: 1,
      detail: `${calls.length} agent() call sites — a multi-round sweep exceeds the ~15-child guideline; chunk rounds across runs`,
    });
  if (!/^\s*return\b/m.test(source))
    gaps.push({
      kind: "return",
      line: 1,
      detail: "no top-level return — Muse expects the run to end with return { status, ref, text }",
    });

  const header = [
    `// Converted from Claude Workflow${metaName ? ` "${metaName}"` : ""} by workflow-port.`,
    "// Review every TODO/gap in the conversion report before running.",
    "",
  ].join("\n");
  const wrapped = `${header}export default async function workflow(host) {\n${code}\n}\n`;

  const report = {
    input: inputName,
    metaName,
    agentCallSites: calls.length,
    parallelCallSites: parallelSites,
    agentTypes: agentTypeReport,
    schemas,
    banned,
    gaps,
  };
  return { code: wrapped, report };
}
