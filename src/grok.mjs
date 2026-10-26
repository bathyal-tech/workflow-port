// Grok Build (Rhai) emitter — derives from the same canonical call-site
// facts as the Muse emitter, per the hub-and-spoke design: Muse's
// agent request-object shape is canonical; Claude and Grok are derived.
//
// Grok dialect (xai-workflow, .grok/workflows/*.rhai):
//   let meta = #{ name, description, when_to_use, phases: [#{ title, detail }] };
//   agent(prompt, #{ label, agent_type, capability_mode, output_schema, phase, model })
//   parallel([#{ prompt, label, ... }])  // barrier; jobs built as a list
//   phase(title), log(msg), complete(value), budget()
// JS helpers, loops, and args reads are carried structurally: each real
// agent() becomes an agent() with a translated prompt, each real
// parallel() becomes a prebuilt job list, schemas are defined as Rhai maps,
// and anything without a Rhai equivalent is flagged in the gap report while
// the prompt text itself is still emitted.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  matchDelim,
  splitTopLevel,
  lineOf,
  codeOnly,
  collectSchemaConsts,
  regexLiteralEnd,
  MUSE_AGENT_TYPES,
} from "./convert.mjs";

/**
 * @typedef {import("./convert.mjs").Gap} Gap
 *
 * @typedef {object} GrokPhase
 * @property {string} title
 * @property {string | null} detail
 *
 * @typedef {object} GrokMeta
 * @property {string | null} name
 * @property {string | null} description
 * @property {string | null} whenToUse
 * @property {string[]} phases
 * @property {GrokPhase[]} [phaseDetails]
 *
 * @typedef {object} AgentCallFact
 * @property {number} line
 * @property {number} [start]
 * @property {number} [openIdx]
 * @property {number} [closeIdx]
 * @property {string} promptSrc
 * @property {string | null} agentType
 * @property {string | null} [agentTypeExpr]
 * @property {string | null} label
 * @property {string | null} [labelSrc]
 * @property {string | null} phase
 * @property {string | null} [phaseSrc]
 * @property {string | null} model
 * @property {string | null} schema
 * @property {string} [schemaKind]
 * @property {string | null} [schemaExpr]
 * @property {boolean} [schemaInline]
 * @property {string | null} [capability]
 * @property {boolean} [dynamicOpts]
 * @property {boolean} [spreadOpts]
 * @property {boolean | undefined} inParallel
 *
 * @typedef {object} SchemaDef
 * @property {string} name
 * @property {string} literal
 * @property {number} line
 *
 * @typedef {object} HelperFact
 * @property {string} name
 * @property {string} params
 * @property {number} line
 * @property {number} start
 * @property {number} end
 * @property {string} [body]
 *
 * @typedef {object} ConstFact
 * @property {string} name
 * @property {string} expr
 * @property {number} line
 * @property {number} start
 * @property {number} end
 *
 * @typedef {object} LoopFact
 * @property {string} kind
 * @property {string} header
 * @property {string} body
 * @property {number} line
 * @property {number} start
 * @property {number} end
 *
 * @typedef {object} PhaseCallFact
 * @property {string} expr
 * @property {number} line
 * @property {number} start
 *
 * @typedef {object} ArgsReadFact
 * @property {string} name
 * @property {string | null} defaultSrc
 * @property {number} line
 *
 * @typedef {object} ParallelFact
 * @property {number} line
 * @property {number} start
 * @property {number} openIdx
 * @property {number} closeIdx
 * @property {string} inner
 *
 * @typedef {object} WorkflowFacts
 * @property {GrokMeta | null} meta
 * @property {AgentCallFact[]} calls
 * @property {number} parallelSites
 * @property {boolean} hasReturn
 * @property {SchemaDef[]} [schemas]
 * @property {HelperFact[]} [helpers]
 * @property {PhaseCallFact[]} [phaseCalls]
 * @property {PhaseCallFact[]} [logCalls]
 * @property {ArgsReadFact[]} [argsReads]
 * @property {ParallelFact[]} [parallels]
 * @property {ConstFact[]} [consts]
 * @property {LoopFact[]} [loops]
 * @property {string | null} [returnSrc]
 * @property {string | null} [agentsDir]
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
export function field(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*(['"\`])([^'"\`]*)\\1`));
  return m ? m[2] : null;
}
/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
export function fieldIdent(body, name) {
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

// Split a backtick template body (without the backticks) into literal and
// expression parts. Expressions are the raw text inside ${...} (nesting via
// matchDelim-aware scan).
/**
 * @param {string} body
 * @returns {{ kind: string, text: string }[]}
 */
function splitTemplateBody(body) {
  /** @type {{ kind: string, text: string }[]} */
  const parts = [];
  let lit = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    const n = body[i + 1] ?? "";
    if (c === "\\") {
      lit += c + n;
      i += 2;
      continue;
    }
    if (c === "$" && n === "{") {
      let depth = 1;
      let j = i + 2;
      let expr = "";
      let state = "code";
      while (j < body.length && depth > 0) {
        const d = body[j];
        const e = body[j + 1] ?? "";
        if (state === "code" && d === "'") {
          state = "sq";
          expr += d;
          j += 1;
          continue;
        }
        if (state === "code" && d === '"') {
          state = "dq";
          expr += d;
          j += 1;
          continue;
        }
        if (state === "code" && d === "`") {
          state = "tm";
          expr += d;
          j += 1;
          continue;
        }
        if (state === "sq" || state === "dq" || state === "tm") {
          const q = state === "sq" ? "'" : state === "dq" ? '"' : "`";
          if (d === "\\") {
            expr += d + e;
            j += 2;
            continue;
          }
          if (d === q) state = "code";
          expr += d;
          j += 1;
          continue;
        }
        if (d === "{") depth += 1;
        if (d === "}") depth -= 1;
        if (depth > 0) expr += d;
        j += 1;
      }
      if (lit) {
        parts.push({ kind: "lit", text: lit });
        lit = "";
      }
      parts.push({ kind: "expr", text: expr });
      i = j;
      continue;
    }
    lit += c;
    i += 1;
  }
  if (lit) parts.push({ kind: "lit", text: lit });
  return parts;
}

// Minimal JS expression -> Rhai expression for interpolated values:
// .toString() becomes .to_string(), strict equality becomes Rhai equality.
// Anything else passes through; callers flag a gap when it looks JS-only.
/**
 * @param {string} expr
 * @returns {string}
 */
function rhaiValueExpr(expr) {
  let out = expr.trim();
  out = out.replace(/\.toString\s*\(\s*\)/g, ".to_string()");
  out = out.replace(/ strictEqual /g, " ");
  out = out.replace(/===/g, "==").replace(/!==/g, "!=");
  return out;
}

// Translate any JS prompt/label/phase expression to a Rhai expression.
// Plain strings become quoted literals; template literals become "a" +
// x + "b" chains. Prompts fence interpolations with json_encode (untrusted
// data); labels and phases carry them plain (pass fence=false — a label
// must stay a bare string, never a JSON-quoted one). Bare identifiers,
// member access, and calls pass through with a gap when they use JS-only
// syntax. Never returns null for non-empty input: the source text is always
// carried so a live run dispatches the real prompt.
/**
 * @param {string} src
 * @param {Gap[]} gaps
 * @param {number} line
 * @param {boolean} [fence]
 * @returns {string}
 */
export function jsExprToRhai(src, gaps, line, fence = true) {
  const t = (src ?? "").trim();
  if (!t) {
    gaps.push({ kind: "prompt", line, detail: "empty prompt expression — fill it in by hand" });
    return rhaiString("");
  }
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    try {
      const parsed = JSON.parse(
        t.startsWith("'") ? `"${t.slice(1, -1).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : t,
      );
      return rhaiString(parsed);
    } catch {
      gaps.push({
        kind: "prompt",
        line,
        detail: `string literal could not be carried (${t.slice(0, 60)}) — re-express by hand`,
      });
      return rhaiString(t);
    }
  }
  if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) {
    const parts = splitTemplateBody(t.slice(1, -1));
    if (!parts.some((p) => p.kind === "expr")) {
      return rhaiString(t.slice(1, -1).replace(/\\`/g, "`").replace(/\\\$/g, "$"));
    }
    const chunks = [];
    for (const p of parts) {
      if (p.kind === "lit") {
        if (p.text) chunks.push(rhaiString(p.text.replace(/\\`/g, "`")));
      } else {
        const raw = rhaiValueExpr(p.text);
        if (/=>|\.\.\.|\?\?|\?\./.test(raw)) {
          gaps.push({
            kind: "prompt",
            line,
            detail: `interpolation \`${raw.slice(0, 60)}\` has no direct Rhai form — carried ${fence ? "with json_encode" : "plain"}, verify by hand`,
          });
        }
        const expr = normalizeExprSyntax(raw, gaps, line);
        chunks.push(fence ? `json_encode(${expr})` : expr);
      }
    }
    if (chunks.length > 8) {
      gaps.push({
        kind: "prompt",
        line,
        detail:
          "long prompt concatenation — split into += statements if Rhai reports max complexity",
      });
    }
    return chunks.filter(Boolean).join(" + ") || rhaiString("");
  }
  if (/=>/.test(t)) {
    gaps.push({
      kind: "prompt",
      line,
      detail: `arrow function in prompt (${t.slice(0, 60)}) — carried as a Rhai closure, verify by hand`,
    });
    return normalizeExprSyntax(rhaiValueExpr(t), gaps, line);
  }
  if (/\?\?|\?\./.test(t)) {
    gaps.push({
      kind: "prompt",
      line,
      detail: `JS-only operator in prompt (${t.slice(0, 60)}) — carried with explicit != () checks, verify by hand`,
    });
  }
  return normalizeExprSyntax(rhaiValueExpr(t), gaps, line);
}

// Extract the raw JS expression for `name:` from an option-object body,
// respecting nesting, strings, and templates. Returns null when absent.
/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
export function extractFieldExpr(body, name) {
  if (!body) return null;
  const parts = splitTopLevel(body);
  for (const p of parts) {
    const m = new RegExp(`^${name}\\s*:`).exec(p.trim());
    if (m) return p.slice(p.indexOf(":") + 1).trim() || null;
  }
  return null;
}

// Classify a `schema:` option value: a bare identifier that names a schema
// const, an inline object, or a dynamic expression (member access like
// options.schema, a call, ...). Only the named-const form becomes
// output_schema directly; dynamic forms must be mapped by hand and must
// never be emitted as `output_schema: options`.
/**
 * @param {string | null} expr
 * @returns {{ kind: string, name?: string, expr?: string }}
 */
export function classifySchemaExpr(expr) {
  const t = (expr ?? "").trim();
  if (!t) return { kind: "none" };
  if (t.startsWith("{")) return { kind: "inline", expr: t };
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return { kind: "named", name: t };
  return { kind: "dynamic", expr: t };
}

// Convert a JS schema object literal to a Rhai map literal: `{` becomes
// `#{`, unquoted keys are re-quoted, single-quoted strings become
// double-quoted. Identifier values (fragment consts) pass through so the
// emitter can define them too.
/**
 * @param {string} literal
 * @returns {string}
 */
export function jsSchemaToRhai(literal) {
  const src = literal;
  let out = "";
  let i = 0;
  let state = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && n === "/") {
        out += c + n;
        i += 2;
        state = "line";
        continue;
      }
      if (c === "/" && n === "*") {
        out += c + n;
        i += 2;
        state = "block";
        continue;
      }
      if (c === "'") {
        state = "sq";
        out += '"';
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "tm";
        out += '"';
        i += 1;
        continue;
      }
      if (c === "{") {
        // A `{` opening a closure body (`|x| { ... }`) is a statement
        // block, not a map — copy it through untouched.
        if (/(?:^|[;{}()\n])\s*\|[^|{}\n]*\|\s*$/.test(out)) {
          const close = matchDelim(src, i, "{", "}");
          if (close > 0) {
            out += src.slice(i, close + 1);
            i = close + 1;
            continue;
          }
        }
        out += "#{";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      out += c;
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      out += c;
      if (c === "*" && n === "/") {
        out += n;
        i += 2;
        state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "sq") {
      if (c === "\\") {
        out += c + n;
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "code";
        out += '"';
        i += 1;
        continue;
      }
      if (c === '"') {
        out += '\\"';
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "dq") {
      if (c === "\\") {
        out += c + n;
        i += 2;
        continue;
      }
      if (c === '"') state = "code";
      out += c;
      i += 1;
      continue;
    }
    // tmpl -> flattened to a double-quoted string
    if (state === "tm") {
      if (c === "\\") {
        if (n === "`" || n === "$") {
          out += n;
          i += 2;
          continue;
        }
        out += c + n;
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        out += '"';
        i += 1;
        continue;
      }
      if (c === '"') {
        out += '\\"';
        i += 1;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
  }
  // Re-quote bare identifiers used as map keys (code positions only),
  // expanding JS shorthand ({ label, }) to explicit pairs. afterColon tracks
  // key vs value position so values are never re-quoted as keys.
  let quoted = "";
  let j = 0;
  let st = "code";
  let afterColon = false;
  while (j < out.length) {
    const c = out[j];
    if (st === "code" && c === '"') {
      st = "str";
      quoted += c;
      j += 1;
      continue;
    }
    if (st === "str") {
      quoted += c;
      if (c === "\\") {
        quoted += out[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (c === '"') st = "code";
      j += 1;
      continue;
    }
    if (st === "code" && (c === "{" || c === ",")) afterColon = false;
    if (st === "code" && c === ":") afterColon = true;
    const keyMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(out.slice(j));
    if (st === "code" && !afterColon && keyMatch && /[{,#\s,]$/.test(quoted.slice(-1) || "{")) {
      quoted += `"${keyMatch[1]}":`;
      j += keyMatch[0].length;
      afterColon = true;
      continue;
    }
    const shortMatch = /^([A-Za-z_$][\w$]*)\s*(?=[,}])/.exec(out.slice(j));
    if (st === "code" && !afterColon && shortMatch && /[{,\s]$/.test(quoted.slice(-1) || "{")) {
      quoted += `"${shortMatch[1]}": ${shortMatch[1]}`;
      j += shortMatch[0].length;
      continue;
    }
    quoted += c;
    j += 1;
  }
  return quoted;
}

// JS -> Rhai syntax engine: scanner-based passes that rewrite carried code
// (helper bodies, loop bodies, const values, prompts) into Rhai-valid form.
// Every pass works on code positions only (strings/comments untouched) and
// leaves a gap when the rewrite changes semantics or needs verification.
//
// Pass order in normalizeExprSyntax: backticks, optional chains, nullish
// coalescing, arrows, typeof-family, method rewrites, new/delete/spread,
// ternary. Statement structure (braces, loop headers, try/catch) is handled
// separately by normalizeStatements after agent/parallel splicing.

/** @type {Set<string>} */
const RHAI_RESERVED = new Set([
  "shared",
  "sync",
  "async",
  "await",
  "spawn",
  "go",
  "thread",
  "new",
  "match",
  "case",
  "default",
  "void",
  "null",
  "nil",
  "exit",
  "static",
  "var",
]);

// Mask for code positions: mask[i] !== " " means text[i] is real code.
/**
 * @param {string} text
 * @returns {string}
 */
function codeMask(text) {
  return codeOnly(text);
}

// Apply a global regex replacement only at code positions.
/**
 * @param {string} text
 * @param {RegExp} re
 * @param {(m: RegExpExecArray) => string} repl
 * @returns {string}
 */
function replaceInCode(text, re, repl) {
  const mask = codeMask(text);
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (mask[m.index] === " ") continue;
    out += text.slice(last, m.index) + repl(m);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out + text.slice(last);
}

// Scan left from idx (exclusive) over a balanced operand, stopping at a
// top-level boundary. Returns the operand start, or -1 when none. With
// stopSpread, a `...` at depth 0 ends the operand (a method receiver never
// includes a leading spread: `[...xs.map(f)]` receives `xs`, and the
// spread stays outside for the later spread pass).
/**
 * @param {string} text
 * @param {string} mask
 * @param {number} idx
 * @param {boolean} [stopSpread]
 * @param {boolean} [throughLogical]
 * @returns {number}
 */
function scanOperandStart(text, mask, idx, stopSpread = false, throughLogical = false) {
  let i = idx - 1;
  while (i >= 0 && (mask[i] === " " || /\s/.test(text[i]))) i -= 1;
  let depth = 0;
  while (i >= 0) {
    if (mask[i] === " ") {
      i -= 1;
      continue;
    }
    const c = text[i];
    if (stopSpread && depth === 0 && c === "." && text[i - 1] === "." && text[i - 2] === ".") {
      return i + 1;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth += 1;
      i -= 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return i + 1;
      depth -= 1;
      i -= 1;
      continue;
    }
    if (depth === 0) {
      if (c === "," || c === ";" || c === ":" || c === "?" || c === "\n") return i + 1;
      if (c === "=") {
        const prev = text[i - 1] ?? "";
        const next = text[i + 1] ?? "";
        if (next === ">") return i + 1; // arrow =>
        if (next === "=") {
          i -= 1;
          continue; // == : both halves belong to the operand
        }
        if (prev === "=" || prev === "!" || prev === "<" || prev === ">") {
          i -= 1;
          continue;
        }
        return i + 1;
      }
      if (c === ">" || c === "<" || c === "!") {
        // Comparison tails (`!=`, `<=`, `>=`) belong to the operand:
        // stopping after `!` would split `a != b` into `a !`. A bare
        // unary `!` is outside the operand (`!xs.map(f)` negates the call,
        // it is not part of the receiver).
        if (c === "!" && text[i + 1] !== "=") return i + 1;
        i -= 1;
        continue;
      }
      if (
        c === "&" ||
        c === "|" ||
        c === "+" ||
        c === "-" ||
        c === "*" ||
        c === "/" ||
        c === "%" ||
        c === "^" ||
        c === "~"
      ) {
        const prev = text[i - 1] ?? "";
        const next = text[i + 1] ?? "";
        if (throughLogical && (c === "&" || c === "|") && prev === c) {
          i -= 2;
          continue; // && / || inside a ternary condition bind the whole test
        }
        if (
          (c === "&" && (prev === "&" || next === "&")) ||
          (c === "|" && (prev === "|" || next === "|"))
        )
          return i + 1;
        if (c === "+" || c === "-") {
          if (prev === "" || /[\s,;([{=+\-*/%<>!&|?:~^]/.test(prev)) {
            i -= 1;
            continue; // unary sign
          }
        }
        if (next === "=") {
          i -= 1;
          continue; // compound assignment/comparison, keep together
        }
        return i + 1;
      }
    }
    i -= 1;
  }
  return 0;
}

// Scan right from idx over one value unit (balanced groups count as one).
// Stops before a top-level boundary; a leading `{` is only consumed as an
// object literal when allowBrace is set (otherwise it may open a block).
/**
 * @param {string} text
 * @param {string} mask
 * @param {number} idx
 * @param {boolean} allowBrace
 * @returns {number}
 */
function scanValueEnd(text, mask, idx, allowBrace) {
  const n = text.length;
  let i = idx;
  while (i < n && (mask[i] === " " || /\s/.test(text[i]))) i += 1;
  let consumed = false;
  while (i < n) {
    if (mask[i] === " ") {
      i += 1;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[") {
      const close = matchDelim(text, i, c, c === "(" ? ")" : "]");
      if (close < 0) return i;
      i = close + 1;
      consumed = true;
      continue;
    }
    if (c === "{") {
      if (!allowBrace && consumed) return i;
      const close = matchDelim(text, i, "{", "}");
      if (close < 0) return i;
      i = close + 1;
      consumed = true;
      continue;
    }
    if (c === ")" || c === "]" || c === "}" || c === "," || c === ";" || c === ":") return i;
    if (c === "\n" && consumed) return i;
    if (/[=!<>+\-*/%&|^~?]/.test(c)) {
      if (!consumed) {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
    consumed = true;
  }
  return i;
}

// Convert backtick templates in code positions to Rhai concatenations.
// Runs before the other passes (templates may nest the rest inside ${}).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertBackticks(text, gaps) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const mask = codeMask(text);
    if (mask[i] === " " || text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }
    // Find the closing backtick, respecting escapes and ${} nesting.
    let j = i + 1;
    let depth = 0;
    let closed = -1;
    while (j < n) {
      const d = text[j];
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (d === "$" && text[j + 1] === "{" && codeMask(text)[j] !== " ") {
        depth += 1;
        j += 2;
        continue;
      }
      if (d === "{" && depth > 0) {
        depth += 1;
        j += 1;
        continue;
      }
      if (d === "}" && depth > 0) {
        depth -= 1;
        j += 1;
        continue;
      }
      if (d === "`" && depth === 0) {
        closed = j;
        break;
      }
      j += 1;
    }
    if (closed < 0) {
      out += text[i];
      i += 1;
      continue;
    }
    const body = text.slice(i + 1, closed);
    const parts = splitTemplateBody(body);
    const chunks = parts.map((p) => {
      if (p.kind === "lit") {
        const lit = p.text.replace(/\\`/g, "`").replace(/\\\$/g, "$");
        return lit ? rhaiString(lit) : "";
      }
      const expr = normalizeExprSyntax(rhaiValueExpr(p.text), gaps, 0);
      return `json_encode(${expr})`;
    });
    const line = lineOf(text, i);
    if (parts.some((p) => p.kind === "expr" && /=>|\?\?|\?\./.test(p.text))) {
      gaps.push({
        kind: "prompt",
        line,
        detail:
          "template interpolation uses JS-only syntax — carried with json_encode, verify by hand",
      });
    }
    out += `(${chunks.filter(Boolean).join(" + ") || rhaiString("")})`;
    i = closed + 1;
  }
  return out;
}

// Convert `?.` chains: OBJ?.rest becomes (OBJ != () ? OBJ.rest : ()).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertOptionalChains(text, gaps) {
  let guard = 0;
  while (guard++ < 5000) {
    const mask = codeMask(text);
    const re = /\?(\.|\[)/g;
    let m = null;
    let hit = null;
    while ((m = re.exec(text)) !== null) {
      if (mask[m.index] === " ") continue;
      hit = m;
    }
    if (!hit) return text;
    // Rightmost `?.`/`?[` so nested chains resolve inside-out.
    const q = hit.index;
    const isBracket = hit[1] === "[";
    const start = scanOperandStart(text, mask, q);
    const operand = text.slice(start, q).trim();
    let rest = "";
    let end = q + 2;
    if (isBracket) {
      const close = matchDelim(text, q + 1, "[", "]");
      if (close < 0) return text;
      rest = text.slice(q + 1, close + 1).replace(/^\[/, "[");
      rest = `[${text.slice(q + 2, close)}]`;
      end = close + 1;
    } else {
      const nm = /^[A-Za-z_$][\w$]*/.exec(text.slice(q + 2));
      if (!nm) return text;
      rest = `.${nm[0]}`;
      end = q + 2 + nm[0].length;
    }
    if (!operand) return text;
    gaps.push({
      kind: "control-flow",
      line: lineOf(text, q),
      detail: `?. chain (${operand.slice(-40)}...) — carried as an explicit != () check; verify by hand`,
    });
    text = `${text.slice(0, start)}(if ${operand} != () { ${operand}${rest} } else { () })${text.slice(end)}`;
  }
  return text;
}

// Convert `A ?? B` to Rhai if/else over (). Runs after optional chains.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertNullish(text, gaps) {
  let guard = 0;
  while (guard++ < 5000) {
    const mask = codeMask(text);
    let real = -1;
    let from = 0;
    while (true) {
      const at = text.indexOf("??", from);
      if (at < 0) break;
      if (mask[at] !== " " && text[at + 2] !== "=") {
        real = at;
        break;
      }
      from = at + 2;
    }
    if (real < 0) return text;
    const start = scanOperandStart(text, mask, real);
    const left = text.slice(start, real).trim();
    const rightEnd = scanValueEnd(text, mask, real + 2, true);
    const right = text.slice(real + 2, rightEnd).trim();
    if (!left || !right) return text;
    gaps.push({
      kind: "control-flow",
      line: lineOf(text, real),
      detail: `?? fallback (${left.slice(-40)}...) — carried as an explicit != () check; verify by hand`,
    });
    const rightFixed = right === "null" || right === "undefined" ? "()" : right;
    text = `${text.slice(0, start)}(if ${left} != () { ${left} } else { ${rightFixed} })${text.slice(rightEnd)}`;
  }
  return text;
}

// Convert arrow functions to Rhai closures: (a, b) => body becomes
// |a, b| body. Block bodies go through statement normalization so nested
// loops, spreads, and JS-only operators inside closures are converted too.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @param {{ n: number }} [ctr]
 * @returns {string}
 */
function convertArrows(text, gaps, ctr) {
  let guard = 0;
  while (guard++ < 5000) {
    const mask = codeMask(text);
    let at = -1;
    for (let k = text.indexOf("=>"); k >= 0; k = text.indexOf("=>", k + 2)) {
      if (mask[k] !== " ") {
        at = k;
        break;
      }
    }
    if (at < 0) return text;
    // Left: (params) or a single identifier (rightmost arrow wins).
    let pstart = at;
    let params = "";
    {
      let i = at - 1;
      while (i >= 0 && (mask[i] === " " || /\s/.test(text[i]))) i -= 1;
      if (text[i] === ")") {
        const open = (() => {
          let depth = 0;
          for (let j = i; j >= 0; j -= 1) {
            if (mask[j] === " ") continue;
            if (text[j] === ")") depth += 1;
            if (text[j] === "(") {
              depth -= 1;
              if (depth === 0) return j;
            }
          }
          return -1;
        })();
        if (open < 0) return text;
        params = text.slice(open + 1, i).trim();
        pstart = open;
        // Skip a leading `async`.
        const before = text.slice(0, pstart).replace(/\s+$/, "");
        if (/async$/.test(before) && codeMask(text)[before.length - 1] !== " ") {
          pstart = before.length - "async".length;
        }
      } else {
        const m = /[A-Za-z_$][\w$]*$/.exec(text.slice(0, i + 1));
        if (!m) return text;
        params = m[0];
        pstart = i + 1 - params.length;
      }
    }
    // Right: a {block} or a single expression.
    let j = at + 2;
    while (j < text.length && (codeMask(text)[j] === " " || /\s/.test(text[j]))) j += 1;
    let body = "";
    let bend = -1;
    if (text[j] === "{") {
      const close = matchDelim(text, j, "{", "}");
      if (close < 0) return text;
      const inner = text.slice(j + 1, close);
      const ret = /^\s*return\b/.exec(inner);
      if (ret && inner.indexOf("return", ret.index + 6) < 0) {
        const tail = inner.slice(ret.index + 6).trimStart();
        const semi = tail.search(/[;\n]/);
        body = (semi < 0 ? tail : tail.slice(0, semi)).trim();
        if (!body) body = "()";
      } else {
        body = `{\n${normalizeStatements(inner, gaps, ctr ?? { n: 0 })}\n}`;
      }
      bend = close + 1;
    } else {
      bend = scanValueEnd(text, codeMask(text), j, true);
      body = text.slice(j, bend).trim();
      if (!body) return text;
    }
    if (/[{}\[\]]/.test(params) || /\.\.\./.test(params) || /=/.test(params)) {
      gaps.push({
        kind: "control-flow",
        line: lineOf(text, at),
        detail: `destructuring/default arrow params (${params || "no params"}) have no Rhai form — expand to explicit field reads by hand`,
      });
    }
    gaps.push({
      kind: "control-flow",
      line: lineOf(text, at),
      detail: `arrow function (${params || "no params"}) — carried as a Rhai closure; verify by hand`,
    });
    const normParams = params
      .split(",")
      .map((p) =>
        p
          .trim()
          .replace(/^\.\.\./, "")
          .replace(/\s*=.*$/, "")
          .trim(),
      )
      .filter(Boolean)
      .join(", ");
    const normBody = normalizeExprSyntax(body, gaps, 0);
    text = `${text.slice(0, pstart)}|${normParams}| ${normBody}${text.slice(bend)}`;
  }
  return text;
}

// Convert typeof/Array.isArray/Number.isInteger/String()/JSON.* and the
// .length/.includes/.has/.add/.toUpperCase spellings to Rhai forms.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertTypeFamily(text, gaps) {
  // typeof EXPR -> type_of(EXPR)
  text = replaceInCode(text, /\btypeof\s+(?=[A-Za-z_$('"`])/g, () => "type_of ");
  // Array.isArray(E) -> (type_of(E) == "array")
  text = replaceInCode(text, /\bArray\s*\.\s*isArray\s*\(/g, () => "WF_ISARRAY(");
  {
    let guard = 0;
    while (guard++ < 1000) {
      const mask = codeMask(text);
      const at = (() => {
        const k = text.indexOf("WF_ISARRAY(");
        if (k < 0) return -1;
        return mask[k] === " " ? -2 : k;
      })();
      if (at === -1) break;
      if (at === -2) {
        text = text.replace("WF_ISARRAY(", "Array.isArray(");
        continue;
      }
      const open = text.indexOf("(", at);
      const close = matchDelim(text, open, "(", ")");
      if (close < 0) break;
      const arg = text.slice(open + 1, close).trim() || "()";
      text = `${text.slice(0, at)}(type_of(${arg}) == "array")${text.slice(close + 1)}`;
    }
    text = text.split("WF_ISARRAY(").join("Array.isArray(");
  }
  // Number.isInteger(E) -> (E is int)
  text = replaceInCode(text, /!\s*Number\s*\.\s*isInteger\s*\(/g, () => "WF_NOTINT(");
  text = replaceInCode(text, /\bNumber\s*\.\s*isInteger\s*\(/g, () => "WF_ISINT(");
  /** @type {[string, (a: string) => string][]} */
  const intDefs = [
    ["WF_NOTINT(", (/** @type {string} */ a) => `!(${a} is int)`],
    ["WF_ISINT(", (/** @type {string} */ a) => `(${a} is int)`],
  ];
  for (const [tok, body] of intDefs) {
    let guard = 0;
    while (guard++ < 1000) {
      const idx = text.indexOf(tok);
      if (idx < 0) break;
      if (codeMask(text)[idx] === " ") {
        text = text.slice(0, idx) + " " + text.slice(idx + 1);
        continue;
      }
      const open = text.indexOf("(", idx);
      const close = matchDelim(text, open, "(", ")");
      if (close < 0) break;
      text = `${text.slice(0, idx)}${body(text.slice(open + 1, close).trim() || "()")}${text.slice(close + 1)}`;
    }
  }
  // String(E) -> (E.to_string()); Number(E) -> wf_number(E)
  text = replaceInCode(text, /\bString\s*\(/g, () => "WF_STRING(");
  text = replaceInCode(text, /\bNumber\s*\(/g, () => "wf_number(");
  text = foldCallArg(text, "WF_STRING(", (a) => `(${a || '""'}.to_string())`, gaps);
  // JSON.parse(E) -> parse_json(E); JSON.stringify(E, ..) -> json_encode(E)
  const beforeJson = text;
  text = replaceInCode(text, /\bJSON\s*\.\s*parse\s*\(/g, () => "parse_json(");
  text = replaceInCode(text, /\bJSON\s*\.\s*stringify\s*\(/g, () => "WF_JSONSTR(");
  text = foldCallArg(text, "WF_JSONSTR(", (a) => `json_encode(${a})`, gaps, true);
  if (text !== beforeJson) {
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail:
        "JSON.parse/stringify carried as parse_json/json_encode — confirm the engine provides them",
    });
  }
  // Member spellings.
  text = replaceInCode(text, /\.length\b/g, () => ".len()");
  text = replaceInCode(text, /\.includes\s*\(/g, () => ".contains(");
  text = replaceInCode(text, /\.has\s*\(/g, () => ".contains(");
  text = replaceInCode(text, /\.add\s*\(/g, () => ".push(");
  text = replaceInCode(text, /\.toUpperCase\s*\(/g, () => ".to_upper(");
  text = replaceInCode(text, /\.toLowerCase\s*\(/g, () => ".to_lower(");
  return text;
}

// Fold a marker call TOKEN(arg) by replacing it with wrap(firstArg...).
// When firstOnly is set, only the first top-level argument is kept.
/**
 * @param {string} text
 * @param {string} token
 * @param {(args: string) => string} wrap
 * @param {Gap[]} gaps
 * @param {boolean} [firstOnly]
 * @returns {string}
 */
function foldCallArg(text, token, wrap, gaps, firstOnly = false) {
  void gaps;
  let guard = 0;
  while (guard++ < 1000) {
    const idx = text.indexOf(token);
    if (idx < 0) break;
    if (codeMask(text)[idx] === " ") {
      text = text.slice(0, idx) + " " + text.slice(idx + 1);
      continue;
    }
    const open = text.indexOf("(", idx);
    const close = matchDelim(text, open, "(", ")");
    if (close < 0) break;
    let args = text.slice(open + 1, close);
    // First-only uses the top-level split: a naive comma split would cut
    // inside nested calls and object literals (e.g. the replacer object in
    // JSON.stringify(value, null, 2)), unbalancing the output.
    if (firstOnly) args = splitTopLevel(args)[0] ?? "";
    text = `${text.slice(0, idx)}${wrap(args.trim())}${text.slice(close + 1)}`;
  }
  return text;
}

// Rewrite higher-order methods to injected wf_* helpers taking closures:
// .map/.filter/.find/.some/.flatMap/.reduce/.join.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertHigherOrder(text, gaps) {
  const defs = [
    { name: "flatMap", fn: "wf_flatmap", arity: 1 },
    { name: "reduce", fn: "wf_reduce", arity: 2 },
    { name: "filter", fn: "wf_filter", arity: 1 },
    { name: "find", fn: "wf_find", arity: 1 },
    { name: "some", fn: "wf_some", arity: 1 },
    { name: "join", fn: "wf_join", arity: 1 },
    { name: "map", fn: "wf_map", arity: 1 },
  ];
  for (const { name, fn, arity } of defs) {
    let guard = 0;
    while (guard++ < 2000) {
      const mask = codeMask(text);
      const re = new RegExp(`\\.\\s*${name}\\s*\\(`, "g");
      let m = null;
      let hit = null;
      while ((m = re.exec(text)) !== null) {
        if (mask[m.index] === " ") continue;
        hit = m;
        break;
      }
      if (!hit) break;
      m = hit;
      const recvEnd = m.index;
      // A leading spread is not part of the receiver: `[...xs.map(f)]`
      // receives `xs`, and the spread converts at the array level later.
      const recvStart = scanOperandStart(text, mask, recvEnd, true);
      const receiver = text.slice(recvStart, recvEnd).trim();
      const open = text.indexOf("(", m.index);
      const close = matchDelim(text, open, "(", ")");
      if (close < 0 || !receiver) break;
      const args = text.slice(open + 1, close);
      gaps.push({
        kind: "control-flow",
        line: lineOf(text, m.index),
        detail: `.${name}() carried as ${fn}() — verify against the injected helper`,
      });
      if (name === "join") {
        const parts = splitTopLevel(args);
        const sep = parts[0] ?? rhaiString(", ");
        text = `${text.slice(0, recvStart)}${fn}(${receiver}, ${sep.trim() || rhaiString(", ")})${text.slice(close + 1)}`;
        continue;
      }
      if (name === "reduce") {
        text = `${text.slice(0, recvStart)}${fn}(${receiver}, ${args.trim()})${text.slice(close + 1)}`;
        continue;
      }
      // Single-closure methods: wrap bare function names as single-arg closures.
      let cb = args.trim();
      if (!/=>/.test(codeOnly(cb)) && /^[A-Za-z_$][\w$.]*$/.test(cb)) {
        cb = `|__x| ${cb}(__x)`;
      }
      void arity;
      text = `${text.slice(0, recvStart)}${fn}(${receiver}, ${cb})${text.slice(close + 1)}`;
    }
  }
  return text;
}

// Convert `new Set(E)` to (E) (membership via contains/push rewrites) and
// `delete O.K` / `delete O[E]` to O.remove(...).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertNewDelete(text, gaps) {
  text = replaceInCode(text, /\bnew\s+Set\s*\(/g, () => "WF_NEWSET(");
  text = foldCallArg(text, "WF_NEWSET(", (a) => `(${a || "[]"})`, gaps);
  if (/WF_NEWSET\(/.test(text)) {
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail:
        "new Set() carried as an array — membership via contains/push; verify dedup semantics",
    });
  }
  text = replaceInCode(text, /\bnew\s+(?!Set\b)([A-Za-z_$][\w$]*)/g, (m) => {
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail: `new ${m[1]}() has no Rhai form — rewrite by hand`,
    });
    return `new ${m[1]}`;
  });
  text = replaceInCode(text, /\bdelete\s+([A-Za-z_$][\w$.]*)\.([A-Za-z_$][\w$]*)/g, (m) => {
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail: `delete ${m[1]}.${m[2]} carried as remove() — verify by hand`,
    });
    return `${m[1]}.remove("${m[2]}")`;
  });
  return text;
}

// Convert object spreads to wf_merge chains and array spreads to + concat.
// `{...a, k: v}` becomes wf_merge(a, #{k: v}); `[...a, x]` becomes (a + [x]).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertSpreads(text, gaps) {
  // Object literals with a spread member.
  let guard = 0;
  while (guard++ < 1000) {
    const mask = codeMask(text);
    let at = -1;
    const re = /\.\.\./g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (mask[m.index] === " ") continue;
      at = m.index;
      break;
    }
    if (at < 0) return finishSpreads(text);
    // Find the enclosing { or [ by scanning left over the spread operand.
    // Entry separators (`,`, `:`) and newlines inside the literal do not
    // stop the walk — a spread after another entry is still a literal
    // spread. Only statement/assignment boundaries (`;`, `=`) do.
    let i = at - 1;
    while (i >= 0 && (mask[i] === " " || /\s/.test(text[i]))) i -= 1;
    // Walk left to the enclosing opener at the spread's depth.
    let depth = 0;
    let open = -1;
    let openCh = "";
    for (let j = i; j >= 0; j -= 1) {
      if (mask[j] === " ") continue;
      const c = text[j];
      if (c === "}" || c === ")" || c === "]") depth += 1;
      else if (c === "{" || c === "(" || c === "[") {
        if (depth === 0) {
          open = j;
          openCh = c;
          break;
        }
        depth -= 1;
      } else if (depth === 0 && (c === ";" || c === "=")) {
        break;
      }
    }
    if (open < 0 || (openCh !== "{" && openCh !== "[")) {
      gaps.push({
        kind: "dynamic-options",
        line: lineOf(text, at),
        detail: "spread outside an object/array literal — expand by hand",
      });
      return finishSpreads(text);
    }
    if (openCh === "{") {
      // A `{` opened by a declaration is a destructuring pattern
      // (`const { a, ...rest } = o`), not a value — merging would
      // change the binding. Literals follow `=`, `(`, `[`, `,`, `:`.
      const before = text.slice(0, open).replace(/\s+$/, "");
      if (/(?:^|[^\w$])(?:const|let|var)\s*$/.test(before)) {
        gaps.push({
          kind: "dynamic-options",
          line: lineOf(text, at),
          detail: "destructuring rest element — bind by hand, do not merge",
        });
        return finishSpreads(text);
      }
    }
    const close = matchDelim(text, open, openCh, openCh === "{" ? "}" : "]");
    if (close < 0) return finishSpreads(text);
    const inner = text.slice(open + 1, close);
    const parts = splitTopLevel(inner);
    // A spread part may open with `//` / `/**/` documentation lines
    // (splitTopLevel glues comments to the following part). Strip those
    // for the spread test and carry them inside the merged form.
    const splitComments = (/** @type {string} */ p) => {
      const m = /^((?:\s*\/\/[^\n]*|\s*\/\*[\s\S]*?\*\/)*)([\s\S]*)$/.exec(p);
      return m ? { head: m[1], core: m[2] } : { head: "", core: p };
    };
    if (!parts.some((p) => /^\s*\.\.\./.test(splitComments(p).core))) return finishSpreads(text);
    gaps.push({
      kind: "dynamic-options",
      line: lineOf(text, at),
      detail: "spread carried via wf_merge/array concat — verify merge order by hand",
    });
    if (openCh === "{") {
      let acc = null;
      for (const p of parts) {
        const t = p.trim();
        const { head, core } = splitComments(p);
        if (/^\s*\.\.\./.test(core)) {
          const target = core.replace(/^\s*\.\.\./, "").trim();
          // Leading documentation lines ride inside the merged operand.
          const operand = head.trim() ? `(${head.trim()}\n(${target}))` : `(${target})`;
          acc = acc == null ? operand : `wf_merge(${acc}, ${operand})`;
        } else {
          acc = acc == null ? `#{${t}}` : `wf_merge(${acc}, #{${t}})`;
        }
      }
      text = `${text.slice(0, open)}(${acc ?? "#{}"})${text.slice(close + 1)}`;
    } else {
      const expr = parts
        .map((p) => {
          const { head, core } = splitComments(p);
          if (/^\s*\.\.\./.test(core)) {
            const target = core.replace(/^\s*\.\.\./, "").trim();
            return head.trim() ? `(${head.trim()}\n(${target}))` : `(${target})`;
          }
          return `[${p.trim()}]`;
        })
        .join(" + ");
      text = `${text.slice(0, open)}(${expr || "[]"})${text.slice(close + 1)}`;
    }
  }
  return finishSpreads(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function finishSpreads(text) {
  return text;
}

// Convert bare `{ ... }` object literals to Rhai `#{ ... }` maps,
// expanding JS shorthand (`{ step }` -> `#{ "step": step }`). Runs after
// every other expression converter, so ternaries, spreads, and template
// interpolations inside values are already Rhai. Only value positions
// convert: a `{` after `)`, `]`, an identifier, `|`, or a block keyword
// (`else`, `try`, `do`, `=>`) is a block and is left alone.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertObjectLiterals(text, gaps) {
  let cursor = 0;
  let guard = 0;
  while (guard++ < 500) {
    const mask = codeMask(text);
    let open = -1;
    let skipTo = -1;
    for (let i = cursor; i < text.length; i += 1) {
      if (mask[i] === " " || text[i] !== "{") continue;
      // Look back over whitespace for the opener context.
      let j = i - 1;
      while (j >= 0 && (mask[j] === " " || /\s/.test(text[j]))) j -= 1;
      const prev = j < 0 ? "" : (text[j] ?? "");
      const before = j < 0 ? "" : text.slice(0, j + 1);
      if (
        prev === "=" ||
        prev === "(" ||
        prev === "[" ||
        prev === "," ||
        prev === ":" ||
        prev === "?"
      ) {
        open = i;
        break;
      }
      if (j < 0 || /(?:^|[^\w$])(?:return)\s*$/.test(before)) {
        open = i;
        break;
      }
      // A `{` opened by a declaration is a destructuring pattern, not a
      // value — flag it, skip past it, and keep converting the rest.
      if (/(?:^|[^\w$])(?:const|let|var)\s*$/.test(before)) {
        gaps.push({
          kind: "control-flow",
          line: lineOf(text, i),
          detail:
            "destructuring declaration `{ ... } = ...` — expand to explicit field reads by hand",
        });
        const close = matchDelim(text, i, "{", "}");
        skipTo = close < 0 ? i + 1 : close + 1;
        break;
      }
    }
    if (open === -1 && skipTo < 0) return text;
    if (skipTo >= 0) {
      cursor = skipTo;
      continue;
    }
    const close = matchDelim(text, open, "{", "}");
    if (close < 0) return text;
    const obj = text.slice(open, close + 1);
    text = `${text.slice(0, open)}${jsSchemaToRhai(obj)}${text.slice(close + 1)}`;
    cursor = open + 2;
  }
  return text;
}

// Convert `C ? A : B` ternaries to (if C { A } else { B }). Runs last:
// earlier passes remove the other `?` spellings.
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @returns {string}
 */
function convertTernary(text, gaps) {
  let guard = 0;
  while (guard++ < 5000) {
    const mask = codeMask(text);
    let q = -1;
    for (let k = 0; k < text.length; k += 1) {
      if (
        text[k] === "?" &&
        mask[k] !== " " &&
        text[k + 1] !== "?" &&
        text[k + 1] !== "." &&
        text[k - 1] !== "?"
      ) {
        q = k;
        break;
      }
    }
    if (q < 0) return text;
    // A ternary condition spans && / || — `a && b ? c : d` tests both.
    const start = scanOperandStart(text, mask, q, false, true);
    const cond = text.slice(start, q).trim();
    // Find the matching colon at depth 0, skipping nested ternaries.
    // Newlines do not end the search (multi-line `? a\n: b` is common),
    // but a bare `=` does — it starts a new statement, so a colon past it
    // belongs to something else. `;` and `,` likewise end it.
    let nest = 0;
    let colon = -1;
    {
      let depth = 0;
      for (let j = q + 1; j < text.length; j += 1) {
        if (mask[j] === " ") continue;
        const c = text[j];
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && c === "?") nest += 1;
        else if (depth === 0 && c === ":") {
          if (nest === 0) {
            colon = j;
            break;
          }
          nest -= 1;
        } else if (
          depth === 0 &&
          (c === ";" ||
            c === "," ||
            (c === "=" &&
              !/[=!<>]/.test(text[j - 1] ?? "") &&
              text[j + 1] !== "=" &&
              text[j + 1] !== ">"))
        ) {
          break;
        }
      }
    }
    if (!cond || colon < 0) {
      gaps.push({
        kind: "control-flow",
        line: lineOf(text, q),
        detail: `ternary without a matching colon (${text
          .slice(start, q + 40)
          .trim()
          .slice(0, 60)}) — rewrite by hand`,
      });
      return text;
    }
    const mid = text.slice(q + 1, colon).trim();
    const bend = scanValueEnd(text, mask, colon + 1, true);
    const tail = text.slice(colon + 1, bend).trim();
    if (!mid || !tail) return text;
    gaps.push({
      kind: "control-flow",
      line: lineOf(text, q),
      detail: "ternary carried as if/else — verify branch types by hand",
    });
    text = `${text.slice(0, start)}(if ${cond} { ${mid} } else { ${tail} })${text.slice(bend)}`;
  }
  return text;
}

// Run the expression passes to exhaustion (bounded).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @param {number} line
 * @returns {string}
 */
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @param {number} line
 * @param {{ n: number }} [ctr]
 * @returns {string}
 */
function normalizeExprSyntax(text, gaps, line, ctr) {
  void line;
  // Masked operator fixes that are safe on fragments and statements alike:
  // ===/!== have no Rhai form, and awaited host calls already block.
  text = replaceInCode(text, /===/g, () => "==");
  text = replaceInCode(text, /!==/g, () => "!=");
  text = replaceInCode(text, /\bawait\s+/g, () => "");
  // Rhai spells the empty value (); bare null/undefined/void 0 would fail
  // to resolve at runtime.
  text = replaceInCode(text, /\bnull\b/g, () => "()");
  text = replaceInCode(text, /\bundefined\b/g, () => "()");
  text = replaceInCode(text, /\bvoid\s+0\b/g, () => "()");
  let prev = "";
  let guard = 0;
  let cur = text;
  while (cur !== prev && guard++ < 10) {
    prev = cur;
    // Findings from a pass that changes nothing were already reported by
    // the pass that produced this text (no converter creates a flaggable
    // construct without consuming it) — drop them to avoid double reports.
    const mark = gaps.length;
    cur = convertBackticks(cur, gaps);
    cur = convertOptionalChains(cur, gaps);
    cur = convertNullish(cur, gaps);
    cur = convertArrows(cur, gaps, ctr);
    cur = convertTypeFamily(cur, gaps);
    cur = convertHigherOrder(cur, gaps);
    cur = convertNewDelete(cur, gaps);
    cur = convertSpreads(cur, gaps);
    cur = convertTernary(cur, gaps);
    cur = convertObjectLiterals(cur, gaps);
    if (cur === prev) gaps.length = mark;
  }
  return cur;
}

// Split carried text into top-level statements with global offsets.
// Depth counts (), [], {} plus `${}` template nesting; strings and comments
// are skipped. A statement ends at `;` (depth 0) or at the close of a
// depth-0 brace group.
/**
 * @param {string} text
 * @param {number} base
 * @returns {{ text: string, start: number, end: number }[]}
 */
function splitTopStatements(text, base) {
  /** @type {{ text: string, start: number, end: number }[]} */
  const out = [];
  const n = text.length;
  let i = 0;
  let segStart = 0;
  let depth = 0;
  let state = "code";
  /** @type {number[]} */
  const tmplStack = [];
  /** @param {number} end @returns {void} */
  const pushSeg = (end) => {
    const slice = text.slice(segStart, end);
    if (slice.trim()) out.push({ text: slice, start: base + segStart, end: base + end });
    segStart = end;
  };
  while (i < n) {
    const c = text[i];
    const nx = text[i + 1] ?? "";
    if (state === "line") {
      if (c === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && nx === "/") {
        state = "code";
        i += 2;
      } else i += 1;
      continue;
    }
    if (state === "sq" || state === "dq") {
      if (c === "\\") i += 2;
      else if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
        state = "code";
        i += 1;
      } else i += 1;
      continue;
    }
    if (state === "tm") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        state = "code";
        i += 1;
      } else if (c === "$" && nx === "{") {
        tmplStack.push(depth);
        depth += 1;
        state = "code";
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === "/" && nx === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && nx === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "/" && nx !== "/" && nx !== "*") {
      // Skip a regex literal as one unit so a quote inside `/…/` never
      // opens a phantom string; division falls through.
      const rend = regexLiteralEnd(text, i);
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
      state = "tm";
      i += 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") {
      if (tmplStack.length && c === "}" && depth === tmplStack[tmplStack.length - 1] + 1) {
        // Closing brace of a `${...}` interpolation: resume template text.
        depth -= 1;
        tmplStack.pop();
        state = "tm";
        i += 1;
        continue;
      }
      depth -= 1;
      if (depth < 0) depth = 0;
      if (depth === 0 && c === "}") {
        // A depth-0 closing brace may end a block statement; a following
        // `else`/`catch`/`while` continues it — rejoin below.
        pushSeg(i + 1);
      }
      i += 1;
      continue;
    }
    if (c === ";" && depth === 0) {
      pushSeg(i + 1);
      i += 1;
      continue;
    }
    i += 1;
  }
  pushSeg(n);
  // Rejoin continuations: `else`/`catch`/`finally` continue a block, and a
  // `while` continues one only for `do { ... } while (...);` — a fresh
  // `while` loop after `;` starts its own statement and must not glue to
  // the previous one (or every loop nested after it degrades to an
  // expression and survives unconverted).
  /** @type {{ text: string, start: number, end: number }[]} */
  const joined = [];
  for (const s of out) {
    const t = s.text.trimStart();
    const m = /^(else|catch|finally|while)\b/.exec(t);
    if (joined.length && m) {
      const prev = /** @type {{ text: string, start: number, end: number }} */ (
        joined[joined.length - 1]
      );
      const continuesBlock = m[1] !== "while" || /}\s*$/.test(prev.text);
      if (continuesBlock) {
        joined.pop();
        joined.push({ text: `${prev.text}${s.text}`, start: prev.start, end: s.end });
        continue;
      }
    }
    joined.push(s);
  }
  return joined;
}

// Normalize carried statements: brace-adding for if/for/while/else, loop
// header conversion to Rhai, try/catch unwrapping, nested `function` to
// `fn`. Returns Rhai statement text (possibly several statements).
/**
 * @param {string} text
 * @param {Gap[]} gaps
 * @param {{ n: number }} ctr
 * @returns {string}
 */
function normalizeStatements(text, gaps, ctr) {
  const stmts = splitTopStatements(text, 0);
  /** @type {string[]} */
  const out = [];
  for (const stmt of stmts) {
    out.push(normalizeOneStatement(stmt.text, gaps, ctr));
  }
  return out.filter((s) => s.trim()).join("\n");
}

// Normalize one top-level statement.
/**
 * @param {string} stmt
 * @param {Gap[]} gaps
 * @param {{ n: number }} ctr
 * @returns {string}
 */
function normalizeOneStatement(stmt, gaps, ctr) {
  const t = stmt.trim();
  if (!t) return stmt;
  // Peel leading comment lines/blocks: they document the statement but must
  // not shield it from normalization (a `//` run glues to the following
  // statement in splitTopStatements).
  {
    const lineRun = /^((?:\s*\/\/[^\n]*\n)+)([\s\S]*)$/.exec(stmt);
    if (lineRun && lineRun[2].trim()) {
      return `${lineRun[1]}${normalizeOneStatement(lineRun[2], gaps, ctr)}`;
    }
    const blockRun = /^(\s*\/\*[\s\S]*?\*\/\s*)([\s\S]*)$/.exec(stmt);
    if (blockRun && blockRun[2].trim()) {
      return `${blockRun[1]}${normalizeOneStatement(blockRun[2], gaps, ctr)}`;
    }
    if (t.startsWith("//")) return stmt;
  }
  // Nested function declarations become Rhai fns.
  {
    const m = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(t);
    if (m) {
      const open = stmt.indexOf("(", m.index);
      const close = matchDelim(stmt, open, "(", ")");
      const bOpen = stmt.indexOf("{", close);
      const bClose = matchDelim(stmt, bOpen, "{", "}");
      gaps.push({
        kind: "control-flow",
        line: 1,
        detail: `nested function ${m[2]}() carried as fn — verify by hand`,
      });
      const body = normalizeStatements(stmt.slice(bOpen + 1, bClose), gaps, ctr);
      return `fn ${m[2]}(${stmt.slice(open + 1, close).trim()}) {\n${body}\n}`;
    }
  }
  // try { A } catch [ (e) ] { B } -> A (Rhai cannot catch).
  if (/^try\b/.test(t)) {
    const bOpen = stmt.indexOf("{");
    const bClose = matchDelim(stmt, bOpen, "{", "}");
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail:
        "try/catch carried as the try body only (Rhai cannot catch) — verify fail-open behavior",
    });
    return normalizeStatements(stmt.slice(bOpen + 1, bClose), gaps, ctr);
  }
  // if / while with parenthesized headers.
  {
    const m = /^(if|while)\s*\(/.exec(t);
    if (m) {
      const kind = m[1];
      const open = stmt.indexOf("(");
      const close = matchDelim(stmt, open, "(", ")");
      if (close < 0) return normalizeExprSyntax(stmt, gaps, 1);
      const cond = normalizeExprSyntax(stmt.slice(open + 1, close).trim() || "true", gaps, 1);
      let rest = stmt.slice(close + 1).trimStart();
      let body = "";
      let tail = "";
      if (rest.startsWith("{")) {
        const bClose = matchDelim(rest, 0, "{", "}");
        body = normalizeStatements(rest.slice(1, bClose), gaps, ctr);
        tail = rest.slice(bClose + 1).trimStart();
      } else {
        const first = splitTopStatements(rest, 0)[0];
        const raw = first ? first.text : rest;
        body = normalizeStatements(raw, gaps, ctr);
        tail = rest.slice(raw.length).trimStart();
      }
      let out = `${kind} (${cond}) {\n${body}\n}`;
      if (kind === "if" && tail) {
        if (/^else\b/.test(tail)) {
          const afterElse = tail.slice(4).trimStart();
          if (/^if\b/.test(afterElse)) {
            out += ` else {\n${normalizeOneStatement(afterElse, gaps, ctr)}\n}`;
          } else if (afterElse.startsWith("{")) {
            const bClose = matchDelim(afterElse, 0, "{", "}");
            out += ` else {\n${normalizeStatements(afterElse.slice(1, bClose), gaps, ctr)}\n}`;
          } else if (afterElse) {
            out += ` else {\n${normalizeStatements(afterElse, gaps, ctr)}\n}`;
          } else {
            out += " else {}";
          }
        } else {
          out += `\n${normalizeExprSyntax(tail, gaps, 1)}`;
        }
      } else if (tail) {
        out += `\n${normalizeStatements(tail, gaps, ctr)}`;
      }
      return out;
    }
  }
  // for loops: C-style, for-of (incl. Object.entries destructuring), for-in.
  {
    const m = /^for\s*\(/.exec(t);
    if (m) {
      return normalizeForStatement(stmt, gaps, ctr);
    }
    // Already-Rhai `for x in y` (emitted job builders): normalize the body.
    const m2 = /^for\s+([A-Za-z_$][\w$]*)\s+in\s+([\s\S]+?)\{([\s\S]*)\}\s*$/.exec(t);
    if (m2) {
      return `for ${m2[1]} in ${normalizeExprSyntax(m2[2].trim(), gaps, 1)} {\n${normalizeStatements(m2[3], gaps, ctr)}\n}`;
    }
  }
  // A bare block scopes its statements.
  if (t.startsWith("{") && t.endsWith("}")) {
    return `{\n${normalizeStatements(t.slice(1, -1), gaps, ctr)}\n}`;
  }
  // return { ... } carries a map value, not a block.
  {
    const m = /^return\b/.exec(t);
    if (m) {
      const rest = t.slice(m[0].length).trimStart();
      if (rest.startsWith("{")) {
        const close = matchDelim(t, t.indexOf("{"), "{", "}");
        const obj = close < 0 ? rest : t.slice(t.indexOf("{"), close + 1);
        const tail = close < 0 ? "" : t.slice(close + 1);
        return `return ${normalizeExprSyntax(jsSchemaToRhai(obj), gaps, 1)}${tail ? ` ${tail}` : ""}`;
      }
      const retExpr = normalizeExprSyntax(rest.replace(/;$/, ""), gaps, 1).trim();
      return `return ${retExpr || "()"};`;
    }
  }
  return normalizeExprSyntax(stmt, gaps, 1);
}

// Split a C-style for header on top-level semicolons (splitTopLevel only
// splits commas). Depth counts delimiters at code positions; strings,
// comments, templates, and regex literals are already blanked in the mask.
/**
 * @param {string} header
 * @returns {string[]}
 */
function splitForHeader(header) {
  const mask = codeMask(header);
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < header.length; i += 1) {
    if (mask[i] === " ") continue;
    const c = header[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) {
      parts.push(header.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(header.slice(start));
  return parts;
}

// Normalize one `for (...) ...` statement.
/**
 * @param {string} stmt
 * @param {Gap[]} gaps
 * @param {{ n: number }} ctr
 * @returns {string}
 */
function normalizeForStatement(stmt, gaps, ctr) {
  const open = stmt.indexOf("(");
  const close = matchDelim(stmt, open, "(", ")");
  if (close < 0) return normalizeExprSyntax(stmt, gaps, 1);
  const header = stmt.slice(open + 1, close).trim();
  let rest = stmt.slice(close + 1).trimStart();
  let body = "";
  let tail = "";
  if (rest.startsWith("{")) {
    const bClose = matchDelim(rest, 0, "{", "}");
    body = bClose < 0 ? rest.slice(1) : rest.slice(1, bClose);
    tail = bClose < 0 ? "" : rest.slice(bClose + 1).trimStart();
  } else if (rest) {
    const first = splitTopStatements(rest, 0)[0];
    const raw = first ? first.text : rest;
    body = raw;
    tail = rest.slice(raw.length).trimStart();
  }
  const normBody = () => normalizeStatements(body, gaps, ctr);
  const tailText = tail ? `\n${normalizeStatements(tail, gaps, ctr)}` : "";
  // C-style: for (init; cond; incr)
  if (/;/.test(header)) {
    const parts = splitForHeader(header);
    if (parts.length >= 3) {
      const init = parts[0].replace(/^(let|var|const)\s+/, "let ");
      const cond = parts[1].trim() || "true";
      const incr = parts.slice(2).join(";").trim();
      gaps.push({
        kind: "control-flow",
        line: 1,
        detail: "C-style for carried as init + while — verify bounds by hand",
      });
      return `${normalizeExprSyntax(init, gaps, 1)};\nwhile (${normalizeExprSyntax(cond, gaps, 1)}) {\n${normBody()}\n${incr ? `${normalizeExprSyntax(incr, gaps, 1)};` : ""}\n}${tailText}`;
    }
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail: `for header (${header.slice(0, 80)}) has no mechanical Rhai form — rewrite by hand`,
    });
    return `${stmt}`;
  }
  // for-of / for-in.
  const ofMatch = /^(?:let|var|const)\s+([\s\S]+?)\s+of\s+([\s\S]+)$/.exec(header);
  const inMatch = /^(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s+in\s+([\s\S]+)$/.exec(header);
  if (ofMatch) {
    const target = ofMatch[1].trim();
    const iter = normalizeExprSyntax(ofMatch[2].trim(), gaps, 1);
    const destructure = /^\[([^\]]+)\]$/.exec(target);
    if (destructure) {
      const names = destructure[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const entries = /^\s*Object\s*\.\s*entries\s*\(\s*([\s\S]+?)\s*\)\s*$/.exec(
        ofMatch[2].trim(),
      );
      if (entries && names.length === 2) {
        const id = `wf_entries${ctr.n++}`;
        gaps.push({
          kind: "control-flow",
          line: 1,
          detail: "Object.entries destructuring carried via keys() — verify by hand",
        });
        return `let ${id} = ${normalizeExprSyntax(entries[1], gaps, 1)};\nfor ${names[0]} in ${id}.keys() {\nlet ${names[1]} = ${id}[${names[0]}];\n${normBody()}\n}${tailText}`;
      }
      gaps.push({
        kind: "control-flow",
        line: 1,
        detail: `destructuring loop (${target}) has no Rhai form — rewrite by hand`,
      });
      return `${stmt}`;
    }
    if (/^\s*\{/.test(target)) {
      gaps.push({
        kind: "control-flow",
        line: 1,
        detail: `destructuring loop target (${target.slice(0, 40)}) has no Rhai form — expand to explicit field reads by hand`,
      });
      return `${stmt}`;
    }
    const v = target.replace(/^(let|var|const)\s+/, "").trim() || target;
    return `for ${v} in ${iter} {\n${normBody()}\n}${tailText}`;
  }
  if (inMatch) {
    gaps.push({
      kind: "control-flow",
      line: 1,
      detail: "for-in carried as keys() — verify by hand",
    });
    return `for ${inMatch[1]} in ${normalizeExprSyntax(inMatch[2].trim(), gaps, 1)}.keys() {\n${normBody()}\n}${tailText}`;
  }
  gaps.push({
    kind: "control-flow",
    line: 1,
    detail: `for header (${header.slice(0, 80)}) has no mechanical Rhai form — rewrite by hand`,
  });
  return `${stmt}`;
}

// Extract one option-object field as a literal string value (quoted only).
// Template-literal and expression forms come back through extractFieldExpr.
/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
function fieldLiteral(body, name) {
  const expr = extractFieldExpr(body, name);
  if (expr == null) return null;
  const t = expr.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1).replace(/"/g, '\\"')}"` : t);
    } catch {
      return null;
    }
  }
  return null;
}

// Collect helper functions (declarations, expressions, and arrows) so the
// emitter can carry them as Rhai fn blocks instead of flattening their
// dispatches. Every function is structure: dispatching helpers keep their
// agent()/parallel() sites in place, and pure-logic helpers stay defined
// for the callers the emitter carries.
/**
 * @param {string} source
 * @param {string} masked
 * @returns {HelperFact[]}
 */
function collectHelpers(source, masked) {
  /** @type {HelperFact[]} */
  const out = [];
  const patterns = [
    /(^|[^\w$])async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(^|[^\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(/g,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*=>/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      // Groups 1-2 are (prefix, name) for declarations, (name, -) for consts.
      const name = m[2] ?? m[1];
      if (!name || out.some((h) => h.name === name)) continue;
      if (masked[m.index] === " ") continue;
      const parenOpen = source.indexOf("(", m.index);
      if (parenOpen < 0) continue;
      const parenClose = matchDelim(source, parenOpen, "(", ")");
      if (parenClose < 0) continue;
      const after = source.slice(parenClose + 1).trimStart();
      let start = m.index;
      let end = -1;
      let params = source.slice(parenOpen + 1, parenClose).trim();
      if (after.startsWith("{")) {
        const bOpen = source.indexOf("{", parenClose);
        const bClose = matchDelim(source, bOpen, "{", "}");
        if (bClose < 0) continue;
        end = bClose;
      } else if (after.startsWith("=>")) {
        const arrowBody = source
          .slice(parenClose + 1 + source.slice(parenClose + 1).indexOf("=>") + 2)
          .trimStart();
        if (arrowBody.startsWith("{")) {
          const bOpen = source.indexOf(
            "{",
            parenClose + (source.slice(parenClose + 1).indexOf("=>") + 2),
          );
          const bClose = matchDelim(source, bOpen, "{", "}");
          if (bClose < 0) continue;
          end = bClose;
        } else {
          continue;
        }
      } else {
        continue;
      }
      const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
      out.push({
        name,
        params,
        line: lineOf(source, m.index),
        start: lineStart,
        end,
        body: source.slice(lineStart, end + 1),
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Collect top-level `const`/`let NAME = <expr>;` statements (excluding meta
// and schema consts, which the emitter handles separately). Values are
// carried as translated `let` bindings so prompts/parallel builders that
// reference them stay defined under validate_only. `let` bindings inside
// for-headers are skipped (they belong to the loop).
/**
 * @param {string} source
 * @param {string} masked
 * @param {Set<string>} skipNames
 * @returns {ConstFact[]}
 */
function collectConsts(source, masked, skipNames) {
  /** @type {ConstFact[]} */
  const out = [];
  const re = /(^|[^\w$])(const|let)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (masked[m.index] === " ") continue;
    const name = m[3];
    const lineStart0 = source.lastIndexOf("\n", m.index - 1) + 1;
    if (/\bfor\s*\([^)]*$/.test(source.slice(lineStart0, m.index))) continue;
    if (skipNames.has(name) || out.some((c) => c.name === name)) continue;
    const eqIdx = source.indexOf("=", m.index);
    // Find the statement end: semicolon or newline at depth 0.
    let depth = 0;
    let state = "code";
    const tmplStack = [];
    let end = -1;
    for (let i = eqIdx + 1; i < source.length; i += 1) {
      const c = source[i];
      const n = source[i + 1] ?? "";
      if (state === "code" && c === "/" && n === "/") {
        state = "line";
        i += 1;
        continue;
      }
      if (state === "code" && c === "/" && n === "*") {
        state = "block";
        i += 1;
        continue;
      }
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
      if (state === "code" && c === "/" && n !== "/" && n !== "*") {
        // Skip a regex literal as one unit so a quote inside `/…/` never
        // opens a phantom string; division falls through.
        const rend = regexLiteralEnd(source, i);
        if (rend > 0) {
          i = rend - 1;
          continue;
        }
      }
      if (state === "code" && (c === "'" || c === '"' || c === "`")) {
        state = c === "'" ? "sq" : c === '"' ? "dq" : "tm";
        continue;
      }
      if (state === "sq" || state === "dq") {
        if (c === "\\") {
          i += 1;
          continue;
        }
        if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) state = "code";
        continue;
      }
      if (state === "tm") {
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
          depth += 1;
          i += 1;
          continue;
        }
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      if (c === ")" || c === "]" || c === "}") {
        if (tmplStack.length && c === "}" && depth === tmplStack[tmplStack.length - 1] + 1) {
          depth -= 1;
          tmplStack.pop();
          state = "tm";
          continue;
        }
        depth -= 1;
      }
      if (depth < 0) {
        end = i - 1;
        break;
      }
      if (depth === 0 && (c === ";" || c === "\n")) {
        if (c === "\n") {
          // The value continues on the next line when it ends with an
          // arrow or a binary operator (e.g. `() =>` or `a +`).
          const soFar = source.slice(eqIdx + 1, i).trimEnd();
          if (/(=>|&&|\|\||\?\?|[+\-*/%&|^?:=])$/.test(soFar)) continue;
        }
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const expr = source
      .slice(eqIdx + 1, end)
      .replace(/;$/, "")
      .trim();
    if (!expr || /^\s*require\s*\(/.test(expr)) continue;
    const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
    out.push({ name, expr, line: lineOf(source, m.index), start: lineStart, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Collect while/for loops in code order so the emitter can keep the round
// loop (e.g. while (round < maxRounds)) instead of flattening dispatches.
/**
 * @param {string} source
 * @param {string} masked
 * @returns {LoopFact[]}
 */
function collectLoops(source, masked) {
  /** @type {LoopFact[]} */
  const out = [];
  const re = /(?<![\w$])(while|for)\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (masked[m.index] === " ") continue;
    const kind = m[1];
    const parenOpen = source.indexOf("(", m.index);
    const parenClose = matchDelim(source, parenOpen, "(", ")");
    if (parenClose < 0) continue;
    const after = source.slice(parenClose + 1).trimStart();
    if (!after.startsWith("{")) continue;
    const bOpen = source.indexOf("{", parenClose);
    const bClose = matchDelim(source, bOpen, "{", "}");
    if (bClose < 0) continue;
    const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
    out.push({
      kind,
      header: source.slice(parenOpen + 1, parenClose).trim(),
      body: source.slice(bOpen + 1, bClose),
      line: lineOf(source, m.index),
      start: lineStart,
      end: bClose,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Extract canonical facts (the agent request shape) from Claude source.
// Only syntactic calls count: matches inside comments or string/template
// text are not call sites (codeOnly masking, like the Muse converter).
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
    hasReturn: /^\s*return\b/m.test(codeOnly(source)),
    schemas: [],
    helpers: [],
    phaseCalls: [],
    logCalls: [],
    argsReads: [],
    parallels: [],
    consts: [],
    loops: [],
    returnSrc: null,
  };
  const masked = codeOnly(source);
  const maskedForMeta = masked;
  const metaMatch = /export\s+const\s+meta\s*=\s*\{/.exec(source);
  if (metaMatch && maskedForMeta[metaMatch.index] !== " ") {
    const openIdx = source.indexOf("{", metaMatch.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    const block = closeIdx > 0 ? source.slice(openIdx, closeIdx + 1) : "";
    const titles = [...block.matchAll(/title\s*:\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
    /** @type {GrokPhase[]} */
    const details = [...block.matchAll(/\{[^{}]*?title\s*:\s*(['"])([^'"]+)\1([^{}]*?)\}/g)].map(
      (m) => {
        const tail = m[3] ?? "";
        const d = /detail\s*:\s*(['"`])((?:\\.|[^'"`\\])*)\1/.exec(tail);
        let detail = null;
        if (d) {
          try {
            detail =
              d[1] === "'"
                ? d[2].replace(/\\'/g, "'")
                : JSON.parse(`${d[1] === "`" ? '"' : d[1]}${d[2]}${d[1] === "`" ? '"' : d[1]}`);
          } catch {
            detail = d[2];
          }
        }
        return { title: m[2], detail };
      },
    );
    facts.meta = {
      name: field(block, "name"),
      description: field(block, "description"),
      whenToUse: field(block, "whenToUse"),
      phases: titles,
      phaseDetails: details.length ? details : titles.map((t) => ({ title: t, detail: null })),
    };
  }
  // Schema consts (and fragments) defined in the source, for defined
  // output_schema maps in the Rhai output. Matches in comments/strings
  // are not definitions.
  for (const c of collectSchemaConsts(source)) {
    if (masked[c.openIdx] === " ") continue;
    const literal = source.slice(c.openIdx, c.closeIdx + 1);
    facts.schemas?.push({ name: c.name, literal, line: lineOf(source, c.openIdx) });
  }
  // parallel() sites in code only.
  /** @type {ParallelFact[]} */
  const parallels = [];
  {
    const re = /(?<![\w$.])parallel\s*\(/g;
    let pm;
    while ((pm = re.exec(source)) !== null) {
      if (masked[pm.index] === " ") continue;
      const openIdx = source.indexOf("(", pm.index);
      const closeIdx = matchDelim(source, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      parallels.push({
        line: lineOf(source, pm.index),
        start: pm.index,
        openIdx,
        closeIdx,
        inner: source.slice(openIdx + 1, closeIdx),
      });
    }
  }
  facts.parallels = parallels;
  facts.parallelSites = parallels.length;
  // agent() sites in code only, with positions for parallel membership.
  /** @type {{ start: number, openIdx: number, closeIdx: number }[]} */
  const sites = [];
  {
    const re = /(?<![\w$.])agent\s*\(/g;
    let am;
    while ((am = re.exec(source)) !== null) {
      if (masked[am.index] === " ") continue;
      const openIdx = source.indexOf("(", am.index);
      const closeIdx = matchDelim(source, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      sites.push({ start: am.index, openIdx, closeIdx });
    }
  }
  sites.sort((a, b) => a.start - b.start);
  /** @param {number} pos @returns {boolean} */
  const inParallel = (pos) => parallels.some((p) => pos > p.openIdx && pos < p.closeIdx);
  for (const site of sites) {
    const args = splitTopLevel(source.slice(site.openIdx + 1, site.closeIdx));
    const rawOpts = (args[1] ?? "").trim();
    const isObjOpts = rawOpts.startsWith("{");
    const optsBody = (() => {
      if (!isObjOpts || !rawOpts) return "";
      const close = matchDelim(rawOpts, 0, "{", "}");
      if (close < 0) return "";
      return rawOpts.slice(1, close);
    })();
    const agentTypeExpr = extractFieldExpr(optsBody, "agentType");
    let agentType = null;
    let agentTypeDyn = null;
    if (agentTypeExpr) {
      const t = agentTypeExpr.trim();
      const lit = /^(['"])(.*)\1$/.exec(t);
      if (lit) {
        agentType = lit[2];
      } else {
        agentTypeDyn = t;
      }
    }
    const labelSrc = extractFieldExpr(optsBody, "label");
    const phaseSrc = extractFieldExpr(optsBody, "phase");
    const modelSrc = extractFieldExpr(optsBody, "model");
    const schemaRaw = extractFieldExpr(optsBody, "schema");
    const classified = classifySchemaExpr(schemaRaw);
    facts.calls.push({
      line: lineOf(source, site.start),
      start: site.start,
      openIdx: site.openIdx,
      closeIdx: site.closeIdx,
      promptSrc: args[0] ?? "",
      agentType,
      agentTypeExpr: agentTypeDyn,
      label: fieldLiteral(optsBody, "label"),
      labelSrc,
      phase: fieldLiteral(optsBody, "phase"),
      phaseSrc,
      model:
        fieldLiteral(optsBody, "model") ??
        (modelSrc && /^[A-Za-z_$][\w$.]*$/.test(modelSrc.trim()) ? modelSrc.trim() : null),
      schema: classified.kind === "named" ? (classified.name ?? null) : null,
      schemaKind: classified.kind,
      schemaExpr: classified.kind === "named" ? null : (classified.expr ?? null),
      schemaInline: classified.kind === "inline" ? true : undefined,
      dynamicOpts: !rawOpts ? undefined : isObjOpts ? undefined : true,
      spreadOpts: isObjOpts && /\.\.\./.test(codeOnly(optsBody)) ? true : undefined,
      inParallel: inParallel(site.start) || undefined,
    });
  }
  // phase()/log() calls in code only, in source order.
  for (const fn of ["phase", "log"]) {
    const re = new RegExp(`(?<![\\w$.])${fn}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(source)) !== null) {
      if (masked[m.index] === " ") continue;
      const openIdx = source.indexOf("(", m.index);
      const closeIdx = matchDelim(source, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      const fact = {
        expr: source.slice(openIdx + 1, closeIdx).trim(),
        line: lineOf(source, m.index),
        start: m.index,
      };
      if (fn === "phase") facts.phaseCalls?.push(fact);
      else facts.logCalls?.push(fact);
    }
  }
  // args.* reads in code (documented inputs like maxRounds).
  {
    const re = /(?<![\w$.])args\s*\.\s*([A-Za-z_$][\w$]*)/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(source)) !== null) {
      if (masked[m.index] === " ") continue;
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      // Look for `args.name ?? default` nearby for the fallback value.
      const after = source.slice(m.index, m.index + 120);
      const def = /args\s*\.\s*[A-Za-z_$][\w$]*\s*\?\?\s*([^,;\n]+)/.exec(after);
      facts.argsReads?.push({
        name,
        defaultSrc: def ? def[1].trim() : null,
        line: lineOf(source, m.index),
      });
    }
    facts.argsReads?.sort((a, b) => a.line - b.line);
  }
  facts.helpers = collectHelpers(source, masked);
  facts.loops = collectLoops(source, masked);
  {
    // Top-level return and hasReturn exclude helper bodies: the workflow
    // result is the top-level return, not a helper's early return.
    const hr = (facts.helpers ?? []).map((h) => ({ start: h.start, end: h.end }));
    const inHr = (/** @type {number} */ idx) => hr.some((r) => idx >= r.start && idx <= r.end);
    const maskedTop = masked
      .split("")
      .map((ch, idx) => (inHr(idx) ? " " : ch))
      .join("");
    facts.hasReturn = /^\s*return\b/m.test(maskedTop);
  }
  {
    const skip = new Set(["meta", ...(facts.schemas ?? []).map((s) => s.name)]);
    const helperRanges = (facts.helpers ?? []).map((h) => ({ start: h.start, end: h.end }));
    const loopRanges = (facts.loops ?? []).map((l) => ({ start: l.start, end: l.end }));
    /** @param {number} pos @returns {boolean} */
    const inHelper = (pos) => helperRanges.some((r) => pos >= r.start && pos <= r.end);
    /** @param {number} pos @returns {boolean} */
    const inLoop = (pos) => loopRanges.some((r) => pos >= r.start && pos <= r.end);
    facts.consts = collectConsts(source, masked, skip).filter(
      (c) => !inHelper(c.start) && !inLoop(c.start),
    );
  }
  // Top-level return expression (for complete()): the first return outside
  // helper bodies — a helper's early return is not the workflow result.
  {
    const hr = (facts.helpers ?? []).map((h) => ({ start: h.start, end: h.end }));
    /** @param {number} idx @returns {boolean} */
    const inHr = (idx) => hr.some((r) => idx >= r.start && idx <= r.end);
    const re = /(^|[^\w$])return\b/g;
    let m = null;
    let found = -1;
    while ((m = re.exec(masked)) !== null) {
      const kwIdx = m.index + m[1].length;
      if (inHr(kwIdx)) continue;
      found = kwIdx;
      break;
    }
    if (found >= 0) {
      const tail = source.slice(found + "return".length).trimStart();
      const semi = tail.search(/[;\n]/);
      facts.returnSrc = semi < 0 ? tail.trim() : tail.slice(0, semi).trim() || null;
    } else {
      facts.returnSrc = null;
    }
  }
  return facts;
}

/**
 * Capability hint for an agent type: reviewer-like types are read-only.
 * @param {string | null} agentType
 * @param {string | null} [agentTypeExpr]
 * @returns {string}
 */
function capabilityFor(agentType, agentTypeExpr) {
  const hay = `${agentType ?? ""} ${agentTypeExpr ?? ""}`;
  return READONLY_HINT.test(hay) ? "read-only" : "all";
}

/**
 * Tools that provably only read (never modify the tree, run commands, or
 * spawn subagents). An agent file whose `tools:` frontmatter lists only
 * these is read-only; anything else (Write, Edit, Bash, Task, unknown)
 * keeps the permissive "all" mode.
 */
const AGENT_READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "notebookread",
  "webfetch",
  "websearch",
]);

/**
 * Read the `tools:` frontmatter list from an agent file
 * (`<agentsDir>/<agentType>.md`). Returns null when the file is missing,
 * unreadable, or names no tools.
 * @param {string | null | undefined} agentsDir
 * @param {string} agentType
 * @returns {string[] | null}
 */
function readAgentTools(agentsDir, agentType) {
  if (!agentsDir) return null;
  const file = join(agentsDir, `${agentType}.md`);
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return null;
  const line = fm[1].split("\n").find((l) => /^\s*tools\s*:/i.test(l));
  if (!line) return null;
  const tools = line
    .slice(line.indexOf(":") + 1)
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return tools.length ? tools : null;
}

/**
 * Resolve capability_mode for a literal agent type against its agent file.
 * Verified (file + tools list) modes carry no gap; anything unresolvable
 * falls back to the name heuristic with the usual placeholder gap.
 * @param {string | null} agentType
 * @param {string | null} agentTypeExpr
 * @param {WorkflowFacts} facts
 * @returns {{ mode: string, verified: boolean }}
 */
function resolveCapability(agentType, agentTypeExpr, facts) {
  if (agentType && !MUSE_AGENT_TYPES.has(agentType)) {
    const tools = readAgentTools(facts.agentsDir, agentType);
    if (tools) {
      const readOnly = tools.every((t) => AGENT_READ_TOOLS.has(t.toLowerCase()));
      return { mode: readOnly ? "read-only" : "all", verified: true };
    }
  }
  return { mode: capabilityFor(agentType, agentTypeExpr), verified: false };
}

// Translate a `const` value expression to Rhai. Objects become maps,
// `??` fallbacks become explicit != () checks, null becomes ().
/**
 * @param {string} expr
 * @param {Gap[]} gaps
 * @param {number} line
 * @returns {string}
 */
function jsValueToRhai(expr, gaps, line) {
  const t = expr.trim();
  if (/^async\s*\(/.test(t) || /^\([^)]*\)\s*=>/.test(t) || /^[A-Za-z_$][\w$]*\s*=>/.test(t)) {
    gaps.push({
      kind: "control-flow",
      line,
      detail: `arrow function (${t.slice(0, 60)}) — rewrite as fn by hand`,
    });
    return t;
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    return normalizeExprSyntax(jsSchemaToRhai(t), gaps, line);
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1);
    // A spread anywhere inside routes the whole array through the syntax
    // normalizer: element-wise lowering strips the brackets first and the
    // spread then finds no enclosing `[` to concat onto.
    if (/\.\.\./.test(codeOnly(inner))) {
      return normalizeExprSyntax(t, gaps, line);
    }
    const parts = splitTopLevel(inner);
    // Array of plain objects (e.g. specs) -> array of maps.
    return `[${parts.map((p) => (p.trim().startsWith("{") ? jsSchemaToRhai(p.trim()) : jsExprToRhai(p.trim(), gaps, line))).join(", ")}]`;
  }
  if (/\?\?/.test(codeOnly(t))) {
    // First ?? at a code position (masked search skips strings/comments).
    const mask = codeMask(t);
    let idx = -1;
    for (let k = t.indexOf("??"); k >= 0; k = t.indexOf("??", k + 2)) {
      if (mask[k] !== " " && t[k + 2] !== "=") {
        idx = k;
        break;
      }
    }
    if (idx >= 0) {
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + 2).trim();
      const m = /args\s*\.\s*([A-Za-z_$][\w$]*)/.exec(codeOnly(left));
      if (m) {
        return `if args != () && args.${m[1]} != () { args.${m[1]} } else { ${jsValueToRhai(right, gaps, line)} }`;
      }
      // General fallbacks go through the syntax normalizer so ?. and
      // nested ?? on either side convert with their own gaps.
      return normalizeExprSyntax(t, gaps, line);
    }
  }
  if (t === "null" || t === "undefined" || t === "void 0") return "()";
  if (/^(true|false|-?\d+(\.\d+)?)$/.test(t)) return t;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
  ) {
    return jsExprToRhai(t, gaps, line);
  }
  // Helper calls (e.g. dispatchWithOneResume({...})): object-literal
  // arguments become maps so the carried fn receives Rhai values; every
  // other argument goes through the syntax normalizer so arrows, spreads,
  // and JS-only operators inside call args are converted, not carried raw.
  const noAwait = replaceInCode(t, /\bawait\s+/g, () => "");
  const callMatch = /^([A-Za-z_$][\w$]*)\s*\([\s\S]*\)$/.exec(noAwait);
  if (/\bawait\b|\basync\b/.test(t) && !callMatch) {
    gaps.push({
      kind: "control-flow",
      line,
      detail: `async/await in value (${t.slice(0, 60)}) — Rhai host calls already block`,
    });
  }
  if (callMatch && !/^(agent|parallel|phase|log|if|while|for)$/.test(callMatch[1])) {
    const open = noAwait.indexOf("(");
    const close = matchDelim(noAwait, open, "(", ")");
    if (close === noAwait.length - 1) {
      const args = splitTopLevel(noAwait.slice(open + 1, close)).map((a) => {
        const at = a.trim();
        if (!at) return at;
        if (at.startsWith("{")) {
          return normalizeExprSyntax(jsSchemaToRhai(at), gaps, line);
        }
        return normalizeExprSyntax(at, gaps, line);
      });
      gaps.push({
        kind: "control-flow",
        line,
        detail: `helper call ${callMatch[1]}() carried — verify the fn and its argument maps by hand`,
      });
      return `${callMatch[1]}(${args.join(", ")})`;
    }
  }
  return normalizeExprSyntax(rhaiValueExpr(noAwait), gaps, line);
}

// Build the Grok option map entries for one agent call: prompt is handled
// by the caller; this maps label/phase (translated expressions), agent_type
// (the original agentType, not a placeholder), capability_mode, model, and
// output_schema (only when it names a defined map — never `options`).
/**
 * @param {AgentCallFact} call
 * @param {WorkflowFacts} facts
 * @param {Gap[]} gaps
 * @returns {string[]}
 */
function grokOptsFor(call, facts, gaps) {
  /** @type {string[]} */
  const opts = [];
  if (call.labelSrc) {
    opts.push(`label: ${jsExprToRhai(call.labelSrc, gaps, call.line, false)}`);
  } else if (call.label) {
    opts.push(`label: ${rhaiString(call.label)}`);
  }
  if (call.agentType) {
    opts.push(`agent_type: ${rhaiString(call.agentType)}`);
  } else if (call.agentTypeExpr) {
    opts.push(`agent_type: ${rhaiValueExpr(call.agentTypeExpr)}`);
    gaps.push({
      kind: "agentType",
      line: call.line,
      detail: `dynamic agentType ${call.agentTypeExpr} — carried as agent_type; verify the value names a real subagent type`,
    });
  }
  const { mode: capability, verified } = resolveCapability(
    call.agentType,
    call.agentTypeExpr ?? null,
    facts,
  );
  opts.push(`capability_mode: ${rhaiString(capability)}`);
  if (!verified && call.agentType && !MUSE_AGENT_TYPES.has(call.agentType)) {
    gaps.push({
      kind: "capability_mode",
      line: call.line,
      detail: `${call.agentType} -> capability_mode "${capability}" (placeholder — confirm against the agent file's tools)`,
    });
  }
  if (call.phaseSrc) {
    opts.push(`phase: ${jsExprToRhai(call.phaseSrc, gaps, call.line, false)}`);
  } else if (call.phase) {
    opts.push(`phase: ${rhaiString(call.phase)}`);
  }
  if (call.model) {
    if (
      /^[A-Za-z_$][\w$]*$/.test(call.model) &&
      (facts.consts ?? []).some((c) => c.name === call.model)
    ) {
      opts.push(`model: ${call.model}`);
    } else {
      opts.push(`model: ${rhaiString(call.model)}`);
    }
  }
  if (call.schema) {
    const defined = (facts.schemas ?? []).some((s) => s.name === call.schema);
    opts.push(`output_schema: ${call.schema}`);
    gaps.push({
      kind: "output_schema",
      line: call.line,
      detail: defined
        ? `${call.schema}: defined above as a Grok map — Grok validates output_schema host-side`
        : `${call.schema}: not defined in the source — define it as a Grok map #{ "type": ... } by hand`,
    });
  } else if (call.schemaKind === "inline" && call.schemaExpr) {
    opts.push(`output_schema: ${jsSchemaToRhai(call.schemaExpr)}`);
    gaps.push({
      kind: "output_schema",
      line: call.line,
      detail: "inline schema carried as a Grok map — confirm host-side validation",
    });
  } else if (call.schemaInline) {
    // Legacy inline flag without a carried literal (e.g. Muse facts).
    opts.push(`output_schema: #{ "type": "object" }`);
    gaps.push({
      kind: "output_schema",
      line: call.line,
      detail: "inline output_schema map was not carried — re-add the schema by hand",
    });
  } else if (call.schemaKind === "dynamic") {
    gaps.push({
      kind: "output_schema",
      line: call.line,
      detail: `${call.schemaExpr ?? "dynamic"}: dynamic schema — point output_schema at a defined map by hand (never the options object)`,
    });
  }
  if (call.dynamicOpts) {
    gaps.push({
      kind: "dynamic-options",
      line: call.line,
      detail: "options built dynamically — map agentType/schema onto the Grok option map by hand",
    });
  }
  if (call.spreadOpts) {
    gaps.push({
      kind: "dynamic-options",
      line: call.line,
      detail:
        "options use ...spread (conditional keys) — expand the spread onto the Grok option map by hand",
    });
  }
  return opts;
}

// Emit one agent() call with its source prompt carried as Rhai.
/**
 * @param {AgentCallFact} call
 * @param {WorkflowFacts} facts
 * @param {Gap[]} gaps
 * @param {string} varName
 * @returns {string[]}
 */
function emitAgentCall(call, facts, gaps, varName) {
  const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
  if (call.promptSrc.includes("${")) {
    gaps.push({
      kind: "prompt",
      line: call.line,
      detail:
        "prompt interpolation carried with Rhai + and json_encode — verify untrusted values are fenced",
    });
  }
  const opts = grokOptsFor(call, facts, gaps);
  const tag = call.agentType
    ? `, agentType "${call.agentType}"`
    : call.agentTypeExpr
      ? `, agentType ${call.agentTypeExpr}`
      : "";
  return [
    `// source line ${call.line}${tag}`,
    `let ${varName} = agent(`,
    `    ${prompt},`,
    `    #{ ${opts.join(", ")} },`,
    ");",
    "",
  ];
}

// Emit one parallel() site as a prebuilt job list plus barrier. Calls
// inside the site become job maps (never top-level agent() dispatches).
/**
 * @param {ParallelFact} parallel
 * @param {WorkflowFacts} facts
 * @param {Gap[]} gaps
 * @param {number} seq
 * @param {string} [resVarOverride]
 * @returns {string[]}
 */
function emitParallelSite(parallel, facts, gaps, seq, resVarOverride) {
  const inner = (facts.calls ?? []).filter(
    (c) => (c.start ?? -1) > parallel.openIdx && (c.start ?? -1) < parallel.closeIdx,
  );
  gaps.push({
    kind: "parallel",
    line: parallel.line,
    detail: `${facts.parallelSites} parallel() site(s) — Grok parallel takes a prebuilt job list [#{ prompt, label, ... }]; rebuilt below, do not port JS thunks`,
  });
  /** @type {string[]} */
  const out = [];
  out.push(`// source line ${parallel.line}: parallel fan-out with ${inner.length} job(s)`);
  const jobsVar = `jobs${seq > 1 ? seq : ""}`;
  const resVar = resVarOverride ?? `panel${seq > 1 ? seq : ""}`;
  out.push(`let ${jobsVar} = [];`);
  if (!inner.length) {
    gaps.push({
      kind: "parallel",
      line: parallel.line,
      detail: `parallel() with no static agent() thunks (${parallel.inner.slice(0, 60)}) — build the job list by hand`,
    });
    out.push(`// TODO: build the job list for this parallel() site by hand, then:`);
    out.push(`// let ${resVar} = parallel(${jobsVar});`);
    out.push("");
    return out;
  }
  const mapMatch = /([A-Za-z_$][\w$.]*)\s*\.map\s*\(/.exec(parallel.inner);
  const itemMatch = /\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*=>/.exec(parallel.inner);
  if (mapMatch) {
    // parallel(xs.map((item) => () => agent(...))): build the job list with
    // a Rhai for loop so the item variable stays defined.
    const arrExpr = mapMatch[1];
    const itemVar = itemMatch ? itemMatch[1] : "item";
    gaps.push({
      kind: "parallel",
      line: parallel.line,
      detail: `parallel() built via .map() over ${arrExpr} — carried as a for loop; wire dynamic options by hand`,
    });
    out.push(`for ${itemVar} in ${arrExpr} {`);
    for (const call of inner) {
      const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
      if (call.promptSrc.includes("${")) {
        gaps.push({
          kind: "prompt",
          line: call.line,
          detail:
            "prompt interpolation carried with Rhai + and json_encode — verify untrusted values are fenced",
        });
      }
      const opts = grokOptsFor(call, facts, gaps);
      out.push(
        `    ${jobsVar}.push(#{ prompt: ${prompt}${opts.length ? `, ${opts.join(", ")}` : ""} });`,
      );
    }
    out.push("}");
    out.push(`let ${resVar} = parallel(${jobsVar});`);
    out.push("");
    return out;
  }
  for (const call of inner) {
    const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
    if (call.promptSrc.includes("${")) {
      gaps.push({
        kind: "prompt",
        line: call.line,
        detail:
          "prompt interpolation carried with Rhai + and json_encode — verify untrusted values are fenced",
      });
    }
    const opts = grokOptsFor(call, facts, gaps);
    out.push(
      `${jobsVar}.push(#{ prompt: ${prompt}${opts.length ? `, ${opts.join(", ")}` : ""} });`,
    );
  }
  out.push(`let ${resVar} = parallel(${jobsVar});`);
  out.push("");
  return out;
}

// Light JS -> Rhai fixes for carried statement text: drop await/async,
// const -> let, strict equality, null -> ().
/**
 * @param {string} text
 * @returns {string}
 */
function lightFixes(text) {
  return text
    .replace(/\bawait\s+/g, "")
    .replace(/\basync\s+function\b/g, "function")
    .replace(/(^|[^\w$])const\s+/g, "$1let ")
    .replace(/===/g, "==")
    .replace(/!==/g, "!=");
}

// Translate a helper body or loop body: rewrite nested agent()/parallel()
// sites to Rhai forms, then run the carried statements through the syntax
// normalizer (arrows, ?./??, spreads, C-style loops, try/catch).
/**
 * @param {string} bodyJs
 * @param {number} bodyStart
 * @param {WorkflowFacts} facts
 * @param {Gap[]} gaps
 * @param {{ n: number }} [ctr]
 * @returns {string}
 */
function translateBlock(bodyJs, bodyStart, facts, gaps, ctr) {
  let text = bodyJs;
  // Nested parallels first (statement level): inline job-map arrays when
  // the site is an array literal of thunks; otherwise keep the call with
  // a gap.
  const nestedParallels = (facts.parallels ?? []).filter(
    (p) => p.start >= bodyStart && p.start < bodyStart + bodyJs.length,
  );
  nestedParallels.sort((a, b) => b.start - a.start);
  for (const p of nestedParallels) {
    const rel = p.start - bodyStart;
    const innerCalls = (facts.calls ?? []).filter(
      (c) => (c.start ?? -1) > p.openIdx && (c.start ?? -1) < p.closeIdx,
    );
    const arrMatch = /^\s*\[([\s\S]*)\]\s*$/.exec(p.inner);
    if (arrMatch && innerCalls.length) {
      const maps = innerCalls.map((call) => {
        const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
        const opts = grokOptsFor(call, facts, gaps);
        return `#{ prompt: ${prompt}${opts.length ? `, ${opts.join(", ")}` : ""} }`;
      });
      gaps.push({
        kind: "parallel",
        line: p.line,
        detail: "nested parallel() rebuilt as an inline job-map array — verify labels/schemas",
      });
      text = `${text.slice(0, rel)}parallel([${maps.join(", ")}])${text.slice(rel + (p.closeIdx - p.start + 1))}`;
    } else {
      // parallel(ARR.map((ITEM) => () => agent(...))): hoist a for loop
      // that builds the job list so ITEM stays defined, then barrier on it.
      const mapMatch = /([A-Za-z_$][\w$.[\]]*)\s*\.map\s*\(/.exec(p.inner);
      const itemMatch = /\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*=>/.exec(p.inner);
      if (mapMatch && innerCalls.length) {
        const arrExpr = mapMatch[1];
        const itemVar = itemMatch ? itemMatch[1] : "item";
        const jobsVar = `wf_jobs_${p.line}`;
        const ordered = [...innerCalls].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
        const stmtStart = text.lastIndexOf("\n", rel - 1) + 1;
        const indent = (/^(\s*)/.exec(text.slice(stmtStart)) ?? ["", ""])[1];
        const pushLines = ordered.map((call) => {
          const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
          const opts = grokOptsFor(call, facts, gaps);
          return `${indent}    ${jobsVar}.push(#{ prompt: ${prompt}${opts.length ? `, ${opts.join(", ")}` : ""} });`;
        });
        gaps.push({
          kind: "parallel",
          line: p.line,
          detail: `nested parallel() built via .map() over ${arrExpr} — carried as a for loop; wire dynamic options by hand`,
        });
        const loop = `let ${jobsVar} = [];\n${indent}for ${itemVar} in ${arrExpr} {\n${pushLines.join("\n")}\n${indent}}\n${indent}`;
        text = `${text.slice(0, stmtStart)}${loop}${text.slice(stmtStart, rel)}parallel(${jobsVar})${text.slice(rel + (p.closeIdx - p.start + 1))}`;
      } else {
        gaps.push({
          kind: "parallel",
          line: p.line,
          detail:
            "nested parallel() is not an array literal of thunks — rebuild the job list by hand",
        });
      }
    }
  }
  // Nested agent calls (expression level).
  const nestedCalls = (facts.calls ?? []).filter(
    (c) =>
      (c.start ?? -1) >= bodyStart &&
      (c.start ?? -1) < bodyStart + bodyJs.length &&
      !nestedParallels.some((p) => (c.start ?? -1) > p.openIdx && (c.start ?? -1) < p.closeIdx),
  );
  nestedCalls.sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  for (const call of nestedCalls) {
    const rel = (call.start ?? 0) - bodyStart;
    const relEnd = (call.closeIdx ?? 0) - bodyStart;
    if (rel < 0 || relEnd > text.length) continue;
    const prompt = jsExprToRhai(call.promptSrc, gaps, call.line);
    if (call.promptSrc.includes("${")) {
      gaps.push({
        kind: "prompt",
        line: call.line,
        detail:
          "prompt interpolation carried with Rhai + and json_encode — verify untrusted values are fenced",
      });
    }
    const opts = grokOptsFor(call, facts, gaps);
    text = `${text.slice(0, rel)}agent(${prompt}, #{ ${opts.join(", ")} })${text.slice(relEnd + 1)}`;
  }
  // Statement-level normalization after all position math: the spliced
  // agent()/parallel() forms are already Rhai, and the normalizer leaves
  // them alone while converting the surrounding JS syntax.
  return normalizeStatements(lightFixes(text), gaps, ctr ?? { n: 0 });
}

// Translate a collected loop body to Rhai lines. The body's global offset
// is derived from the loop's source range so nested call positions line up.
/**
 * @param {LoopFact} loop
 * @param {WorkflowFacts} facts
 * @param {Gap[]} gaps
 * @param {{ n: number }} [ctr]
 * @returns {string[]}
 */
function translateLoopBody(loop, facts, gaps, ctr) {
  // loop.body is source.slice(bOpen + 1, bClose) and loop.end is bClose,
  // so the body's global start is end - body.length.
  const bodyStart = loop.end - loop.body.length;
  const start = bodyStart >= loop.start ? bodyStart : loop.start;
  const translated = translateBlock(loop.body, start, facts, gaps, ctr);
  return translated.split("\n");
}

// Convert a C-style or for-of header to a Rhai loop opener. Returns null
// when the header needs hand translation.
/**
 * @param {string} header
 * @param {Gap[]} gaps
 * @param {number} line
 * @returns {{ open: string, incr: string | null } | null}
 */
function convertForHeader(header, gaps, line) {
  const t = header.trim();
  // for (let i = 0; i < N; i++) / i += 1 / i++ forms
  const cStyle =
    /^(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);\s*\1\s*(<=|<)\s*([^;]+);\s*\1\s*(\+\+|\+=\s*1)\s*$/.exec(
      t,
    );
  if (cStyle) {
    const [, v, init, op, bound] = cStyle;
    gaps.push({
      kind: "control-flow",
      line,
      detail: `C-style for loop carried as Rhai while ${v} — verify bounds by hand`,
    });
    // The regex only matches ++ and += 1 shapes, so the Rhai increment is
    // always `v += 1` (the capture group excludes the variable itself).
    const incrOut = `${v} += 1`;
    return {
      open: `let ${v} = ${normalizeExprSyntax(init.trim(), gaps, line)};\nwhile ${v} ${op} ${normalizeExprSyntax(bound.trim(), gaps, line)} {`,
      incr: `${normalizeExprSyntax(incrOut, gaps, line)};`,
    };
  }
  // for (const x of arr) / for (let x of arr)
  const forOf = /^(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/.exec(t);
  if (forOf) {
    return {
      open: `for ${forOf[1]} in ${normalizeExprSyntax(forOf[2].trim(), gaps, line)} {`,
      incr: null,
    };
  }
  gaps.push({
    kind: "control-flow",
    line,
    detail: `for header (${t.slice(0, 80)}) has no mechanical Rhai form — rewrite by hand`,
  });
  return null;
}

// Translate a top-level return expression to the complete() argument:
// object literals become maps (shorthand { report } -> #{ report: report }),
// other expressions are carried with light fixes.
/**
 * @param {string} src
 * @param {Gap[]} gaps
 * @returns {string}
 */
function translateReturn(src, gaps) {
  const t = src.trim().replace(/;$/, "");
  if (t.startsWith("{") && t.endsWith("}")) {
    const inner = t.slice(1, -1);
    const parts = splitTopLevel(inner);
    const mapped = parts.map((p) => {
      const pt = p.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(pt)) return `${pt}: ${pt}`;
      if (/^\.\.\./.test(pt)) {
        gaps.push({
          kind: "complete",
          line: 1,
          detail: `spread in return (${pt.slice(0, 40)}) — expand by hand`,
        });
        return pt;
      }
      return pt;
    });
    return jsSchemaToRhai(`{${mapped.join(", ")}}`);
  }
  if (!t) return '#{ status: "converted" }';
  return normalizeExprSyntax(lightFixes(t), gaps, 1);
}

/**
 * Lower canonical call-site facts to a Grok Build (Rhai) skeleton.
 * @param {WorkflowFacts} facts
 * @param {{ inputName?: string, sourceName?: string, agentsDir?: string | null }} [options]
 * @returns {{ code: string, gaps: Gap[] }}
 */
export function emitGrokFromFacts(
  facts,
  { inputName = "<input>", sourceName = "Claude Workflow", agentsDir = null } = {},
) {
  if (agentsDir && facts.agentsDir == null) facts.agentsDir = agentsDir;
  /** @type {Gap[]} */
  const gaps = [];
  /** @type {string[]} */
  const out = [];
  /** @type {{ n: number }} */
  const stmtCtr = { n: 0 };
  const structural =
    (facts.helpers ?? []).length > 0 ||
    (facts.loops ?? []).length > 0 ||
    (facts.schemas ?? []).length > 0 ||
    (facts.argsReads ?? []).length > 0;
  out.push(`// Grok Build workflow derived from ${sourceName} ${inputName} via the`);
  out.push("// canonical agent-request form. Helpers, loops, and args reads are");
  out.push("// carried structurally; translate flagged prompts and gaps by hand.");
  out.push("");

  if (facts.meta) {
    const m = facts.meta;
    out.push("let meta = #{");
    if (m.name) out.push(`    name: ${rhaiString(m.name)},`);
    if (m.description) out.push(`    description: ${rhaiString(m.description)},`);
    if (m.whenToUse) out.push(`    when_to_use: ${rhaiString(m.whenToUse)},`);
    const phases = m.phaseDetails?.length
      ? m.phaseDetails
      : m.phases.map((t) => ({ title: t, detail: null }));
    if (phases.length) {
      out.push("    phases: [");
      for (const p of phases) {
        if (p.detail)
          out.push(`        #{ title: ${rhaiString(p.title)}, detail: ${rhaiString(p.detail)} },`);
        else out.push(`        #{ title: ${rhaiString(p.title)} },`);
      }
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

  // Schema consts become defined Rhai maps so output_schema references
  // resolve under validate_only.
  for (const s of facts.schemas ?? []) {
    out.push(`// source schema ${s.name} (line ${s.line})`);
    out.push(`let ${s.name} = ${jsSchemaToRhai(s.literal)};`);
    out.push("");
  }

  // Helpers become Rhai fn blocks with their dispatches translated.
  const helperRanges = (facts.helpers ?? []).map((h) => ({ start: h.start, end: h.end }));
  for (const h of facts.helpers ?? []) {
    const inner = (() => {
      const body = h.body ?? "";
      const bOpen = body.indexOf("{");
      const bClose = body.lastIndexOf("}");
      const innerJs = bOpen >= 0 && bClose > bOpen ? body.slice(bOpen + 1, bClose) : body;
      // bodyStart for position math: global offset of innerJs start.
      const innerStart = h.start + (h.body ? h.body.indexOf(innerJs) : 0);
      return translateBlock(
        innerJs,
        innerStart < h.start ? h.start : innerStart,
        facts,
        gaps,
        stmtCtr,
      );
    })();
    gaps.push({
      kind: "control-flow",
      line: h.line,
      detail: `helper ${h.name}() carried as Rhai fn — verify control flow and resume semantics by hand`,
    });
    out.push(`// helper ${h.name} (source line ${h.line})`);
    out.push(`fn ${h.name}(${h.params}) {`);
    for (const ln of inner.split("\n")) out.push(ln ? `    ${ln}` : "");
    out.push("}");
    out.push("");
  }

  // Carried const bindings (spec arrays, model pins, topic defaults) so
  // prompts and job builders that reference them stay defined. Consts whose
  // initializer dispatches (const x = await agent/parallel(...)) are not
  // emitted here — the flow below binds the same name to the Rhai call.
  /** @param {string} expr @returns {boolean} */
  const isDispatchConst = (expr) =>
    /(?<![\w$.])agent\s*\(|(?<![\w$.])parallel\s*\(/.test(codeOnly(expr));
  /** @param {string} expr @returns {{ params: string, body: string } | null} */
  const asArrowFn = (expr) => {
    const t = expr.trim();
    let m =
      /^\(([^)]*)\)\s*=>\s*([\s\S]+)$/.exec(t) ?? /^([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(t);
    if (!m) return null;
    return { params: m[1].trim(), body: m[2].trim() };
  };
  const emittedConsts = new Set();
  for (const c of facts.consts ?? []) {
    if (
      /^[A-Z_][A-Z0-9_]*SCHEMA/.test(c.name) ||
      (/^[A-Z_]+$/.test(c.name) && /SCHEMA/.test(c.name))
    )
      continue;
    if (isDispatchConst(c.expr)) continue;
    const arrow = asArrowFn(c.expr);
    if (arrow) {
      let fnBody = arrow.body;
      if (fnBody.startsWith("(") && fnBody.endsWith(")")) fnBody = fnBody.slice(1, -1).trim();
      gaps.push({
        kind: "control-flow",
        line: c.line,
        detail: `arrow function ${c.name}() carried as Rhai fn — verify by hand`,
      });
      out.push(`// source const ${c.name} (line ${c.line})`);
      out.push(
        `fn ${c.name}(${arrow.params}) { ${fnBody.startsWith("{") ? normalizeExprSyntax(jsSchemaToRhai(fnBody), gaps, c.line) : jsValueToRhai(fnBody, gaps, c.line)} }`,
      );
      out.push("");
      emittedConsts.add(c.name);
      continue;
    }
    out.push(`// source const ${c.name} (line ${c.line})`);
    out.push(`let ${c.name} = ${jsValueToRhai(c.expr, gaps, c.line)};`);
    out.push("");
    emittedConsts.add(c.name);
  }
  // Result bindings: `const x = await agent/parallel(...)` keeps the name x
  // on the Rhai call so later references (return {...}) stay defined.
  /** @param {number} pos @returns {string | null} */
  const bindingFor = (pos) => {
    for (const c of facts.consts ?? []) {
      if (pos >= c.start && pos <= c.end) return c.name;
    }
    return null;
  };

  // Documented args reads (maxRounds and friends): `args.x ?? d` becomes
  // the explicit Rhai != () form. Names already bound above are skipped.
  for (const a of facts.argsReads ?? []) {
    if (emittedConsts.has(a.name)) continue;
    const fallback = a.defaultSrc ? jsValueToRhai(a.defaultSrc, gaps, a.line) : "()";
    out.push(
      `let ${a.name} = if args != () && args.${a.name} != () { args.${a.name} } else { ${fallback} };`,
    );
    emittedConsts.add(a.name);
  }
  if ((facts.argsReads ?? []).length) out.push("");

  // Top-level flow in source order: loops keep the round structure,
  // parallels become job lists, lone agent() calls stay in place.
  const loopRanges = (facts.loops ?? []).map((l) => ({ start: l.start, end: l.end }));
  /** @param {number} pos @param {{ start: number, end: number }[]} ranges @returns {boolean} */
  const inRanges = (pos, ranges) => ranges.some((r) => pos >= r.start && pos <= r.end);
  /** @type {{ pos: number, kind: string, ref: any }[]} */
  const events = [];
  for (const p of facts.phaseCalls ?? []) {
    if (inRanges(p.start, helperRanges) || inRanges(p.start, loopRanges)) continue;
    events.push({ pos: p.start, kind: "phase", ref: p });
  }
  for (const p of facts.logCalls ?? []) {
    if (inRanges(p.start, helperRanges) || inRanges(p.start, loopRanges)) continue;
    events.push({ pos: p.start, kind: "log", ref: p });
  }
  for (const l of facts.loops ?? []) {
    if (inRanges(l.start, helperRanges)) continue;
    // A loop nested inside another loop is emitted via the outer loop's
    // translated body — emitting it as its own event duplicates the region.
    if ((facts.loops ?? []).some((o) => o !== l && l.start >= o.start && l.start <= o.end))
      continue;
    events.push({ pos: l.start, kind: "loop", ref: l });
  }
  for (const p of facts.parallels ?? []) {
    if (inRanges(p.start, helperRanges) || inRanges(p.start, loopRanges)) continue;
    events.push({ pos: p.start, kind: "parallel", ref: p });
  }
  for (const c of facts.calls ?? []) {
    const pos = c.start ?? -1;
    if (pos < 0 || inRanges(pos, helperRanges) || inRanges(pos, loopRanges)) continue;
    if (c.inParallel) continue; // emitted inside its parallel job list
    events.push({ pos, kind: "agent", ref: c });
  }
  events.sort((a, b) => a.pos - b.pos);

  let seq = 0;
  let parSeq = 0;
  const hasStructuralFlow = structural && events.length > 0;
  if (!hasStructuralFlow) {
    // Fallback skeleton for sources without recoverable structure
    // (e.g. Muse facts with no helper/loop/schema detail).
    for (const call of facts.calls) {
      if (call.inParallel) continue;
      seq += 1;
      out.push(...emitAgentCall(call, facts, gaps, `r${seq}`));
    }
    for (const p of facts.parallels ?? []) {
      parSeq += 1;
      out.push(...emitParallelSite(p, facts, gaps, parSeq));
    }
    // Calls that only exist inside parallels were already emitted as jobs;
    // calls inside helpers have no helper body to carry them here.
  } else {
    for (const ev of events) {
      if (ev.kind === "phase") {
        /** @type {PhaseCallFact} */
        const p = ev.ref;
        out.push(`phase(${jsExprToRhai(p.expr, gaps, p.line, false)});`);
      } else if (ev.kind === "log") {
        /** @type {PhaseCallFact} */
        const p = ev.ref;
        out.push(`log(${jsExprToRhai(p.expr, gaps, p.line, false)});`);
      } else if (ev.kind === "loop") {
        /** @type {LoopFact} */
        const l = ev.ref;
        gaps.push({
          kind: "control-flow",
          line: l.line,
          detail: `${l.kind} loop carried as Rhai — verify bounds and resume determinism by hand`,
        });
        if (l.kind === "while") {
          out.push(`while ${normalizeExprSyntax(lightFixes(l.header), gaps, l.line)} {`);
          out.push(
            ...translateLoopBody(l, facts, gaps, stmtCtr).map((ln) => (ln ? `    ${ln}` : "")),
          );
          out.push("}");
          out.push("");
        } else {
          const converted = convertForHeader(l.header, gaps, l.line);
          if (converted) {
            out.push(converted.open);
            out.push(
              ...translateLoopBody(l, facts, gaps, stmtCtr).map((ln) => (ln ? `    ${ln}` : "")),
            );
            if (converted.incr) out.push(`    ${converted.incr}`);
            out.push("}");
            out.push("");
          } else {
            out.push(`// TODO: translate ${l.kind} loop header (${l.header.slice(0, 80)}) by hand`);
            out.push(
              ...translateLoopBody(l, facts, gaps, stmtCtr).map((ln) => (ln ? `    ${ln}` : "")),
            );
            out.push("");
          }
        }
      } else if (ev.kind === "parallel") {
        parSeq += 1;
        const bound = bindingFor(ev.ref.start);
        out.push(...emitParallelSite(ev.ref, facts, gaps, parSeq, bound ?? undefined));
        if (bound) emittedConsts.add(bound);
      } else if (ev.kind === "agent") {
        seq += 1;
        const bound = bindingFor(ev.ref.start ?? -1);
        out.push(...emitAgentCall(ev.ref, facts, gaps, bound ?? `r${seq}`));
        if (bound) emittedConsts.add(bound);
      }
    }
  }

  if (facts.parallelSites > 0 && !gaps.some((g) => g.kind === "parallel")) {
    gaps.push({
      kind: "parallel",
      line: 1,
      detail: `${facts.parallelSites} parallel() site(s) — rebuild the job list as parallel([requests])`,
    });
    out.push("// TODO: rebuild each parallel() fan-out as parallel([requests]), then:");
  }

  if (!facts.hasReturn) {
    gaps.push({
      kind: "complete",
      line: 1,
      detail:
        "no top-level return — end the Rhai script with complete(#{ ... }) carrying the result value",
    });
  }
  if (facts.returnSrc) {
    const ret = translateReturn(facts.returnSrc, gaps);
    out.push(`complete(${ret});`);
  } else {
    out.push("// TODO: map the workflow result value (Muse return / Claude return) here.");
    out.push('complete(#{ status: "converted" });');
  }
  out.push("");

  return { code: out.join("\n"), gaps };
}

/**
 * @param {string} source
 * @param {{ inputName?: string, agentsDir?: string | null }} [options]
 * @returns {{ code: string, facts: WorkflowFacts, gaps: Gap[] }}
 */
export function emitGrok(source, { inputName = "<input>", agentsDir = null } = {}) {
  const facts = extractFacts(source);
  const { code, gaps } = emitGrokFromFacts(facts, { inputName, agentsDir });
  return { code, facts, gaps };
}

/**
 * Read a double-quoted Rhai string field from an option map body.
 * @param {string} body
 * @param {string} name
 * @returns {string | null} unescaped value
 */
function rhaiField(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

// Extract canonical facts (the agent request shape) from Grok source.
// Prompts are normalized to JS double-quoted string literals when they
// parse; anything else passes through and is flagged at emit time.
/**
 * @param {string} source
 * @returns {WorkflowFacts}
 */
export function extractGrokFacts(source) {
  /** @type {WorkflowFacts} */
  const facts = {
    meta: null,
    calls: [],
    parallelSites: 0,
    hasReturn: /complete\s*\(#/.test(codeOnly(source)),
  };
  const masked = codeOnly(source);
  const metaMatch = source.match(/let\s+meta\s*=\s*#{/);
  if (metaMatch) {
    const openIdx = source.indexOf("{", metaMatch.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    const block = closeIdx > 0 ? source.slice(openIdx, closeIdx + 1) : "";
    const titles = [...block.matchAll(/title\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    });
    facts.meta = {
      name: rhaiField(block, "name"),
      description: rhaiField(block, "description"),
      whenToUse: rhaiField(block, "when_to_use"),
      phases: titles,
    };
  }
  const agentRe = /(?<![\w$.#])agent\s*\(/g;
  let am;
  /** @type {{ start: number, openIdx: number, closeIdx: number }[]} */
  const grokSites = [];
  while ((am = agentRe.exec(source)) !== null) {
    if (masked[am.index] === " ") continue;
    const openIdx = source.indexOf("(", am.index);
    const closeIdx = matchDelim(source, openIdx, "(", ")");
    if (closeIdx < 0) continue;
    grokSites.push({ start: am.index, openIdx, closeIdx });
  }
  /** @type {{ start: number, openIdx: number, closeIdx: number }[]} */
  const grokParallels = [];
  {
    const pre = /(?<![\w$.#])parallel\s*\(/g;
    let pm;
    while ((pm = pre.exec(source)) !== null) {
      if (masked[pm.index] === " ") continue;
      const openIdx = source.indexOf("(", pm.index);
      const closeIdx = matchDelim(source, openIdx, "(", ")");
      if (closeIdx < 0) continue;
      grokParallels.push({ start: pm.index, openIdx, closeIdx });
    }
  }
  facts.parallelSites = grokParallels.length;
  for (const site of grokSites) {
    const openIdx = site.openIdx;
    const closeIdx = site.closeIdx;
    const args = splitTopLevel(source.slice(openIdx + 1, closeIdx));
    const rawPrompt = (args[0] ?? "").trim();
    let promptSrc = rawPrompt;
    if (/^".*"$/.test(rawPrompt)) {
      try {
        promptSrc = JSON.stringify(JSON.parse(rawPrompt));
      } catch {
        promptSrc = rawPrompt;
      }
    }
    const opts = args[1] && args[1].trimStart().startsWith("#{") ? args[1] : null;
    let body = "";
    if (opts) {
      const oOpen = opts.indexOf("{");
      const oClose = matchDelim(opts, oOpen, "{", "}");
      body = oClose > 0 ? opts.slice(oOpen, oClose + 1) : "";
    }
    const schemaHit = body.match(/output_schema\s*:\s*([A-Za-z_$][\w$]*)/);
    facts.calls.push({
      line: lineOf(source, site.start),
      start: site.start,
      openIdx: site.openIdx,
      closeIdx: site.closeIdx,
      promptSrc,
      agentType: null,
      label: rhaiField(body, "label"),
      phase: rhaiField(body, "phase"),
      model: rhaiField(body, "model"),
      schema: schemaHit ? schemaHit[1] : null,
      schemaInline: schemaHit ? undefined : /output_schema\s*:/.test(body) || undefined,
      capability: rhaiField(body, "capability_mode"),
      dynamicOpts: opts == null && args[1] != null ? true : undefined,
      inParallel:
        grokParallels.some((p) => site.start > p.openIdx && site.start < p.closeIdx) || undefined,
    });
  }
  return facts;
}
