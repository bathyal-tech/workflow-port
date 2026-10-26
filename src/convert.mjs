// Claude Workflow -> Muse Workflow converter (codemod + gap report).
//
// Source dialect (Claude Workflow tool):
//   export const meta = { name, description, whenToUse, phases }
//   top-level await; globals agent(prompt, opts), parallel(thunks),
//   phase(title), log(msg), args. Custom opts.agentType names a file under
//   .claude/agents/<name>.md. Schemas are named consts, passed by reference.
//
// Target dialect (Muse Workflow tool, V1 script body):
//   top-level await; bare globals agent, parallel, phase, log, pipeline,
//   args, budget — no wrapper function, no export, no host object.
//   agent({ input, agentType, model, effort, schema, label }) (positional
//   agent(prompt, opts) also works), parallel([requestObjects]).
//   The runner wraps the script as a function body, so any export fails
//   the preflight while a top-level return is legal (it lands inside the
//   runner's wrapper).
//   Inline schemas may only use the keys
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
// NOTE: "description" and "title" are checked separately (string-valued only):
// `title: { type: "string" }` is a data field name, not a schema keyword.
const SCHEMA_KEYWORDS_BAD = [
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
  "$schema",
];

// Short role prompts prepended when a Claude-only agentType is mapped to
// general-purpose. Defaults refined from the toil-block port; unknown custom
// types get a generic mechanical-runner prompt (refine by inlining the
// .claude/agents/<name>.md file).
export const MUSE_KNOWN_ROLES = {
  "tl-runner":
    "You are a mechanical runner for the toil-block workflow. Do the bounded shell and file work in your brief step by step with the tools you have, and report facts as structured data. Change nothing you were not asked to change.",
  "tl-select":
    "You are the toil-block selector. Run the selection walk in your brief and return the pick as structured data. Change nothing on the board or in the tree.",
  "tl-fix":
    "You are the toil-block fixer. First a reproduction test watched red on the unfixed code, then the fix, to one PR. Never merge.",
  "tl-reflect":
    "You are the toil-block reflector. At most one small fix to this loop's own files; anything bigger is a sentence in the report.",
  "tl-reporter":
    "You are the toil-block reporter. Write the run record with the manifest commands you are given, verbatim.",
  "readonly-reviewer":
    "You are a read-only reviewer. Read the diff and surrounding code, then report findings. Edit nothing and run no commands.",
};

/**
 * Role prompt for a custom agent type: a known short prompt, else a generic
 * mechanical-runner prompt carrying the type name.
 * @param {string} name
 * @returns {string}
 */
export function museRoleFor(name) {
  const known = /** @type {Record<string, string>} */ (MUSE_KNOWN_ROLES)[name];
  if (known) return known;
  return (
    `You are a ${name} agent. Follow the brief step by step with the tools ` +
    `you have, and report facts as structured data. Change nothing you were not asked to change.`
  );
}

/**
 * Emit the injected runtime helpers (role map, envelope unwrap, dispatch
 * choke point) for the given custom agent types.
 * @param {string[]} customTypes
 * @returns {string}
 */
export function museHelpers(customTypes) {
  const entries = customTypes.map(
    (t) => `  ${JSON.stringify(t)}: ${JSON.stringify(museRoleFor(t))},`,
  );
  return [
    "// wfport:begin-helpers (converter-injected Muse shims — deleted on conversion back to Claude)",
    "// Muse port: agent resolves to an envelope { ref, data, ... } —",
    "// museResult unwraps to data, mapping errors/stalls (error_kind) to null",
    "// so callers hit the resume path instead of operating on empty values.",
    "// museDispatchArgs maps Claude-only agentTypes to general-purpose with the",
    "// role prompt prepended, and drops Claude-only model pins (the session",
    "// route inherits). Central choke point so dynamic option flows",
    "// (spec.agentType, options.runnerType) are covered too.",
    "const MUSE_ROLE_FOR = {",
    ...entries,
    "};",
    "const museResult = (res) => {",
    "  if (res === null || res === undefined) return null;",
    '  if (typeof res === "object" && res.error_kind) return null;',
    '  if (typeof res === "object" && "data" in res) return res.data ?? null;',
    "  return res;",
    "};",
    "const museDispatchArgs = (input, opts) => {",
    '  const t = opts && typeof opts.agentType === "string" ? opts.agentType : "";',
    "  const role = MUSE_ROLE_FOR[t];",
    "  const out = { ...(opts || {}) };",
    '  if (t !== "general-purpose" && t !== "workflow-subagent") out.agentType = "general-purpose";',
    '  if ("model" in out) delete out.model;',
    "  out.input = role ? `${role}\\n\\n${input}` : input;",
    "  return out;",
    "};",
    "// wfport:end-helpers",
  ].join("\n");
}

// A single JS string literal: double, single, or template (with ${}
// interpolation but no nesting — enough for schema description values).
const JS_STRING_ATOM =
  "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|\\$\\{[^{}]*\\}|[^`\\\\])*`";

/**
 * When `source[slash]` is a `/` in code position, decide whether it opens
 * a regex literal and, when it does, return the index just past its flags.
 * The previous-significant-character heuristic separates `return /re/`
 * from `a / b`: only an operator, opener, comma, semicolon, keyword, or
 * start-of-input can precede a regex. Returns -1 when the slash is
 * division, a comment, or an unterminated pattern.
 * @param {string} source
 * @param {number} slash
 * @returns {number}
 */
export function regexLiteralEnd(source, slash) {
  const next = source[slash + 1] ?? "";
  if (next === "/" || next === "*" || next === "=") return -1;
  let j = slash - 1;
  while (j >= 0 && /\s/.test(source[j] ?? "")) j -= 1;
  const prev = j < 0 ? "" : (source[j] ?? "");
  const afterOpener = prev === "" || "([{,=:!&|?;".includes(prev);
  const afterOperator = "+-~^%*<>".includes(prev);
  let afterKeyword = false;
  if (!afterOpener && !afterOperator && /[$\w]/.test(prev)) {
    const m =
      /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield)\s*$/.exec(
        source.slice(Math.max(0, j - 12), j + 1),
      );
    afterKeyword = !!m;
  }
  if (!afterOpener && !afterOperator && !afterKeyword) return -1;
  let k = slash + 1;
  let inClass = false;
  while (k < source.length) {
    const d = source[k];
    if (d === "\\") {
      k += 2;
      continue;
    }
    if (d === "\n") return -1;
    if (d === "[") inClass = true;
    else if (d === "]") inClass = false;
    else if (d === "/" && !inClass) {
      k += 1;
      while (k < source.length && /[a-z]/.test(source[k] ?? "")) k += 1;
      return k;
    }
    k += 1;
  }
  return -1;
}

/**
 * Source with comments blanked and string/template raw text blanked
 * (delimiters, newlines, and ${...} interpolation contents kept), so
 * code scans skip comment-text and string-text mentions. Regex literals
 * are blanked as a unit so a quote inside `/…/` never opens a phantom
 * string downstream.
 * @param {string} source
 * @returns {string}
 */
export function codeOnly(source) {
  const out = source.split("");
  let state = "code"; // code | sq | dq | tmpl | line | block
  const tmplStack = [];
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        state = "code";
        i += 2;
      } else {
        if (c !== "\n") out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"';
      if (c === "\\") {
        if (source[i + 1] !== "\n") out[i + 1] = " ";
        out[i] = " ";
        i += 2;
        continue;
      }
      if (c === q) {
        state = "code";
        i += 1;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    if (state === "tmpl") {
      if (c === "\\") {
        if (source[i + 1] !== "\n") out[i + 1] = " ";
        out[i] = " ";
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
      if (c !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // code
    if (c === "/" && n === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      state = "block";
      i += 2;
      continue;
    }
    if (c === "/") {
      // A regex literal blanks as one unit; division falls through.
      const rend = regexLiteralEnd(source, i);
      if (rend > 0) {
        for (let k = i; k < rend; k += 1) {
          if (source[k] !== "\n") out[k] = " ";
        }
        i = rend;
        continue;
      }
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
    if (c === "{" || c === "[" || c === "(") depth += 1;
    if (c === "}" || c === "]" || c === ")") {
      if (c === "}" && tmplStack.length && depth === tmplStack[tmplStack.length - 1] + 1) {
        depth -= 1;
        tmplStack.pop();
        state = "tmpl";
        i += 1;
        continue;
      }
      depth -= 1;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Remove Muse-rejected keys from one schema-like object literal:
 * string-valued `description`/`title` keys and object-valued `notes` keys.
 * Property-name shapes (`title: { type: "string" }`) and runtime
 * `notes: <expr>` are kept.
 * @param {string} literal
 * @returns {{ text: string, removed: { description: number, title: number, notes: number } }}
 */
export function stripSchemaProps(literal) {
  /** @type {{ description: number, title: number, notes: number }} */
  const removed = { description: 0, title: 0, notes: 0 };
  let text = literal;
  const strVal = `(?:${JS_STRING_ATOM})(?:\\s*\\+\\s*(?:${JS_STRING_ATOM}))*`;
  const descRe = new RegExp(`([,{]\\s*)description\\s*:\\s*${strVal}\\s*,?`, "g");
  text = text.replace(descRe, (_m, prefix) => {
    removed.description += 1;
    return prefix;
  });
  const titleRe = new RegExp(`([,{]\\s*)title\\s*:\\s*(?:${JS_STRING_ATOM})\\s*,?`, "g");
  text = text.replace(titleRe, (_m, prefix) => {
    removed.title += 1;
    return prefix;
  });
  const notesRe = /([,{]\s*)notes\s*:\s*\{[^{}]*\}\s*,?/g;
  text = text.replace(notesRe, (_m, prefix) => {
    removed.notes += 1;
    return prefix;
  });
  return { text, removed };
}

/**
 * Find schema-like const object literals (contain a `type: "<string>"` key),
 * excluding `meta`. Covers *_SCHEMA consts and fragments like
 * INHERITED_PROPERTY that spread into schemas.
 * @param {string} code
 * @returns {{ name: string, openIdx: number, closeIdx: number }[]}
 */
export function collectSchemaConsts(code) {
  /** @type {{ name: string, openIdx: number, closeIdx: number }[]} */
  const out = [];
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[1] === "meta") continue;
    const openIdx = code.indexOf("{", m.index);
    const closeIdx = matchDelim(code, openIdx, "{", "}");
    if (closeIdx < 0) continue;
    const literal = code.slice(openIdx, closeIdx + 1);
    if (/(^|[^\w$])type\s*:\s*['"`]/.test(literal)) out.push({ name: m[1], openIdx, closeIdx });
  }
  return out;
}

/**
 * Collect custom (non-Muse) agentType string literals anywhere in code,
 * plus dynamic (non-string) agentType expressions. String/comment-text
 * mentions are excluded via codeOnly.
 * @param {string} source
 * @returns {{ literals: { value: string, line: number }[], dynamics: { expr: string, line: number }[] }}
 */
export function collectAgentTypes(source) {
  const masked = codeOnly(source);
  /** @type {{ value: string, line: number }[]} */
  const literals = [];
  /** @type {{ expr: string, line: number }[]} */
  const dynamics = [];
  const litRe = /agentType\s*:\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = litRe.exec(source)) !== null) {
    if (masked[m.index] === " ") continue;
    literals.push({ value: m[2], line: lineOf(source, m.index) });
  }
  const dynRe = /agentType\s*:\s*(?![`'"])([A-Za-z_$][\w$.]*)/g;
  while ((m = dynRe.exec(source)) !== null) {
    if (masked[m.index] === " ") continue;
    dynamics.push({ expr: m[1], line: lineOf(source, m.index) });
  }
  return { literals, dynamics };
}

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
    if (c === "/") {
      // Skip a regex literal as one unit so a quote inside `/…/` never
      // opens a phantom string; division falls through.
      const rend = regexLiteralEnd(source, i);
      if (rend > 0) {
        i = rend;
        continue;
      }
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
  let state = "code"; // code | sq | dq | tmpl | line | block
  const tmplStack = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
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
    if (c === "/") {
      // Skip a regex literal so a comma or quote inside `/…/` neither
      // splits nor opens a phantom string; division falls through.
      const rend = regexLiteralEnd(text, i);
      if (rend > 0) {
        i = rend - 1;
        continue;
      }
    }
    if (c === "/" && n === "/") {
      state = "line";
      continue;
    }
    if (c === "/" && n === "*") {
      state = "block";
      i += 1;
      continue;
    }
    if (c === "/") {
      // A regex literal cannot hold a top-level comma — skip one so a
      // `/,/` inside never splits the list.
      const rend = regexLiteralEnd(text, i);
      if (rend > 0) {
        i = rend - 1;
        continue;
      }
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

// Rewrite one agent(prompt[, opts]) call to the V1 body shape, routing the
// dispatch through the choke points: museDispatchArgs (agentType/model
// mapping) + museResult (envelope unwrap). The agentType is passed through
// untouched here: the injected choke point maps custom types to
// general-purpose at runtime (so dynamic flows like spec.agentType are
// covered too), and agentTypes are reported globally.
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
  if (!opts) return { code: `agent(museDispatchArgs(${prompt}, {})).then(museResult)` };
  if (!opts.startsWith("{")) {
    gaps.push({
      kind: "dynamic-options",
      line,
      detail: `options from ${opts.slice(0, 60)} — mapped via museDispatchArgs; verify agentType/schema by hand`,
    });
    return { code: `agent(museDispatchArgs(${prompt}, { ...${opts} })).then(museResult)` };
  }
  const closeIdx = matchDelim(opts, 0, "{", "}");
  const body = opts.slice(1, closeIdx).trim();
  return {
    code:
      `agent(museDispatchArgs(${prompt}${body ? `, { ${body} }` : `, {}`}))` + `.then(museResult)`,
  };
}

/**
 * Strip Muse-rejected keys from schema-like consts in place (right to
 * left so offsets stay valid). Lines reported are source-relative: later
 * splices never move an earlier const's start.
 * @param {string} code
 * @param {Gap[]} gaps
 * @returns {string}
 */
function stripSchemas(code, gaps) {
  const consts = collectSchemaConsts(code);
  for (let i = consts.length - 1; i >= 0; i -= 1) {
    const c = consts[i];
    const literal = code.slice(c.openIdx, c.closeIdx + 1);
    const { text, removed } = stripSchemaProps(literal);
    const total = removed.description + removed.title + removed.notes;
    if (total === 0) continue;
    code = code.slice(0, c.openIdx) + text + code.slice(c.closeIdx + 1);
    /** @type {string[]} */
    const parts = [];
    if (removed.description) parts.push(`${removed.description} description`);
    if (removed.title) parts.push(`${removed.title} title`);
    if (removed.notes) parts.push(`${removed.notes} notes`);
    gaps.push({
      kind: "schema",
      line: lineOf(code, c.openIdx),
      detail: `${c.name}: removed ${parts.join(", ")} (Muse inline schemas reject them)`,
    });
  }
  return code;
}

/**
 * Check *_SCHEMA consts against the Muse inline-schema subset. Names and
 * lines come from the original source; the checked literal is the
 * stripped converted code, so removed keys and post-strip size are what
 * the runner will see. `description`/`title` only count when
 * string-valued — `title: { type: "string" }` is a data field name.
 * @param {string} source
 * @param {string} strippedCode
 * @param {Gap[]} gaps
 * @returns {SchemaInfo[]}
 */
function analyzeSchemas(source, strippedCode, gaps) {
  /** @type {SchemaInfo[]} */
  const schemas = [];
  const re = /const\s+([A-Za-z_$][\w$]*(?:SCHEMA|Schema)[\w$]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const line = lineOf(source, m.index);
    const nameRe = new RegExp(`const\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*\\{`);
    const hit = nameRe.exec(strippedCode);
    let literal = "";
    if (hit) {
      const openIdx = strippedCode.indexOf("{", hit.index);
      const closeIdx = matchDelim(strippedCode, openIdx, "{", "}");
      if (closeIdx > 0) literal = strippedCode.slice(openIdx, closeIdx + 1);
    }
    if (!literal) {
      const openIdx = source.indexOf("{", m.index);
      const closeIdx = matchDelim(source, openIdx, "{", "}");
      if (closeIdx > 0) literal = source.slice(openIdx, closeIdx + 1);
    }
    const masked = codeOnly(literal);
    const issues = [];
    if (/(^|[^\w$])description\s*:\s*['"`]/.test(masked))
      issues.push('uses "description", not allowed in Muse inline schemas');
    if (/(^|[^\w$])title\s*:\s*['"`]/.test(masked))
      issues.push('uses "title", not allowed in Muse inline schemas');
    for (const kw of SCHEMA_KEYWORDS_BAD) {
      const hitKw = new RegExp(`(^|[^\\w$])${kw.replace("$", "\\$")}\\s*:`).test(masked);
      if (hitKw) issues.push(`uses "${kw}", not allowed in Muse inline schemas`);
    }
    if (Buffer.byteLength(literal, "utf8") > 4096) issues.push("exceeds 4 KiB inline limit");
    schemas.push({ name, line, issues });
    for (const issue of issues) gaps.push({ kind: "schema", line, detail: `${name}: ${issue}` });
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
  // workflow name/description at launch, not from an export). Matches in
  // comments or strings are not the meta export — codeOnly blanks those.
  const maskedForMeta = codeOnly(code);
  const metaMatch = /export\s+const\s+meta\s*=\s*\{/.exec(code);
  let metaName = null;
  if (metaMatch && maskedForMeta[metaMatch.index] !== " ") {
    const nameHit = code.slice(metaMatch.index).match(/name\s*:\s*(['"])([^'"]+)\1/);
    metaName = nameHit ? nameHit[2] : null;
    code =
      code.slice(0, metaMatch.index) +
      "const meta /* Muse: name/description move to the Workflow launch */" +
      code.slice(metaMatch.index + "export const meta".length);
  } else {
    gaps.push({ kind: "meta", line: 1, detail: "no export const meta found" });
  }

  // agent(...) calls, rewritten right-to-left so offsets stay valid.
  // Matches inside comments or string/template text are skipped: the old
  // regex rewrote `` `await agent()` `` inside doc comments into garbage.
  /** @type {AgentCallSite[]} */
  const calls = [];
  const maskedForAgents = codeOnly(code);
  const agentRe = /(?<![\w$.])agent\s*\(/g;
  let am;
  while ((am = agentRe.exec(code)) !== null) {
    if (maskedForAgents[am.index] === " ") continue;
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

  // Bare orchestration globals (phase, log, parallel, pipeline) are already
  // the V1 body shape — they pass through untouched. (An earlier release
  // renamed them to host.* methods, which the runner does not provide.)

  // Strip Muse-rejected keys from schema-like consts, including helper
  // fragments (INHERITED_PROPERTY) that spread into schemas.
  code = stripSchemas(code, gaps);

  // Custom agentTypes: every literal anywhere in code plus dynamic
  // expressions. The injected museDispatchArgs choke point maps them at
  // runtime, so per-literal static rewrites would lose the role prompt.
  const found = collectAgentTypes(code);
  const customTypes = [
    ...new Set(found.literals.filter((l) => !MUSE_AGENT_TYPES.has(l.value)).map((l) => l.value)),
  ].sort();
  for (const l of found.literals) {
    if (MUSE_AGENT_TYPES.has(l.value)) continue;
    gaps.push({
      kind: "agentType",
      line: l.line,
      detail: `${l.value} — mapped to general-purpose via museDispatchArgs; refine the role prompt by inlining .claude/agents/${l.value}.md`,
    });
  }
  for (const d of found.dynamics) {
    gaps.push({
      kind: "agentType",
      line: d.line,
      detail: `dynamic agentType ${d.expr} — mapped at runtime via museDispatchArgs; verify the role prompt covers its values`,
    });
  }
  const agentTypeReport = customTypes.map((value) => ({
    value,
    muse: "general-purpose",
    agentFile: agentsDir ? join(agentsDir, `${value}.md`) : null,
    agentFileExists: agentsDir ? existsSync(join(agentsDir, `${value}.md`)) : null,
    action:
      "mapped to general-purpose via museDispatchArgs with a short role prompt — refine by inlining the agent file's prompt",
  }));

  // Every dispatch already routes through the choke points (mapping +
  // unwrap) — convertAgentCall emits that form directly.

  // Claude-only model pins are dropped at runtime by museDispatchArgs.
  if (/(^|[^\w$])model\s*:/.test(codeOnly(source))) {
    gaps.push({
      kind: "model",
      line: 1,
      detail:
        "Claude-only model pin(s) dropped at runtime (the session route inherits) — remove CITATION_AUDIT_MODEL-style constants by hand if desired",
    });
  }

  // Codex-review degradation: the tl-runner MCP mention path has no Muse
  // equivalent — a documented skip, not a silent mapping.
  if (customTypes.includes("tl-runner") && /@codex|\bMCP\b/i.test(source)) {
    gaps.push({
      kind: "codex-mcp",
      line: 1,
      detail:
        "tl-runner posts the @codex mention via the GitHub MCP write path, which Muse children lack — document a skip or a Muse-side posting route (gh api writes as the wrong account)",
    });
  }

  const schemas = analyzeSchemas(source, code, gaps);

  // Banned APIs count only in code — comment-text mentions are not uses.
  const banned = [];
  const masked = codeOnly(source);
  for (const pat of ["Date.now", "Math.random", "new Date("]) {
    let from = 0;
    let seen = false;
    while (true) {
      const idx = masked.indexOf(pat, from);
      if (idx < 0) break;
      const before = idx > 0 ? masked[idx - 1] : "";
      if (/[\w$]/.test(before)) {
        from = idx + 1;
        continue;
      }
      if (!seen) {
        banned.push(pat);
        seen = true;
      }
      gaps.push({
        kind: "banned-api",
        line: lineOf(masked, idx),
        detail: `${pat} throws under deterministic replay in both dialects`,
      });
      from = idx + 1;
    }
  }
  if (/^\s*import\s|require\s*\(/m.test(source))
    gaps.push({
      kind: "import",
      line: 1,
      detail: "imports/requires are not allowed in Workflow scripts",
    });

  // parallel() sites count in code only — comment text like
  // "rebuild as parallel([...])" is not a call site.
  const maskedSource = codeOnly(source);
  const parallelSites = [...source.matchAll(/(?<![\w$.])parallel\s*\(/g)].filter(
    (m) => maskedSource[/** @type {number} */ (m.index)] !== " ",
  ).length;
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

  // V1 body shape: header comments + injected shims, then the script
  // itself with top-level await/return. No wrapper function, no export,
  // no host object — the runner wraps this text as a function body.
  const header = [
    `// Converted from Claude Workflow${metaName ? ` "${metaName}"` : ""} by workflow-port.`,
    "// Review every TODO/gap in the conversion report before running.",
    "",
  ].join("\n");
  const helpers = museHelpers(customTypes);
  const wrapped = `${header}${helpers}\n${code.trimEnd()}\n`;

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
