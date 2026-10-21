// Source/target dialect routing for wfport.
//
// Sources can be any workflow dialect (claude, muse, grok). The source is
// taken from -i/--input/--from when given, else inferred from the input
// path, else sniffed from the file content, else assumed claude (the
// historical input). The target is taken from -o/--output/--to when given;
// it defaults to muse only for claude sources — any other source requires
// an explicit target.

import { isMuseBody } from "./claude.mjs";

/** @typedef {"claude" | "muse" | "grok"} Dialect */

export const DIALECTS = ["claude", "muse", "grok"];

/**
 * @param {string | null | undefined} value
 * @returns {value is Dialect}
 */
export function isDialect(value) {
  return value === "claude" || value === "muse" || value === "grok";
}

/**
 * Infer the source dialect from the input path and file content.
 * Explicit --input wins; path hints beat content hints.
 * @param {string} inputPath
 * @param {string} content
 * @param {string | null | undefined} inputOpt
 * @returns {Dialect}
 */
export function detectSource(inputPath, content, inputOpt) {
  if (isDialect(inputOpt)) return inputOpt;
  const p = inputPath.toLowerCase();
  if (p.endsWith(".rhai")) return "grok";
  if (p.includes(".grok")) return "grok";
  if (p.includes(".claude")) return "claude";
  if (p.includes(".muse")) return "muse";
  if (p.includes("grok")) return "grok";
  if (p.includes("muse")) return "muse";
  if (p.includes("claude")) return "claude";
  if (/let\s+meta\s*=\s*#\{/.test(content) || /complete\s*\(#/.test(content)) return "grok";
  if (/function\s+workflow\s*\(\s*host\s*\)/.test(content) || /host\.agent\s*\(/.test(content))
    return "muse";
  // V1 body-shape Muse output: converter fingerprints, a wfport Muse
  // header, or a bare agent({ input }) request-object call (Claude always
  // passes the prompt first, so that shape is Muse-only).
  if (
    /museDispatchArgs|MUSE_ROLE_FOR|wfport:begin-helpers/.test(content) ||
    /Converted from (Claude Workflow|Grok) .*by workflow-port/.test(content) ||
    isMuseBody(content)
  )
    return "muse";
  if (/export\s+const\s+meta\s*=\s*\{/.test(content)) return "claude";
  if (/(?<![\w$.])agent\s*\(/.test(content)) return "claude";
  return "claude";
}

/**
 * Resolve the target dialect. Defaults to muse for claude sources;
 * any other source must name a target explicitly.
 * @param {Dialect} source
 * @param {string | null | undefined} targetOpt
 * @returns {Dialect}
 * @throws {Error} when the target is missing, unknown, or equals the source
 */
export function resolveTarget(source, targetOpt) {
  if (targetOpt != null && !isDialect(targetOpt))
    throw new Error(`unknown target "${targetOpt}" — expected one of ${DIALECTS.join("|")}`);
  if (targetOpt != null && targetOpt === source)
    throw new Error(`source and target are both "${source}" — nothing to convert`);
  if (targetOpt) return targetOpt;
  if (source === "claude") return "muse";
  throw new Error(
    `input infers as "${source}" — requires -o/--output <${DIALECTS.join("|")}> (the muse default applies only to claude inputs)`,
  );
}
