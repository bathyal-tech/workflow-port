import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  convert,
  splitTopLevel,
  codeOnly,
  stripSchemaProps,
  museHelpers,
  collectAgentTypes,
} from "../src/convert.mjs";
import { emitGrok, extractFacts } from "../src/grok.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "fixtures", "sample.workflow.js.txt"), "utf8");
const toilShape = readFileSync(join(here, "fixtures", "toil-shape.workflow.js.txt"), "utf8");
const toilRounds = readFileSync(join(here, "fixtures", "toil-rounds.workflow.js.txt"), "utf8");

test("mechanical mapping: V1 body shape with bare globals", () => {
  const { code } = convert(sample, { inputName: "sample.workflow.js" });
  // No wrapper, no export keyword, no host object — the runner wraps this as a body.
  assert.doesNotMatch(code, /export default async function workflow\(host\)/);
  assert.doesNotMatch(code, /^\s*export\b/m);
  assert.doesNotMatch(code, /host\./);
  assert.match(code, /agent\(museDispatchArgs\(`Do the thing/);
  assert.match(code, /phase\("Bootstrap"\)/);
  assert.match(code, /log\("starting"\)/);
  assert.match(code, /parallel\(\[/);
  assert.match(code, /schema: RESULT_SCHEMA/);
  assert.match(code, /^return \{ status: "ok", first, pair \};/m);
});

test("custom agentType is mapped at runtime and reported", () => {
  const { code, report } = convert(sample, { inputName: "sample.workflow.js" });
  // Original types ride into the choke point so the role prompt survives.
  assert.match(code, /agentType: "bg-fix"/);
  assert.match(code, /"bg-fix": "You are a bg-fix agent/);
  assert.match(code, /"readonly-reviewer": "You are a read-only reviewer/);
  // Every dispatch goes through museDispatchArgs and unwraps with museResult.
  assert.doesNotMatch(code, /(?<![\w$.])agent\(\{ input:/);
  const values = report.agentTypes.map((a) => a.value).sort();
  assert.deepEqual(values, ["bg-fix", "readonly-reviewer"]);
});

test("schema descriptions are stripped and reported, not flagged", () => {
  const { code, report } = convert(sample, { inputName: "sample.workflow.js" });
  const schema = report.schemas.find((s) => s.name === "RESULT_SCHEMA");
  assert.ok(schema);
  assert.deepEqual(schema.issues, []);
  assert.doesNotMatch(code, /description: "outcome"/);
  assert.ok(
    report.gaps.some(
      (g) => g.kind === "schema" && /RESULT_SCHEMA: removed 1 description/.test(g.detail),
    ),
  );
});

test("splitTopLevel keeps commas inside templates and calls", () => {
  const parts = splitTopLevel("`a,b ${f(1,2)}`, { x: 1, y: 2 }");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /`a,b/);
});

test("grok: meta and agent calls lower to Rhai", () => {
  const { code } = emitGrok(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /let meta = #\{/);
  assert.match(code, /name: "sample-sweep"/);
  assert.match(code, /when_to_use: "Fixture only\."/);
  assert.match(code, /#\{ title: "Bootstrap"(, detail: "[^"]*")? \}/);
  assert.match(code, /let r1 = agent\(/);
  assert.match(code, /capability_mode: "all"/); // bg-fix
  assert.match(code, /capability_mode: "read-only"/); // readonly-reviewer
  assert.match(code, /output_schema: RESULT_SCHEMA/);
  assert.match(code, /complete\(#\{[^}]*first[^}]*pair[^}]*\}\);/);
});

test("grok: interpolated prompt and parallel are flagged", () => {
  const { gaps, facts } = emitGrok(sample, { inputName: "sample.workflow.js" });
  assert.equal(facts.calls.length, 3);
  assert.ok(gaps.some((g) => g.kind === "prompt"));
  assert.ok(gaps.some((g) => g.kind === "parallel"));
  assert.ok(gaps.some((g) => g.kind === "output_schema"));
  assert.ok(gaps.some((g) => g.kind === "control-flow"));
});

test("dynamic options are spread and flagged", () => {
  const src = "const r = await agent(p, agentOptions(spec, spec.label));\nreturn r;\n";
  const { code, report } = convert(src, { inputName: "dyn.js" });
  assert.match(
    code,
    /agent\(museDispatchArgs\(p, \{ \.\.\.agentOptions\(spec, spec\.label\) \}\)\)\.then\(museResult\)/,
  );
  assert.ok(report.gaps.some((g) => g.kind === "dynamic-options"));
});

test("agent() calls without options still route through the choke point", () => {
  const { code } = convert("const r = await agent(p);\nreturn r;\n", { inputName: "bare.js" });
  assert.match(code, /agent\(museDispatchArgs\(p, \{\}\)\)\.then\(museResult\)/);
});

test("agent-looking text in comments and strings is left alone", () => {
  const src = [
    "// `await agent()` is the completion barrier.",
    "const doc = `call agent(p, { label: 'x' }) or phase(\"Y\") when done`;",
    "const r = await agent(p, { label: 'real' });",
    "return r;",
  ].join("\n");
  const { code } = convert(src, { inputName: "comments.js" });
  assert.match(code, /\/\/ `await agent\(\)` is the completion barrier\./);
  assert.match(code, /call agent\(p, \{ label: 'x' \}\) or phase\("Y"\) when done/);
  assert.match(code, /agent\(museDispatchArgs\(p, \{ label: 'real' \}\)\)\.then\(museResult\)/);
});

test("converted output compiles as a runner-wrapped body (preflight shape)", async () => {
  const vm = await import("node:vm");
  for (const name of ["sample.workflow.js.txt", "toil-shape.workflow.js.txt"]) {
    const src = readFileSync(join(here, "fixtures", name), "utf8");
    const { code } = convert(src, { inputName: name });
    const wrapped =
      "async function __muse_workflow(agent, parallel, phase, log, pipeline, args, budget) {\n" +
      `${code}\n}`;
    vm.compileFunction(wrapped, []);
  }
});

test("envelope unwrap: helper maps error_kind/null to null, data to data", () => {
  const { code } = convert(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /const museResult = \(res\) => \{/);
  assert.match(code, /const museDispatchArgs = \(input, opts\) => \{/);
  const dispatches = [...code.matchAll(/museDispatchArgs\(/g)].length;
  const unwrapped = [...code.matchAll(/\.then\(museResult\)/g)].length;
  assert.ok(dispatches > 0);
  assert.equal(unwrapped, dispatches);
  const museResult = new Function(`${museHelpers([])}\n; return museResult;`)();
  assert.equal(museResult(null), null);
  assert.equal(museResult(undefined), null);
  assert.equal(museResult({ error_kind: "stalled" }), null);
  assert.deepEqual(museResult({ ref: "r1", data: { status: "ok" } }), { status: "ok" });
  assert.equal(museResult({ ref: "r1", data: null }), null);
});

test("non-meta exports are stripped so the wrapped body compiles", async () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    "export const AGENT_TOOLS = { runner: ['read'] };",
    "export function helper() { return 1; }",
    "export const r = await agent('hi', { label: 'x' });",
    "export { helper };",
    "return { r };",
  ].join("\n");
  const { code, report } = convert(src, { inputName: "exports.js" });
  assert.doesNotMatch(code, /^\s*export\b/m);
  assert.match(code, /const AGENT_TOOLS = /);
  assert.match(code, /function helper\(\)/);
  assert.ok(report.gaps.some((g) => g.kind === "export" && /AGENT_TOOLS/.test(g.detail)));
  // The whole point: the runner's wrapped-body compilation must succeed.
  const vm = await import("node:vm");
  const wrapped =
    "async function __muse_workflow(agent, parallel, phase, log, pipeline, args, budget) {\n" +
    `${code}\n}`;
  vm.compileFunction(wrapped, []);
});

test("dispatch sanitizes schemas at runtime, whatever built them", () => {
  const museDispatchArgs = new Function(`${museHelpers([])}\n; return museDispatchArgs;`)();
  const out = museDispatchArgs("brief", {
    label: "x",
    schema: {
      type: "object",
      description: "top-level description the Muse runner rejects",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok"], description: "nested, also rejected" },
        // A field *named* description is data, not a schema keyword: keep it.
        description: { type: "string", title: "kept field, dropped keyword" },
        tags: { type: "array", items: { type: "string", description: "in items" } },
      },
    },
  });
  assert.deepEqual(out.schema, {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
  });
  // Non-schema options and non-object schemas pass through untouched.
  const plain = museDispatchArgs("brief", { label: "y", schema: "RESULT_SCHEMA" });
  assert.equal(plain.schema, "RESULT_SCHEMA");
  assert.equal(plain.label, "y");
});

test("dispatch warns on an unknown agentType instead of mapping silently", () => {
  /** @type {string[]} */
  const logs = [];
  const museDispatchArgs = new Function(
    "log",
    `${museHelpers(["known-type"])}\n; return museDispatchArgs;`,
  )((/** @type {unknown} */ msg) => logs.push(String(msg)));
  const out = museDispatchArgs("brief", { agentType: "mystery" });
  assert.equal(out.agentType, "general-purpose");
  assert.equal(out.input, "brief");
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /unknown agentType "mystery"/);
  // A known type dispatches with its role and no warning.
  const known = museDispatchArgs("brief", { agentType: "known-type" });
  assert.match(known.input, /known-type agent/);
  assert.equal(logs.length, 1);
});

test("model pins map to Muse models at dispatch, per-type pins from agent files", () => {
  const museDispatchArgs = new Function(
    "log",
    `${museHelpers(["tl-reflect"], {}, { "tl-reflect": "muse-wonder-1.0" })}\n; return museDispatchArgs;`,
  )(() => {});
  assert.equal(museDispatchArgs("b", { model: "sonnet" }).model, "muse-spark-1.3");
  assert.equal(museDispatchArgs("b", { model: "claude-opus-4-1" }).model, "muse-wonder-1.0");
  assert.equal(museDispatchArgs("b", { model: "muse-ember-1.0" }).model, "muse-ember-1.0");
  assert.equal(museDispatchArgs("b", { agentType: "tl-reflect" }).model, "muse-wonder-1.0");
  assert.equal("model" in museDispatchArgs("b", { model: "gpt-x" }), false);
  // Agent-file model: frontmatter reaches the helper via convert().
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const r = await agent("hi", { agentType: "modeled-type", label: "x" });',
    "return { r };",
  ].join("\n");
  const { code, report } = convert(src, {
    inputName: "modeled.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  assert.match(code, /"modeled-type": "muse-wonder-1\.0"/);
  assert.equal(report.agentTypes.find((a) => a.value === "modeled-type")?.model, "muse-wonder-1.0");
});

test("codex MCP mention rewrites to the project script when it exists", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const r = await agent("Post the mention with mcp__github__add_issue_comment, never via the MCP web UI.", { label: "codex-request" });',
    "return { r };",
  ].join("\n");
  const plain = convert(src, { inputName: "codex.js" });
  assert.match(plain.code, /mcp__github__add_issue_comment/);
  const routed = convert(src, {
    inputName: "codex.js",
    codexReviewScript: "scripts/codex-review.ts",
  });
  assert.doesNotMatch(routed.code, /mcp__github__add_issue_comment/);
  assert.match(routed.code, /bun scripts\/codex-review\.ts request/);
  // No backticks are injected: prompts are often template literals, where a
  // stray backtick would close the literal and break preflight parsing.
  assert.doesNotMatch(routed.code, /`bun scripts/);
  assert.ok(routed.report.gaps.some((g) => g.kind === "codex-mcp" && /rewritten/.test(g.detail)));
  // The account identity premise is disclosed as a gap, not baked in.
  assert.ok(
    routed.report.gaps.some(
      (g) => g.kind === "codex-mcp" && /identity|authenticated/.test(g.detail),
    ),
  );
});

test("template-literal prompts survive the codex rewrite and still compile", async () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    "const r = await agent(`Post the mention with mcp__github__add_issue_comment for ${pr}.`, { label: 'x' });",
    "return { r };",
  ].join("\n");
  const { code } = convert(src, {
    inputName: "codex-tmpl.js",
    codexReviewScript: "scripts/codex-review.ts",
  });
  const vm = await import("node:vm");
  const wrapped =
    "async function __muse_workflow(agent, parallel, phase, log, pipeline, args, budget) {\n" +
    `${code}\n}`;
  vm.compileFunction(wrapped, []);
});

test("model constants and model: literals are mapped in the text, not just at dispatch", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const CITATION_AUDIT_MODEL = "sonnet";',
    'const r = await agent("hi", { label: "x", model: "opus" });',
    "return { r };",
  ].join("\n");
  const { code } = convert(src, { inputName: "models.js" });
  assert.match(code, /const CITATION_AUDIT_MODEL = "muse-spark-1\.3";/);
  assert.match(code, /model: "muse-wonder-1\.0"/);
  assert.doesNotMatch(code, /= "sonnet"|model: "opus"/);
});

test("known Claude-only tool names drop from inventories; spread returns keep their shape", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const AGENT_TOOLS = ["Read", "Artifact", "Monitor", "TaskStop"];',
    'const r = await agent("hi", { label: "x" });',
    "return { ...r, extra: 1 };",
  ].join("\n");
  const { code, report } = convert(src, { inputName: "tools3.js" });
  assert.doesNotMatch(code, /"Artifact"|"Monitor"|"TaskStop"/);
  assert.ok(report.gaps.some((g) => g.kind === "tool-names" && /Artifact/.test(g.detail)));
  // A spread may already carry status: converter must not hardcode one.
  assert.doesNotMatch(code, /status: "ok", \.\.\.r/);
});

test("trailing whitespace is trimmed outside template literals only", () => {
  const src =
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };   \n' +
    "const s = `keep me   \nnext`;\n" +
    'const r = await agent("hi", { label: "x" });  \n' +
    "return { r };\n";
  const { code } = convert(src, { inputName: "ws.js" });
  assert.doesNotMatch(code, /phases: \[\] \};   \n/);
  assert.doesNotMatch(code, /label: "x" \}\);  \n/);
  assert.match(code, /keep me   \nnext`/);
});

test("extended tool names map and terminal return gains status", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const AGENT_TOOLS = ["TodoWrite", "WebFetch", "WebSearch", "NotebookRead"];',
    'const r = await agent("hi", { label: "x" });',
    "return { r };",
  ].join("\n");
  const { code, report } = convert(src, { inputName: "tools2.js" });
  assert.match(code, /\["write_todos", "web_fetch", "web_search", "read"\]/);
  assert.match(code, /return \{ status: "ok", r \};/);
  assert.ok(report.gaps.some((g) => g.kind === "return" && /status/.test(g.detail)));
});

test("toil-shape: fragments, notes, titles, dynamic types, model pin, mcp", () => {
  const { code, report } = convert(toilShape, { inputName: "toil-shape.workflow.js" });
  // Choke points cover every dispatch, including the helper-defined ones.
  assert.match(code, /const MUSE_ROLE_FOR = \{/);
  assert.match(code, /"tl-runner": "You are a mechanical runner/);
  assert.match(code, /"tl-select": "You are the toil-block selector/);
  assert.match(code, /"tl-fix": "You are the toil-block fixer/);
  assert.match(code, /"readonly-reviewer": "You are a read-only reviewer/);
  const dispatches = [...code.matchAll(/museDispatchArgs\(/g)].length;
  assert.ok(dispatches >= 6);
  assert.equal([...code.matchAll(/\.then\(museResult\)/g)].length, dispatches);
  // Fragment + schema descriptions stripped, notes dropped, titles kept.
  assert.match(code, /const INHERITED_PROPERTY = \{\s*type: "boolean",\s*\};/);
  assert.doesNotMatch(code, /notes: \{ type/);
  assert.match(code, /title: \{ type: "string" \}/);
  assert.doesNotMatch(code, /description: "One line for the manifest/);
  const values = report.agentTypes.map((a) => a.value).sort();
  assert.deepEqual(values, ["readonly-reviewer", "tl-fix", "tl-runner", "tl-select"]);
  assert.ok(
    report.gaps.some(
      (g) => g.kind === "agentType" && /dynamic agentType spec\.agentType/.test(g.detail),
    ),
  );
  assert.ok(
    report.gaps.some(
      (g) => g.kind === "agentType" && /dynamic agentType options\.runnerType/.test(g.detail),
    ),
  );
  assert.ok(report.gaps.some((g) => g.kind === "model"));
  assert.ok(report.gaps.some((g) => g.kind === "codex-mcp"));
  // Comment-text banned mentions are not uses; stripped schemas are clean.
  assert.ok(!report.gaps.some((g) => g.kind === "banned-api"));
  assert.ok(!report.banned.length);
  for (const s of report.schemas) assert.deepEqual(s.issues, []);
});

test("read-only agent file tools are a blocking tool-restriction gap for muse", () => {
  const { report } = convert(sample, {
    inputName: "sample.workflow.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  const gap = report.gaps.find((g) => g.kind === "tool-restriction");
  assert.ok(gap, "expected a tool-restriction gap");
  // The generated file itself discloses the loss in its header, not just the report.
  const { code } = convert(sample, {
    inputName: "sample.workflow.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  assert.match(code, /WARNING: .*read-only role .*prompt-only/);
  assert.match(gap.detail, /readonly-reviewer/);
  assert.match(gap.detail, /Read, Glob, Grep/);
  assert.match(gap.detail, /prompt-only|NOT enforced/);
  const entry = report.agentTypes.find((a) => a.value === "readonly-reviewer");
  assert.deepEqual(entry?.tools, ["Read", "Glob", "Grep"]);
  // A write-capable agent file (Read, Write) is not a read-only restriction.
  const { report: rep2 } = convert(toilRounds, {
    inputName: "toil-rounds.workflow.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  assert.ok(!rep2.gaps.some((g) => g.kind === "tool-restriction" && /tl-reporter/.test(g.detail)));
});

test("existing agent files are pointed at, not collapsed to one-line roles", () => {
  const { code, report } = convert(sample, {
    inputName: "sample.workflow.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  // readonly-reviewer.md exists in the fixtures dir: pointer, not the short role.
  assert.match(code, /"readonly-reviewer": "Read .*readonly-reviewer\.md and follow it/);
  assert.doesNotMatch(code, /"readonly-reviewer": "You are a read-only reviewer/);
  // bg-fix has no agent file: the short fallback role stays.
  assert.match(code, /"bg-fix": "You are a bg-fix agent/);
  const entry = report.agentTypes.find((a) => a.value === "readonly-reviewer");
  assert.match(entry?.action ?? "", /points at/);
});

test("mcp__ tool orders in prompts are flagged for muse children", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const r = await agent("Request review with mcp__github__add_issue_comment, then collect it.", { label: "codex-request" });',
    "return { r };",
  ].join("\n");
  const { report } = convert(src, { inputName: "mcp.js" });
  const gap = report.gaps.find((g) => g.kind === "mcp-tool");
  assert.ok(gap, "expected an mcp-tool gap");
  assert.match(gap.detail, /mcp__github__add_issue_comment/);
  assert.match(gap.detail, /no MCP tools/);
});

test("codex-review fallback path is flagged even without tl-runner", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const r = await agent("Fall back to scripts/codex-review.ts when the mention fails.", { label: "codex-request" });',
    "return { r };",
  ].join("\n");
  const { report } = convert(src, { inputName: "codex-fallback.js" });
  assert.ok(report.gaps.some((g) => g.kind === "codex-mcp"));
});

test("tool inventories map Claude tool names to Muse names; mcp/ToolSearch flagged", () => {
  const src = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    'const AGENT_TOOLS = { runner: ["Read", "Write", "Bash", "Glob", "Grep"], reviewer: ["Read", "ToolSearch", "mcp__github__add_issue_comment"] };',
    "const recordToolGaps = (held) => AGENT_TOOLS.runner.filter((t) => !held.includes(t));",
    'const r = await agent("Do it.", { label: "x" });',
    "return { r };",
  ].join("\n");
  const { code, report } = convert(src, { inputName: "tools.js" });
  // Whole-string inventory entries become Muse tool names.
  assert.match(code, /"read", "write", "bash", "search"/);
  // Glob and Grep both map to search: the duplicate is dropped, not emitted.
  assert.doesNotMatch(code, /"search", "search"/);
  assert.doesNotMatch(code, /"(Read|Write|Bash|Glob|Grep)"/);
  // Names with no Muse equivalent are dropped from inventory arrays (and
  // reported), so tool-gap checks never chase tools no Muse child holds.
  assert.doesNotMatch(code, /"ToolSearch"|"mcp__github__add_issue_comment"/);
  const gap = report.gaps.find((g) => g.kind === "tool-names" && /ToolSearch/.test(g.detail));
  assert.ok(gap, "expected a tool-names gap for ToolSearch");
  assert.match(gap.detail, /no Muse equivalent/);
  assert.ok(report.gaps.some((g) => g.kind === "tool-names" && /Read->read/.test(g.detail)));
  // Prose mentioning a tool is not an inventory entry and is left alone.
  const prose = convert(
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };\nconst r = await agent("Use the Read tool first, then Bash.", { label: "x" });\nreturn { r };\n',
    { inputName: "prose.js" },
  );
  assert.match(prose.code, /Use the Read tool first, then Bash\./);
});

test("banned APIs count only in code, with real lines", () => {
  const src = [
    "// no `Date.now()` here — comment only",
    "const r = await agent(`at ${Date.now()}`, { label: 'a' });",
    "return r;",
  ].join("\n");
  const { report } = convert(src, { inputName: "banned.js" });
  assert.deepEqual(report.banned, ["Date.now"]);
  const gap = report.gaps.find((g) => g.kind === "banned-api");
  assert.ok(gap);
  assert.equal(gap.line, 2);
});

test("stripSchemaProps keeps field names and runtime notes", () => {
  const { text, removed } = stripSchemaProps(
    [
      "{",
      '  type: "object",',
      "  properties: {",
      '    title: { type: "string" },',
      '    note: { type: "string" },',
      '    notes: { type: "string" },',
      '    about: { type: "string", description: "Why." },',
      "  },",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(removed, { description: 1, title: 0, notes: 1, constraints: 0 });
  assert.match(text, /title: \{ type: "string" \}/);
  assert.match(text, /note: \{ type: "string" \}/);
  assert.doesNotMatch(text, /notes: \{ type/);
  assert.doesNotMatch(text, /description/);
  const kept = stripSchemaProps('`x`; const r = { notes: value ? "a" : "b" };');
  assert.deepEqual(kept.removed, { description: 0, title: 0, notes: 0, constraints: 0 });
});

test("stripSchemaProps removes rejected constraint keys but keeps keyword-named fields", () => {
  const { text, removed } = stripSchemaProps(
    [
      "{",
      '  type: "object",',
      "  properties: {",
      '    issue: { type: "integer", minimum: 1 },',
      '    pattern: { type: "string" },',
      '    choice: { type: "string", anyOf: [{ type: "string" }, { type: "number" }], format: "slug" },',
      "  },",
      "  additionalProperties: false,",
      "}",
    ].join("\n"),
  );
  // minimum, anyOf, format, additionalProperties go; the field named
  // `pattern` stays because its value is a schema object, not a pattern.
  assert.equal(removed.constraints, 4);
  assert.doesNotMatch(text, /minimum|anyOf|format:|additionalProperties/);
  assert.match(text, /issue: \{ type: "integer"\s*\}/);
  assert.match(text, /pattern: \{ type: "string" \}/);
});

test("convert strips rejected schema constraints and reports them clean", () => {
  const src = [
    "export const meta = { name: 's', description: 'd', whenToUse: 'w', phases: [] };",
    "const RESULT_SCHEMA = { type: 'object', properties: { issue: { type: 'integer', minimum: 1 } } };",
    "const r = await agent('hi', { label: 'x', schema: RESULT_SCHEMA });",
    "return { r };",
  ].join("\n");
  const { code, report } = convert(src, { inputName: "min.js" });
  // The executable schema is clean; the word survives only as data in the
  // wfport:preserve comment, where the Muse runner ignores it.
  assert.doesNotMatch(code.slice(code.indexOf("const RESULT_SCHEMA")), /minimum/);
  assert.match(code, /\/\/ wfport:preserve \{.*"key":"minimum"/);
  assert.deepEqual(report.schemas[0]?.issues, []);
  assert.ok(report.gaps.some((g) => g.kind === "schema" && /rejected constraint/.test(g.detail)));
});

test("codeOnly blanks comments and strings but keeps interpolation code", () => {
  const src = [
    "// Date.now in a comment",
    "const a = \"agentType: 'x'\";",
    "const t = `at ${Date.now()} done`;",
    "const r = await agent(p, { agentType: spec.agentType });",
  ].join("\n");
  const masked = codeOnly(src);
  assert.doesNotMatch(masked, /Date\.now in a comment/);
  assert.match(masked, /\$\{Date\.now\(\)\}/);
  const found = collectAgentTypes(src);
  assert.deepEqual(
    found.dynamics.map((d) => d.expr),
    ["spec.agentType"],
  );
  assert.deepEqual(found.literals, []);
});

test("grok: comment mentions are not call sites; prompts/structure carry over", () => {
  const { code, facts, gaps } = emitGrok(toilRounds, {
    inputName: "toil-rounds.workflow.js",
    agentsDir: join(here, "fixtures", "agents"),
  });
  // One comment mention (`await agent()`), one helper, one parallel of two
  // thunks, one schema const: 4 real agent() calls, 1 parallel() site.
  assert.equal(facts.calls.length, 4);
  assert.equal(facts.parallelSites, 1);
  assert.equal(
    facts.calls.filter((c) => toilRounds.split("\n")[c.line - 1].trimStart().startsWith("//"))
      .length,
    0,
  );
  // Zero agent() calls for the comment: every emitted agent( traces to a
  // real source line, and no TODO prompt names the comment's line.
  const commentLine = toilRounds.split("\n").findIndex((l) => l.includes("not a call site")) + 1;
  assert.ok(commentLine > 0);
  assert.doesNotMatch(code, new RegExp(`TODO: translate prompt \\(source line ${commentLine}\\)`));
  // The report never points output_schema at the options object.
  assert.ok(!gaps.some((g) => g.kind === "output_schema" && /options/.test(g.detail)));
  assert.ok(gaps.some((g) => g.kind === "parallel"));
  // Proxy for validate_only (no Rhai engine in this repo): the script must
  // be self-contained Rhai — meta first, no JS-only syntax, every
  // output_schema defined, no TODO prompts, result carried to complete().
  assert.match(code, /^\s*(?:\/\/.*\n|\n)*let meta = #\{/);
  assert.doesNotMatch(code, /`/);
  assert.doesNotMatch(code, /\bawait\s/);
  assert.doesNotMatch(code, /\basync\s/);
  assert.doesNotMatch(code, /^\s*export\s/m);
  assert.doesNotMatch(code, /===|!==|\?\?|\?\.|TODO: translate prompt/);
  assert.doesNotMatch(code, /output_schema: options\b/);
  assert.doesNotMatch(code, /museDispatchArgs\(\s*,/);
  assert.match(code, /let REVIEW_SCHEMA = #\{/);
  assert.match(code, /agent_type: "readonly-reviewer"/);
  assert.match(code, /agent_type: "tl-reporter"/);
  assert.match(code, /capability_mode: "read-only"/);
  assert.match(code, /capability_mode: "all"/);
  // Agent files resolve both modes from their tools lists: the reviewer
  // (Read/Glob/Grep) verifies read-only, the reporter (Read/Write)
  // verifies all — neither carries a placeholder gap. tl-runner has no
  // agent file, so its heuristic mode keeps the confirm-by-hand gap.
  const capGaps = gaps.filter((g) => g.kind === "capability_mode");
  assert.ok(!capGaps.some((g) => g.detail.includes("readonly-reviewer")));
  assert.ok(!capGaps.some((g) => g.detail.includes("tl-reporter")));
  assert.ok(capGaps.some((g) => g.detail.includes("tl-runner")));
  assert.match(code, /output_schema: REVIEW_SCHEMA/);
  assert.match(code, /#\{ title: "Review", detail: "review axes in rounds" \}/);
  assert.match(code, /phase\("Bootstrap"\);/);
  assert.match(code, /phase\("Review"\);/);
  assert.match(code, /args\.maxRounds/);
  assert.match(code, /while round < maxRounds \{/);
  assert.match(code, /parallel\(\[/);
  assert.match(code, /prompt: "Review " \+ json_encode\(axis\)/);
  assert.match(code, /label: "review:" \+ axis/);
  assert.match(code, /fn dispatchOne\(options\) \{/);
  assert.match(code, /complete\(#\{[^}]*report[^}]*\}\);/);
  // Every output_schema reference resolves to a definition in the output.
  for (const m of code.matchAll(/output_schema: ([A-Za-z_$][\w$]*)/g)) {
    assert.ok(
      new RegExp(`let ${m[1]} = #\\{`).test(code),
      `output_schema ${m[1]} is not defined in the output`,
    );
  }
});
