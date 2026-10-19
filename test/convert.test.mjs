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

test("mechanical mapping: wrapper, host.agent, host.phase/log/parallel", () => {
  const { code } = convert(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /export default async function workflow\(host\)/);
  assert.match(code, /host\.agent\(museDispatchArgs\(`Do the thing/);
  assert.match(code, /host\.phase\("Bootstrap"\)/);
  assert.match(code, /host\.log\("starting"\)/);
  assert.match(code, /host\.parallel\(\[/);
  assert.match(code, /schema: RESULT_SCHEMA/);
});

test("custom agentType is mapped at runtime and reported", () => {
  const { code, report } = convert(sample, { inputName: "sample.workflow.js" });
  // Original types ride into the choke point so the role prompt survives.
  assert.match(code, /agentType: "bg-fix"/);
  assert.match(code, /"bg-fix": "You are a bg-fix agent/);
  assert.match(code, /"readonly-reviewer": "You are a read-only reviewer/);
  // No raw host.agent call keeps a custom type: every dispatch goes
  // through museDispatchArgs and unwraps with museResult.
  assert.doesNotMatch(code, /host\.agent\(\{ input:/);
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
  assert.match(code, /#\{ title: "Bootstrap" \}/);
  assert.match(code, /let r1 = agent\(/);
  assert.match(code, /capability_mode: "all"/); // bg-fix
  assert.match(code, /capability_mode: "read-only"/); // readonly-reviewer
  assert.match(code, /output_schema: RESULT_SCHEMA/);
  assert.match(code, /complete\(#\{ status: "converted" \}\);/);
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
    /host\.agent\(museDispatchArgs\(p, \{ \.\.\.agentOptions\(spec, spec\.label\) \}\)\)\.then\(museResult\)/,
  );
  assert.ok(report.gaps.some((g) => g.kind === "dynamic-options"));
});

test("envelope unwrap: helper maps error_kind/null to null, data to data", () => {
  const { code } = convert(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /const museResult = \(res\) => \{/);
  assert.match(code, /const museDispatchArgs = \(input, opts\) => \{/);
  const dispatches = [...code.matchAll(/host\.agent\(/g)].length;
  const unwrapped = [...code.matchAll(/\.then\(museResult\)/g)].length;
  assert.ok(dispatches > 0);
  assert.equal(unwrapped, dispatches);
  const museResult = new Function(`${museHelpers([])}; return museResult;`)();
  assert.equal(museResult(null), null);
  assert.equal(museResult(undefined), null);
  assert.equal(museResult({ error_kind: "stalled" }), null);
  assert.deepEqual(museResult({ ref: "r1", data: { status: "ok" } }), { status: "ok" });
  assert.equal(museResult({ ref: "r1", data: null }), null);
});

test("toil-shape: fragments, notes, titles, dynamic types, model pin, mcp", () => {
  const { code, report } = convert(toilShape, { inputName: "toil-shape.workflow.js" });
  // Choke points cover every dispatch, including the helper-defined ones.
  assert.match(code, /const MUSE_ROLE_FOR = \{/);
  assert.match(code, /"tl-runner": "You are a mechanical runner/);
  assert.match(code, /"tl-select": "You are the toil-block selector/);
  assert.match(code, /"tl-fix": "You are the toil-block fixer/);
  assert.match(code, /"readonly-reviewer": "You are a read-only reviewer/);
  const dispatches = [...code.matchAll(/host\.agent\(/g)].length;
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
  assert.deepEqual(removed, { description: 1, title: 0, notes: 1 });
  assert.match(text, /title: \{ type: "string" \}/);
  assert.match(text, /note: \{ type: "string" \}/);
  assert.doesNotMatch(text, /notes: \{ type/);
  assert.doesNotMatch(text, /description/);
  const kept = stripSchemaProps('`x`; const r = { notes: value ? "a" : "b" };');
  assert.deepEqual(kept.removed, { description: 0, title: 0, notes: 0 });
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
