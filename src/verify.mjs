// Verification checks for all three workflow dialects (claude, muse, grok).
//
// Validates both hand-written inputs and converter outputs: mechanical
// issues that will fail a runner preflight (or silently change meaning)
// are errors; style risks and review reminders are warnings. Two output
// modes share one result shape — `formatAgent` is a compact line protocol
// for agents, `formatHuman` adds source context, hints, and next steps.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MUSE_AGENT_TYPES,
  SCHEMA_KEYWORDS_BAD,
  codeOnly,
  collectAgentTypes,
  collectSchemaConsts,
  lineOf,
  matchDelim,
  splitRequestObject,
  splitTopLevel,
} from "./convert.mjs";

/** @typedef {import("./route.mjs").Dialect} Dialect */

/**
 * @typedef {object} VerifyIssue
 * @property {"error" | "warning"} severity
 * @property {string} code
 * @property {number} line
 * @property {string} message
 * @property {string} [hint]
 *
 * @typedef {object} VerifyResult
 * @property {Dialect} dialect
 * @property {boolean} ok
 * @property {VerifyIssue[]} errors
 * @property {VerifyIssue[]} warnings
 * @property {{ agentCalls: number, parallelSites: number }} stats
 *
 * @typedef {object} CallSite
 * @property {number} start
 * @property {number} openIdx
 * @property {number} closeIdx
 * @property {number} line
 */

/** Converter-output fingerprint: converter shims mean choke-routed calls. @type {RegExp} */
const CONVERTER_FINGERPRINT = /wfport:begin-helpers|Converted from .* by workflow-port/;

/** Option keys a Grok agent() map accepts. @type {Set<string>} */
const GROK_OPTION_KEYS = new Set([
  "label",
  "agent_type",
  "capability_mode",
  "output_schema",
  "phase",
  "model",
]);

/** capability_mode values seen in the wild. @type {Set<string>} */
const GROK_CAPABILITIES = new Set(["all", "read-only"]);

/** Next-step guidance per issue code for human output. @type {Record<string, string>} */
const NEXT_STEPS = {
  E_NO_META: "Add the dialect's meta block (see the hint on the error above).",
  E_META_FIELD: "Fill in the missing meta field so the workflow can be listed and launched.",
  E_WRAPPER: "Unwrap to the V1 body shape: drop the wrapper, use bare agent()/parallel() calls.",
  E_EXPORT: "Delete the export; the runner wraps the script as a function body itself.",
  E_HOST_CALLS: "Use the bare globals (agent, parallel, phase, log) — there is no host object.",
  E_AGENT_TYPE:
    "Point the call at a built-in (general-purpose, workflow-subagent) or inline the prompt by hand.",
  E_SCHEMA: "Rewrite the schema with only type/enum/required/properties/items under 4 KiB.",
  E_REQUEST_NO_INPUT: "Give every agent request object an input: field carrying the prompt.",
  E_PARALLEL_SHAPE: "Rebuild the fan-out in the target dialect's job shape (see the hint above).",
  E_UNKNOWN_OPTION: "Fix the option name — unknown keys are silently ignored at runtime.",
  E_NO_COMPLETE: "End the run with complete(...) carrying the result value.",
  E_JS_SYNTAX: "Rewrite the flagged JS syntax in Rhai form; there is no mechanical mapping.",
  W_AGENT_FILE: "Create the missing .claude/agents/<name>.md file or retarget the call.",
  W_PARALLEL_THUNK: "Normalize thunk entries to parallel([{ input, ... }]) request objects.",
  W_JOB_LIST: "Read the job-list construction and confirm every entry is a #{ prompt, ... } map.",
  W_MODEL_PIN: "Delete the model pin or confirm the wrapper re-applies it.",
  W_FANOUT: "Split the sweep across runs so one failure does not sink the batch.",
  E_IMPORT: "Inline the imported code — Workflow scripts must be self-contained.",
  E_BANNED: "Remove the nondeterministic call; replay must see the same value every run.",
  E_NO_AGENT: "Add at least one agent() call — a workflow with no work does nothing.",
  E_NO_RETURN: "End the run with a top-level return carrying the result.",
  E_SYNTAX: "Fix the unbalanced delimiters so the file parses.",
};

/**
 * The raw text of source line n (1-based), trimmed of trailing newline.
 * @param {string} source
 * @param {number} n
 * @returns {string}
 */
function sourceLine(source, n) {
  const lines = source.split("\n");
  return (lines[n - 1] ?? "").trim();
}

/**
 * Collect code-position call sites for one call name.
 * @param {string} source
 * @param {string} masked
 * @param {string} name
 * @returns {{ sites: CallSite[], unclosed: number[] }}
 */
function collectCalls(source, masked, name) {
  /** @type {CallSite[]} */
  const sites = [];
  /** @type {number[]} */
  const unclosed = [];
  const re = new RegExp(`(?<![\\w$.#])${name}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(source)) !== null) {
    if (masked[m.index] === " ") continue;
    const openIdx = source.indexOf("(", m.index);
    const closeIdx = matchDelim(source, openIdx, "(", ")");
    if (closeIdx < 0) {
      unclosed.push(lineOf(source, m.index));
      continue;
    }
    sites.push({ start: m.index, openIdx, closeIdx, line: lineOf(source, m.index) });
  }
  return { sites, unclosed };
}

/**
 * Shared checks across the JS dialects: imports, banned nondeterminism,
 * fan-out size, and unbalanced call delimiters.
 * @param {string} source
 * @param {string} masked
 * @param {CallSite[]} agentSites
 * @param {number[]} unclosed
 * @param {VerifyIssue[]} errors
 * @param {VerifyIssue[]} warnings
 * @param {boolean} [requireReturn]
 * @returns {void}
 */
function checkShared(source, masked, agentSites, unclosed, errors, warnings, requireReturn = true) {
  for (const line of unclosed) {
    errors.push({
      severity: "error",
      code: "E_SYNTAX",
      line,
      message: "unbalanced parentheses in agent() call",
      hint: "Close the argument list — the file cannot run until it parses.",
    });
  }
  if (/^\s*import\s/m.test(masked) || /require\s*\(/.test(masked)) {
    errors.push({
      severity: "error",
      code: "E_IMPORT",
      line: 1,
      message: "imports/requires are not allowed in Workflow scripts",
      hint: "Inline the imported code; scripts must be self-contained.",
    });
  }
  for (const pat of ["Date.now", "Math.random", "new Date("]) {
    let from = 0;
    while (true) {
      const idx = masked.indexOf(pat, from);
      if (idx < 0) break;
      const before = idx > 0 ? masked[idx - 1] : "";
      if (/[\w$]/.test(before ?? "")) {
        from = idx + 1;
        continue;
      }
      errors.push({
        severity: "error",
        code: "E_BANNED",
        line: lineOf(source, idx),
        message: `${pat} throws under deterministic replay`,
        hint: "Compute the value outside the run and pass it in via args.",
      });
      from = idx + 1;
    }
  }
  if (agentSites.length === 0) {
    errors.push({
      severity: "error",
      code: "E_NO_AGENT",
      line: 1,
      message: "no agent() call sites found",
      hint: "Add at least one agent() call carrying the work to do.",
    });
  } else if (agentSites.length > 15) {
    warnings.push({
      severity: "warning",
      code: "W_FANOUT",
      line: 1,
      message: `${agentSites.length} agent() call sites exceed the ~15-child guideline`,
      hint: "Chunk rounds across runs so one failure does not sink the batch.",
    });
  }
  if (requireReturn && !/^\s*return\b/m.test(masked)) {
    errors.push({
      severity: "error",
      code: "E_NO_RETURN",
      line: 1,
      message: "no top-level return carrying the result",
      hint: "End the run with return { status, ref, text }.",
    });
  }
}

/**
 * Warn for custom agentType files that do not exist on disk.
 * @param {string} source
 * @param {string | null} agentsDir
 * @param {VerifyIssue[]} warnings
 * @returns {void}
 */
function checkAgentFiles(source, agentsDir, warnings) {
  if (!agentsDir) return;
  const found = collectAgentTypes(source);
  const seen = new Set();
  for (const l of found.literals) {
    if (seen.has(l.value)) continue;
    seen.add(l.value);
    if (!existsSync(join(agentsDir, `${l.value}.md`))) {
      warnings.push({
        severity: "warning",
        code: "W_AGENT_FILE",
        line: l.line,
        message: `agent file .claude/agents/${l.value}.md not found`,
        hint: `Create .claude/agents/${l.value}.md or point the call at an existing agent file.`,
      });
    }
  }
}

/**
 * Check one Muse inline-schema object literal against the runner subset.
 * @param {string} literal
 * @param {string} name
 * @param {number} line
 * @param {VerifyIssue[]} errors
 * @returns {void}
 */
function checkSchemaLiteral(literal, name, line, errors) {
  const masked = codeOnly(literal);
  const bad = [];
  if (/(^|[^\w$])description\s*:\s*['"`]/.test(masked)) bad.push("description");
  if (/(^|[^\w$])title\s*:\s*['"`]/.test(masked)) bad.push("title");
  for (const kw of SCHEMA_KEYWORDS_BAD) {
    if (new RegExp(`(^|[^\\w$])${kw.replace("$", "\\$")}\\s*:`).test(masked)) bad.push(kw);
  }
  for (const key of bad) {
    errors.push({
      severity: "error",
      code: "E_SCHEMA",
      line,
      message: `${name}: key "${key}" is rejected in Muse inline schemas`,
      hint: "Keep only type/enum/required/properties/items; move the rest into the prompt text.",
    });
  }
  if (Buffer.byteLength(literal, "utf8") > 4096) {
    errors.push({
      severity: "error",
      code: "E_SCHEMA",
      line,
      message: `${name}: schema exceeds the 4 KiB inline limit`,
      hint: "Split the schema across calls or move detail into the prompt.",
    });
  }
  let depth = 0;
  let maxDepth = 0;
  for (const c of masked) {
    if (c === "{" || c === "[") {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === "}" || c === "]") depth -= 1;
  }
  if (maxDepth > 16) {
    errors.push({
      severity: "error",
      code: "E_SCHEMA",
      line,
      message: `${name}: schema nests ${maxDepth} levels deep (limit 16)`,
      hint: "Flatten nested objects into fewer levels.",
    });
  }
  const inner = literal.slice(literal.indexOf("{" + "") + 1, literal.lastIndexOf("}"));
  const entries = splitTopLevel(inner).length;
  if (entries > 16) {
    errors.push({
      severity: "error",
      code: "E_SCHEMA",
      line,
      message: `${name}: schema has ${entries} top-level entries (limit 16)`,
      hint: "Trim the schema to the fields the caller actually reads.",
    });
  }
}

/**
 * Verify a Claude Workflow script.
 * @param {string} source
 * @param {{ agentsDir?: string | null }} [options]
 * @returns {VerifyResult}
 */
export function verifyClaude(source, { agentsDir = null } = {}) {
  /** @type {VerifyIssue[]} */
  const errors = [];
  /** @type {VerifyIssue[]} */
  const warnings = [];
  const masked = codeOnly(source);

  const metaMatch = /export\s+const\s+meta\s*=\s*\{/.exec(source);
  const metaReal = metaMatch != null && masked[/** @type {number} */ (metaMatch.index)] !== " ";
  if (!metaReal) {
    errors.push({
      severity: "error",
      code: "E_NO_META",
      line: 1,
      message: "missing export const meta = { ... }",
      hint: "Add export const meta = { name, description, whenToUse, phases: [] }.",
    });
  } else {
    const metaIdx = /** @type {number} */ (/** @type {RegExpExecArray} */ (metaMatch).index);
    const openIdx = source.indexOf("{", metaIdx);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    const block = closeIdx > 0 ? source.slice(openIdx, closeIdx + 1) : "";
    if (!/name\s*:/.test(block)) {
      errors.push({
        severity: "error",
        code: "E_META_FIELD",
        line: lineOf(source, metaIdx),
        message: "meta is missing the name field",
        hint: "Add name: a short identifier for this workflow.",
      });
    }
    for (const field of ["description", "whenToUse"]) {
      if (!new RegExp(`${field}\\s*:`).test(block)) {
        warnings.push({
          severity: "warning",
          code: "W_META_FIELD",
          line: lineOf(source, metaIdx),
          message: `meta is missing the ${field} field`,
          hint: `Add ${field}: so agents know when to launch this workflow.`,
        });
      }
    }
  }

  if (/export\s+default\s+async\s+function\s+workflow\s*\(\s*host\s*\)/.test(source)) {
    errors.push({
      severity: "error",
      code: "E_WRAPPER",
      line: 1,
      message: "Muse workflow(host) wrapper is not a Claude script",
      hint: "Claude scripts use top-level await with no wrapper — convert with wfport -o claude.",
    });
  }
  if (/(?<![\w$.])host\.(agent|parallel|phase|log|pipeline)\s*\(/.test(masked)) {
    errors.push({
      severity: "error",
      code: "E_HOST_CALLS",
      line: 1,
      message: "host.* calls belong to the Muse shape, not Claude",
      hint: "Call the bare globals: agent(), parallel(), phase(), log().",
    });
  }

  const { sites, unclosed } = collectCalls(source, masked, "agent");
  for (const site of sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx);
    const args = splitTopLevel(inner);
    if (args.length > 1 && !(args[1] ?? "").trimStart().startsWith("{")) {
      warnings.push({
        severity: "warning",
        code: "W_DYNAMIC_OPTS",
        line: site.line,
        message: `options built from ${args[1].slice(0, 40)} — verify agentType/schema by hand`,
        hint: "Prefer a literal { agentType, schema } object so checkers can see it.",
      });
    }
  }
  const parallels = collectCalls(source, masked, "parallel");
  for (const site of parallels.sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx);
    const arrOpen = inner.indexOf("[");
    const arrClose = arrOpen >= 0 ? matchDelim(inner, arrOpen, "[", "]") : -1;
    if (arrOpen < 0 || arrClose < 0) {
      errors.push({
        severity: "error",
        code: "E_PARALLEL_SHAPE",
        line: site.line,
        message: "parallel() argument is not an array literal",
        hint: "Rebuild as parallel([() => agent(...), ...]).",
      });
      continue;
    }
    for (const entry of splitTopLevel(inner.slice(arrOpen + 1, arrClose))) {
      const t = entry.trim();
      if (/^\(\)\s*=>/.test(t) || /^[A-Za-z_$][\w$]*$/.test(t)) continue;
      if (/^agent\s*\(/.test(t)) {
        errors.push({
          severity: "error",
          code: "E_PARALLEL_SHAPE",
          line: site.line,
          message: "parallel() entries must be thunks, not bare agent() calls",
          hint: "Wrap each entry: () => agent(...).",
        });
      } else {
        warnings.push({
          severity: "warning",
          code: "W_DYNAMIC_ENTRY",
          line: site.line,
          message: `dynamic parallel entry ${t.slice(0, 40)} — rebuild as () => agent(...)`,
          hint: "Build the job list from literals so each entry is reviewable.",
        });
      }
    }
  }

  checkShared(source, masked, sites, unclosed, errors, warnings);
  checkAgentFiles(source, agentsDir, warnings);

  const found = collectAgentTypes(source);
  for (const d of found.dynamics) {
    warnings.push({
      severity: "warning",
      code: "W_DYNAMIC_AGENTTYPE",
      line: d.line,
      message: `dynamic agentType ${d.expr} — confirm every value names an agent file`,
      hint: "List the possible values in a comment so reviewers can check them.",
    });
  }

  return {
    dialect: "claude",
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { agentCalls: sites.length, parallelSites: parallels.sites.length },
  };
}

/**
 * Verify a Muse Workflow script (V1 body shape).
 * @param {string} source
 * @param {{ agentsDir?: string | null }} [options]
 * @returns {VerifyResult}
 */
export function verifyMuse(source, { agentsDir = null } = {}) {
  void agentsDir;
  /** @type {VerifyIssue[]} */
  const errors = [];
  /** @type {VerifyIssue[]} */
  const warnings = [];
  const masked = codeOnly(source);
  const fingerprinted = CONVERTER_FINGERPRINT.test(source);

  const hasWrapper = /export\s+default\s+async\s+function\s+workflow\s*\(\s*host\s*\)/.test(source);
  if (hasWrapper) {
    errors.push({
      severity: "error",
      code: "E_WRAPPER",
      line: 1,
      message: "legacy workflow(host) wrapper fails the runner preflight",
      hint: "Unwrap to the V1 body shape: top-level await, bare agent()/parallel() calls, no export.",
    });
  } else if (/(^|[;\n{}])\s*export\b/.test(masked)) {
    errors.push({
      severity: "error",
      code: "E_EXPORT",
      line: 1,
      message: "exports are rejected — the runner wraps the script as a function body",
      hint: "Delete the export; keep the value as a plain const.",
    });
  }
  if (
    !hasWrapper &&
    /(?<![\w$.])host\.(agent|parallel|phase|log|pipeline|args|budget)\s*\(?/.test(masked)
  ) {
    errors.push({
      severity: "error",
      code: "E_HOST_CALLS",
      line: 1,
      message: "host.* has no binding in the V1 body shape",
      hint: "Call the bare globals: agent(), parallel(), phase(), log(), pipeline, args, budget.",
    });
  }
  // A carried Claude meta (`const meta /* Muse: ... */`, left by a
  // Claude -> Muse run) is intentional data, not a stale export — exempt it.
  if (/const\s+meta\s*=\s*\{/.test(masked) && !/const\s+meta\s*\/\* Muse:/.test(source)) {
    warnings.push({
      severity: "warning",
      code: "W_STALE_META",
      line: 1,
      message: "const meta goes nowhere — Muse takes name/description at launch",
      hint: "Delete the const and pass name/description at the Workflow launch.",
    });
  }

  const { sites, unclosed } = collectCalls(source, masked, "agent");
  for (const site of sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx);
    const args = splitTopLevel(inner);
    const first = (args[0] ?? "").trim();
    if (args.length === 1 && first.startsWith("{")) {
      const split = splitRequestObject(first);
      if (!split) {
        errors.push({
          severity: "error",
          code: "E_REQUEST_NO_INPUT",
          line: site.line,
          message: "agent request object has no input: field",
          hint: "Use agent({ input: <prompt>, ... }) so the prompt is explicit.",
        });
      }
    } else if (args.length === 1 && !first.startsWith("{")) {
      const dispatchSrc = first;
      const m = /^\s*museDispatchArgs\s*\(/.exec(dispatchSrc);
      if (m) {
        const openIdx = dispatchSrc.indexOf("(");
        const closeIdx = matchDelim(dispatchSrc, openIdx, "(", ")");
        const dispArgs =
          closeIdx > 0 ? splitTopLevel(dispatchSrc.slice(openIdx + 1, closeIdx)) : [];
        const rest = (dispArgs[1] ?? "").trim();
        if (rest && !rest.startsWith("{") && !rest.startsWith("...")) {
          warnings.push({
            severity: "warning",
            code: "W_DYNAMIC_OPTS",
            line: site.line,
            message: `options built from ${rest.slice(0, 40)} — verify agentType/schema by hand`,
            hint: "Prefer a literal options object so checkers can see it.",
          });
        }
      } else {
        warnings.push({
          severity: "warning",
          code: "W_DYNAMIC_OPTS",
          line: site.line,
          message: `agent() built from ${first.slice(0, 40)} — verify the request shape by hand`,
          hint: "Prefer agent({ input, ... }) with a literal object.",
        });
      }
    }
  }

  const found = collectAgentTypes(source);
  for (const l of found.literals) {
    if (MUSE_AGENT_TYPES.has(l.value)) continue;
    const routed = fingerprinted && /museDispatchArgs/.test(source);
    if (routed) {
      warnings.push({
        severity: "warning",
        code: "W_AGENT_TYPE_MAPPED",
        line: l.line,
        message: `"${l.value}" rides museDispatchArgs to general-purpose — refine the role prompt`,
        hint: `Inline .claude/agents/${l.value}.md into the role map when the prompt needs it.`,
      });
    } else {
      errors.push({
        severity: "error",
        code: "E_AGENT_TYPE",
        line: l.line,
        message: `agentType "${l.value}" is not a Muse built-in`,
        hint: 'Use "general-purpose" or "workflow-subagent" and inline any custom prompt by hand.',
      });
    }
  }
  for (const d of found.dynamics) {
    warnings.push({
      severity: "warning",
      code: "W_DYNAMIC_AGENTTYPE",
      line: d.line,
      message: `dynamic agentType ${d.expr} — confirm every value is a Muse built-in`,
      hint: "List the possible values in a comment so reviewers can check them.",
    });
  }

  if (/(^|[^\w$])model\s*:/.test(masked)) {
    warnings.push({
      severity: "warning",
      code: "W_MODEL_PIN",
      line: 1,
      message: "model pins are dropped at runtime (the session route inherits)",
      hint: "Delete model: unless a wrapper re-applies it.",
    });
  }

  for (const c of collectSchemaConsts(source)) {
    const literal = source.slice(c.openIdx, c.closeIdx + 1);
    checkSchemaLiteral(literal, c.name, lineOf(source, c.openIdx), errors);
  }
  const inlineRe = /schema\s*:\s*\{/g;
  let im;
  while ((im = inlineRe.exec(source)) !== null) {
    if (masked[im.index] === " ") continue;
    const openIdx = source.indexOf("{", im.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    if (closeIdx < 0) {
      errors.push({
        severity: "error",
        code: "E_SYNTAX",
        line: lineOf(source, im.index),
        message: "unbalanced braces in inline schema",
        hint: "Close the schema object literal.",
      });
      continue;
    }
    checkSchemaLiteral(
      source.slice(openIdx, closeIdx + 1),
      "inline schema",
      lineOf(source, im.index),
      errors,
    );
  }

  const parallels = collectCalls(source, masked, "parallel");
  for (const site of parallels.sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx).trim();
    if (!inner.startsWith("[")) {
      errors.push({
        severity: "error",
        code: "E_PARALLEL_SHAPE",
        line: site.line,
        message: "parallel() argument is not an array literal",
        hint: "Rebuild as parallel([{ input, ... }, ...]).",
      });
      continue;
    }
    const arrClose = matchDelim(inner, 0, "[", "]");
    const body = arrClose > 0 ? inner.slice(1, arrClose) : inner.slice(1);
    for (const entry of splitTopLevel(body)) {
      const t = entry.trim();
      if (!t) continue;
      if (t.startsWith("{")) {
        if (!/input\s*:/.test(t)) {
          errors.push({
            severity: "error",
            code: "E_REQUEST_NO_INPUT",
            line: site.line,
            message: "parallel() entry has no input: field",
            hint: "Give every job an input: prompt.",
          });
        }
        continue;
      }
      // Thunks pass through the Claude -> Muse codemod untouched, so they
      // are valid input — but request objects are the canonical shape.
      if (/^\(\)\s*=>/.test(t)) {
        warnings.push({
          severity: "warning",
          code: "W_PARALLEL_THUNK",
          line: site.line,
          message: "parallel() entry is a thunk, not a request object",
          hint: "Prefer parallel([{ input, ... }, ...]) request objects.",
        });
      } else if (/^agent\s*\(/.test(t)) {
        errors.push({
          severity: "error",
          code: "E_PARALLEL_SHAPE",
          line: site.line,
          message: "parallel() entry calls agent() eagerly — it runs before the fan-out",
          hint: "Use parallel([{ input, ... }, ...]) so every job joins the barrier.",
        });
      }
    }
  }

  const retMatch = /^\s*return\b/m.exec(masked);
  if (!retMatch) {
    errors.push({
      severity: "error",
      code: "E_NO_RETURN",
      line: 1,
      message: "no top-level return carrying the result",
      hint: "End the run with return { status, ref, text }.",
    });
  } else {
    const retIdx = retMatch.index;
    const tail = masked.slice(retIdx, retIdx + 400);
    if (/\{\s*[^}]*\}/.test(tail) && !/status\s*:/.test(tail)) {
      warnings.push({
        severity: "warning",
        code: "W_RETURN_SHAPE",
        line: lineOf(source, retIdx),
        message: "return value has no status: field",
        hint: "Return { status, ref, text } so the caller can route on status.",
      });
    }
  }
  // The return requirement is validated above (with a shape check), so
  // skip it in the shared pass.
  checkShared(source, masked, sites, unclosed, errors, warnings, false);

  return {
    dialect: "muse",
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { agentCalls: sites.length, parallelSites: parallels.sites.length },
  };
}

/** JS constructs with no Rhai form. @type {{ re: RegExp, label: string }[]} */
const JS_SYNTAX = [
  { re: /=>/, label: "arrow function" },
  { re: /\?\?/, label: "nullish coalescing ??" },
  { re: /\?\.\s*[A-Za-z_$]/, label: "optional chaining ?." },
  { re: /===|!==/, label: "strict equality ===/!==" },
  { re: /`/, label: "template literal" },
  { re: /(^|[^\w$])const\s+[A-Za-z_$]/, label: "const declaration (Rhai uses let)" },
  { re: /(^|[^\w$])export\s+(const|default|function|let)/, label: "export (no Rhai equivalent)" },
  { re: /require\s*\(/, label: "require() (no Rhai equivalent)" },
  { re: /\.\.\./, label: "spread ..." },
  { re: /(^|[^\w$])typeof\s/, label: "typeof (no Rhai equivalent)" },
  { re: /(^|[^\w$])instanceof\s/, label: "instanceof (no Rhai equivalent)" },
  { re: /(^|[^\w$])new\s+[A-Za-z_$]/, label: "new expression (no Rhai equivalent)" },
  { re: /(^|[^\w$])delete\s+[A-Za-z_$]/, label: "delete expression (no Rhai equivalent)" },
];

/**
 * Verify a Grok Build (Rhai) workflow script.
 * @param {string} source
 * @returns {VerifyResult}
 */
export function verifyGrok(source) {
  /** @type {VerifyIssue[]} */
  const errors = [];
  /** @type {VerifyIssue[]} */
  const warnings = [];
  const masked = codeOnly(source);

  const metaMatch = /let\s+meta\s*=\s*#\{/.exec(source);
  if (!metaMatch || masked[metaMatch.index] === " ") {
    errors.push({
      severity: "error",
      code: "E_NO_META",
      line: 1,
      message: "missing let meta = #{ ... }",
      hint: "Add let meta = #{ name, description, when_to_use, phases: [#{ title }] }; first.",
    });
  } else {
    const openIdx = source.indexOf("{", metaMatch.index);
    const closeIdx = matchDelim(source, openIdx, "{", "}");
    if (closeIdx < 0) {
      errors.push({
        severity: "error",
        code: "E_SYNTAX",
        line: lineOf(source, metaMatch.index),
        message: "unbalanced braces in let meta map",
        hint: "Close the #{ ... } map literal.",
      });
    } else {
      const block = source.slice(openIdx, closeIdx + 1);
      if (!/\bname\s*:/.test(block)) {
        errors.push({
          severity: "error",
          code: "E_META_FIELD",
          line: lineOf(source, metaMatch.index),
          message: "meta is missing the name field",
          hint: "Add name: a short identifier for this workflow.",
        });
      }
      for (const field of ["description", "when_to_use"]) {
        if (!new RegExp(`\\b${field}\\s*:`).test(block)) {
          warnings.push({
            severity: "warning",
            code: "W_META_FIELD",
            line: lineOf(source, metaMatch.index),
            message: `meta is missing the ${field} field`,
            hint: `Add ${field}: so agents know when to launch this workflow.`,
          });
        }
      }
      if (!/\bphases\s*:/.test(block)) {
        warnings.push({
          severity: "warning",
          code: "W_META_FIELD",
          line: lineOf(source, metaMatch.index),
          message: "meta is missing the phases list",
          hint: "Add phases: [#{ title, detail }] so progress can be tracked.",
        });
      }
    }
  }

  const { sites, unclosed } = collectCalls(source, masked, "agent");
  for (const line of unclosed) {
    errors.push({
      severity: "error",
      code: "E_SYNTAX",
      line,
      message: "unbalanced parentheses in agent() call",
      hint: "Close the argument list — the file cannot run until it parses.",
    });
  }
  for (const site of sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx);
    const args = splitTopLevel(inner);
    if (args.length === 0 || !(args[0] ?? "").trim()) {
      errors.push({
        severity: "error",
        code: "E_PARALLEL_SHAPE",
        line: site.line,
        message: "agent() has no prompt argument",
        hint: "Use agent(<prompt>, #{ ... }).",
      });
      continue;
    }
    const opts = (args[1] ?? "").trim();
    if (args.length > 1 && opts && !opts.startsWith("#{")) {
      warnings.push({
        severity: "warning",
        code: "W_DYNAMIC_OPTS",
        line: site.line,
        message: `options built from ${opts.slice(0, 40)} — map fields onto #{ ... } by hand`,
        hint: "Prefer a literal #{ label, capability_mode, output_schema } map.",
      });
      continue;
    }
    if (opts.startsWith("#{")) {
      const oOpen = opts.indexOf("{");
      const oClose = matchDelim(opts, oOpen, "{", "}");
      const body = oClose > 0 ? opts.slice(oOpen + 1, oClose) : opts.slice(oOpen + 1);
      for (const part of splitTopLevel(body)) {
        const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(part);
        if (!km) continue;
        if (!GROK_OPTION_KEYS.has(km[1])) {
          errors.push({
            severity: "error",
            code: "E_UNKNOWN_OPTION",
            line: site.line,
            message: `unknown agent() option "${km[1]}"`,
            hint: `Valid keys: ${[...GROK_OPTION_KEYS].join(", ")}.`,
          });
        }
      }
      const cap = /capability_mode\s*:\s*"([^"]*)"/.exec(body);
      if (cap && !GROK_CAPABILITIES.has(cap[1])) {
        warnings.push({
          severity: "warning",
          code: "W_CAPABILITY",
          line: site.line,
          message: `capability_mode "${cap[1]}" is not a known value`,
          hint: 'Use "all", or "read-only" for reviewer-like calls.',
        });
      }
    }
  }

  const parallels = collectCalls(source, masked, "parallel");
  /** Job maps dispatched through parallel(): inline entries plus .push(#{}) builds. */
  let jobMaps = (masked.match(/\.push\s*\(#\{/g) ?? []).length;
  for (const site of parallels.sites) {
    const inner = source.slice(site.openIdx + 1, site.closeIdx).trim();
    if (!inner.startsWith("[")) {
      // The emitter builds the job list in a variable first
      // (let jobs = []; jobs.push(...); parallel(jobs)) — valid, but the
      // list construction needs a human eye.
      if (/^[A-Za-z_$][\w$]*$/.test(inner)) {
        warnings.push({
          severity: "warning",
          code: "W_JOB_LIST",
          line: site.line,
          message: `parallel() takes a prebuilt list (${inner}) — confirm it holds #{ prompt, ... } job maps`,
          hint: "Check each pushed entry carries prompt plus label/capability_mode/output_schema as needed.",
        });
        continue;
      }
      errors.push({
        severity: "error",
        code: "E_PARALLEL_SHAPE",
        line: site.line,
        message: "parallel() argument is not a job list",
        hint: "Rebuild as parallel([#{ prompt, ... }, ...]).",
      });
      continue;
    }
    const arrClose = matchDelim(inner, 0, "[", "]");
    const body = arrClose > 0 ? inner.slice(1, arrClose) : inner.slice(1);
    for (const entry of splitTopLevel(body)) {
      const t = entry.trim();
      if (!t) continue;
      if (t.startsWith("#{")) {
        jobMaps += 1;
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(t)) continue;
      errors.push({
        severity: "error",
        code: "E_PARALLEL_SHAPE",
        line: site.line,
        message: "parallel() entries must be #{ ... } job maps",
        hint: "Use parallel([#{ prompt, label, ... }, ...]).",
      });
      break;
    }
  }

  if (!/complete\s*\(/.test(masked)) {
    errors.push({
      severity: "error",
      code: "E_NO_COMPLETE",
      line: 1,
      message: "no complete() carrying the result",
      hint: "End the run with complete(#{ ... }).",
    });
  }

  for (const { re, label } of JS_SYNTAX) {
    const flagged = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = flagged.exec(masked)) !== null) {
      // Every hit is a real code position: masked blanks comments/strings,
      // and no JS_SYNTAX pattern matches Rhai's `#{` map opener.
      errors.push({
        severity: "error",
        code: "E_JS_SYNTAX",
        line: lineOf(source, m.index),
        message: `JS-only syntax: ${label}`,
        hint: "Rewrite in Rhai form — see the Grok emitter notes for the mapping.",
      });
      if (m[0].length === 0) flagged.lastIndex += 1;
    }
  }

  for (const pat of ["Date.now", "Math.random", "new Date("]) {
    let from = 0;
    while (true) {
      const idx = masked.indexOf(pat, from);
      if (idx < 0) break;
      const before = idx > 0 ? masked[idx - 1] : "";
      if (/[\w$]/.test(before ?? "")) {
        from = idx + 1;
        continue;
      }
      errors.push({
        severity: "error",
        code: "E_BANNED",
        line: lineOf(source, idx),
        message: `${pat} has no Rhai form and breaks deterministic replay`,
        hint: "Compute the value outside the run and pass it in.",
      });
      from = idx + 1;
    }
  }

  // Parallel job maps dispatch agents without an agent() call, so they
  // count toward the fan-out too.
  const dispatches = sites.length + jobMaps;
  if (dispatches === 0) {
    errors.push({
      severity: "error",
      code: "E_NO_AGENT",
      line: 1,
      message: "no agent() calls or parallel() job maps found",
      hint: "Add at least one agent() call carrying the work to do.",
    });
  } else if (dispatches > 15) {
    warnings.push({
      severity: "warning",
      code: "W_FANOUT",
      line: 1,
      message: `${dispatches} agent dispatches exceed the ~15-child guideline`,
      hint: "Chunk rounds across runs so one failure does not sink the batch.",
    });
  }

  return {
    dialect: "grok",
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { agentCalls: dispatches, parallelSites: parallels.sites.length },
  };
}

/**
 * Verify a workflow script in any dialect.
 * @param {string} source
 * @param {Dialect} dialect
 * @param {{ agentsDir?: string | null }} [options]
 * @returns {VerifyResult}
 */
export function verifyWorkflow(source, dialect, options = {}) {
  if (dialect === "claude") return verifyClaude(source, options);
  if (dialect === "muse") return verifyMuse(source, options);
  return verifyGrok(source);
}

/**
 * Compact line protocol for agents: one line per issue plus a RESULT line.
 * @param {VerifyResult} result
 * @param {string} filename
 * @returns {string}
 */
export function formatAgent(result, filename) {
  const lines = [];
  for (const issue of [...result.errors, ...result.warnings]) {
    const level = issue.severity === "error" ? "ERROR" : "WARN";
    lines.push(`${level} ${issue.code} ${filename}:${issue.line} ${issue.message}`);
  }
  lines.push(
    `RESULT valid=${result.ok ? "true" : "false"} errors=${result.errors.length} ` +
      `warnings=${result.warnings.length} dialect=${result.dialect} ` +
      `agents=${result.stats.agentCalls} parallel=${result.stats.parallelSites}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Formatted human output: status, annotated issues with source context and
 * hints, plus next steps.
 * @param {VerifyResult} result
 * @param {string} filename
 * @param {string} source
 * @returns {string}
 */
export function formatHuman(result, filename, source) {
  const out = [];
  out.push(`wfport verify ${filename} (dialect: ${result.dialect})`);
  out.push("");
  if (result.ok && result.warnings.length === 0) {
    out.push(
      `VALID — ${result.stats.agentCalls} agent call(s), ${result.stats.parallelSites} parallel site(s). Ready to convert or run.`,
    );
    return `${out.join("\n")}\n`;
  }
  out.push(
    `${result.ok ? "VALID with warnings" : "INVALID"} — ` +
      `${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
  );
  /** @type {[string, VerifyIssue[]][]} */
  const groups = [
    ["Errors", result.errors],
    ["Warnings", result.warnings],
  ];
  for (const [title, issues] of groups) {
    if (issues.length === 0) continue;
    out.push("");
    out.push(`${title}:`);
    for (const issue of issues) {
      out.push(`  [${issue.code}] ${filename}:${issue.line}: ${issue.message}`);
      const ctx = sourceLine(source, issue.line);
      if (ctx) out.push(`    > ${ctx.slice(0, 160)}`);
      if (issue.hint) out.push(`    hint: ${issue.hint}`);
    }
  }
  const codes = new Set([...result.errors, ...result.warnings].map((i) => i.code));
  const steps = [...codes].map((c) => NEXT_STEPS[c]).filter(Boolean);
  if (steps.length > 0) {
    out.push("");
    out.push("Next steps:");
    for (const step of new Set(steps)) out.push(`  - ${step}`);
  }
  if (!result.ok) {
    out.push("Fix the errors above, then re-run wfport verify to confirm.");
  }
  return `${out.join("\n")}\n`;
}
