import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convert, splitTopLevel } from "../src/convert.mjs";
import { emitGrok, extractFacts } from "../src/grok.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "fixtures", "sample.workflow.js.txt"), "utf8");

test("mechanical mapping: wrapper, host.agent, host.phase/log/parallel", () => {
  const { code } = convert(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /export default async function workflow\(host\)/);
  assert.match(code, /host\.agent\(\{ input: `Do the thing/);
  assert.match(code, /host\.phase\("Bootstrap"\)/);
  assert.match(code, /host\.log\("starting"\)/);
  assert.match(code, /host\.parallel\(\[/);
  assert.match(code, /schema: RESULT_SCHEMA/);
});

test("custom agentType is rewritten and reported", () => {
  const { code, report } = convert(sample, { inputName: "sample.workflow.js" });
  assert.match(code, /agentType: "general-purpose" \/\* was: "bg-fix"/);
  assert.match(code, /agentType: "general-purpose" \/\* was: "readonly-reviewer"/);
  const values = report.agentTypes.map((a) => a.value).sort();
  assert.deepEqual(values, ["bg-fix", "readonly-reviewer"]);
});

test("schema with description is flagged", () => {
  const { report } = convert(sample, { inputName: "sample.workflow.js" });
  const schema = report.schemas.find((s) => s.name === "RESULT_SCHEMA");
  assert.ok(schema.issues.some((i) => i.includes('"description"')));
  assert.ok(report.gaps.some((g) => g.kind === "schema"));
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
  assert.match(code, /host\.agent\(\{ input: p, \.\.\.agentOptions\(spec, spec\.label\) \}\)/);
  assert.ok(report.gaps.some((g) => g.kind === "dynamic-options"));
});
