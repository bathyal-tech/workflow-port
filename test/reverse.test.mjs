import { test } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../src/convert.mjs";
import { emitGrok, emitGrokFromFacts, extractFacts, extractGrokFacts } from "../src/grok.mjs";
import { extractMuseFacts, emitMuseFromFacts } from "../src/muse.mjs";
import { convertMuseToClaude, emitClaudeFromFacts } from "../src/claude.mjs";

const MUSE_SRC = `export default async function workflow(host) {
  host.phase("Bootstrap");
  host.log("starting");
  const first = await host.agent({ input: "Do it", agentType: "general-purpose", label: "first" });
  const pair = await host.parallel([{ input: "A", label: "a" }, { input: "B" }]);
  return { status: "ok", ref: first, text: "done" };
}
`;

const GROK_SRC = `let meta = #{
    name: "sweep",
    description: "A sweep.",
    when_to_use: "Test only.",
    phases: [#{ title: "Bootstrap" }],
};
let r1 = agent(
    "First prompt",
    #{ label: "first", capability_mode: "read-only", phase: "Bootstrap" },
);
complete(#{ status: "done" });
`;

test("claude->muse->claude: stripped schema keys round-trip via wfport:preserve", () => {
  const claudeSrc = [
    'export const meta = { name: "s", description: "d", whenToUse: "w", phases: [] };',
    "const RESULT_SCHEMA = {",
    '  type: "object",',
    '  description: "top-level schema note",',
    '  required: ["status"],',
    "  properties: {",
    '    status: { type: "string", enum: ["ok"], description: "probe status" },',
    '    count: { type: "integer", minimum: 1 },',
    '    description: { type: "string" },',
    "  },",
    "};",
    'const r = await agent("hi", { label: "x", schema: RESULT_SCHEMA });',
    "return { status: r, ref: r, text: r };",
  ].join("\n");
  const muse = convert(claudeSrc, { inputName: "roundtrip.claude.js" });
  // Muse output cannot carry the keys, but records them for the way back.
  assert.match(muse.code, /\/\/ wfport:preserve-v1 begin/);
  assert.match(muse.code, /\/\/ wfport:preserve \{.*"schema":"RESULT_SCHEMA".*"key":"description"/);
  const schemaText = muse.code.slice(muse.code.indexOf("const RESULT_SCHEMA"));
  assert.doesNotMatch(schemaText.slice(0, schemaText.indexOf("};")), /description: "probe status"/);
  assert.doesNotMatch(schemaText.slice(0, schemaText.indexOf("};")), /minimum/);

  const back = convertMuseToClaude(muse.code, { inputName: "roundtrip.muse.js" });
  assert.match(back.code, /description: "top-level schema note"/);
  assert.match(back.code, /description: "probe status"/);
  assert.match(back.code, /minimum: 1/);
  // The field *named* description survives as a field, exactly once as a keyword restore.
  assert.match(back.code, /description: \{ type: "string" \}/);
  assert.doesNotMatch(back.code, /wfport:preserve/);
  assert.doesNotMatch(back.code, /museDispatchArgs|museSchema/);

  // And the cycle is idempotent: converting back to Muse re-records them.
  const again = convert(back.code, { inputName: "roundtrip2.claude.js" });
  assert.match(again.code, /\/\/ wfport:preserve \{.*"key":"description"/);
});

test("muse->claude: stale preserve entries report a gap, target code wins", () => {
  const src = [
    "// wfport:preserve-v1 begin",
    '// wfport:preserve {"kind":"schema-key","schema":"GONE_SCHEMA","path":[],"key":"description","valueSrc":"\\"lost\\""}',
    "// wfport:preserve-v1 end",
    'const r = await agent({ input: "hi", agentType: "general-purpose", label: "x" });',
    'return { status: "ok", ref: r, text: "done" };',
  ].join("\n");
  const { code, report } = convertMuseToClaude(src, { inputName: "stale.muse.js" });
  assert.doesNotMatch(code, /wfport:preserve/);
  assert.ok(report.gaps.some((g) => g.kind === "preserve" && /GONE_SCHEMA/.test(g.detail)));
});

test("muse->claude: wrapper unwrapped, calls lowered, control flow kept", () => {
  const { code, report } = convertMuseToClaude(MUSE_SRC, { inputName: "flow.muse.js" });
  assert.doesNotMatch(code, /export default async function workflow\(host\)/);
  assert.doesNotMatch(code, /host\.agent/);
  assert.match(code, /export const meta = \{/);
  assert.match(code, /agent\("Do it", \{ agentType: "general-purpose", label: "first" \}\)/);
  assert.match(
    code,
    /parallel\(\[\(\) => agent\("A", \{ label: "a" \}\), \(\) => agent\("B"\)\]\)/,
  );
  assert.match(code, /phase\("Bootstrap"\)/);
  assert.match(code, /log\("starting"\)/);
  assert.match(code, /return \{ status: "ok", ref: first, text: "done" \};/);
  assert.equal(report.source, "muse");
  assert.equal(report.target, "claude");
  assert.equal(report.agentCallSites, 1);
  assert.equal(report.parallelCallSites, 1);
  assert.ok(report.gaps.some((g) => g.kind === "meta"));
  assert.ok(report.gaps.some((g) => g.kind === "agentType"));
});

test("muse facts feed the grok emitter without false capability gaps", () => {
  const facts = extractMuseFacts(MUSE_SRC);
  assert.equal(facts.calls.length, 1);
  assert.equal(facts.calls[0].agentType, "general-purpose");
  assert.equal(facts.parallelSites, 1);
  const { code, gaps } = emitGrokFromFacts(facts, {
    inputName: "flow.muse.js",
    sourceName: "Muse Workflow",
  });
  assert.match(code, /Muse Workflow flow\.muse\.js/);
  assert.match(code, /capability_mode: "all"/);
  assert.ok(!gaps.some((g) => g.kind === "capability_mode"));
  assert.ok(gaps.some((g) => g.kind === "parallel"));
  // claude facts for the same shape also stay quiet on known muse types
  const claudeFacts = extractFacts(
    'const r = await agent("hi", { agentType: "general-purpose" });\nreturn r;\n',
  );
  const again = emitGrokFromFacts(claudeFacts, {});
  assert.ok(!again.gaps.some((g) => g.kind === "capability_mode"));
});

test("muse inline schema is flagged for grok", () => {
  const facts = extractMuseFacts(
    "export default async function workflow(host) {\n" +
      '  const r = await host.agent({ input: "hi", schema: { type: "object" } });\n' +
      "  return r;\n}\n",
  );
  assert.equal(facts.calls[0].schemaInline, true);
  const { gaps } = emitGrokFromFacts(facts, {});
  assert.ok(gaps.some((g) => g.kind === "output_schema"));
});

test("grok facts: meta, labels, capability, terminal complete", () => {
  const facts = extractGrokFacts(GROK_SRC);
  assert.equal(facts.meta?.name, "sweep");
  assert.equal(facts.meta?.whenToUse, "Test only.");
  assert.deepEqual(facts.meta?.phases, ["Bootstrap"]);
  assert.equal(facts.calls.length, 1);
  assert.equal(facts.calls[0].label, "first");
  assert.equal(facts.calls[0].capability, "read-only");
  assert.equal(facts.hasReturn, true);
});

test("grok->muse: labels pass through, read-only and schema need review", () => {
  const facts = extractGrokFacts(GROK_SRC);
  const { code, gaps } = emitMuseFromFacts(facts, { inputName: "flow.rhai" });
  // V1 body shape: no wrapper, no export, bare agent call.
  assert.doesNotMatch(code, /export default async function workflow\(host\)/);
  assert.doesNotMatch(code, /^\s*export\b/m);
  assert.match(code, /agent\(\{ input: "First prompt", label: "first", phase: "Bootstrap" \}\)/);
  assert.match(code, /^return \{ status: "converted", ref: r1, text: "converted" \};/m);
  assert.ok(gaps.some((g) => g.kind === "meta"));
  assert.ok(gaps.some((g) => g.kind === "capability"));
  assert.ok(gaps.some((g) => g.kind === "control-flow"));
  assert.ok(!gaps.some((g) => g.kind === "return"));
});

test("muse body->claude: choke unwrapped, shims stripped, meta restored", () => {
  const { code: museCode } = convert(
    'export const meta = { name: "sweep", description: "d", whenToUse: "w", phases: [] };\n' +
      'const r = await agent("Do it", { agentType: "bg-fix", label: "first" });\n' +
      'const pair = await parallel([() => agent("A", { label: "a" })]);\n' +
      "return { r, pair };\n",
    { inputName: "sweep.js" },
  );
  const { code, report } = convertMuseToClaude(museCode, { inputName: "sweep.muse.js" });
  assert.doesNotMatch(code, /museDispatchArgs|museResult|MUSE_ROLE_FOR/);
  assert.doesNotMatch(code, /host\./);
  assert.match(code, /export const meta = \{/);
  assert.match(code, /agent\("Do it", \{ agentType: "bg-fix", label: "first" \}\)/);
  assert.match(code, /parallel\(\[\(\) => agent\("A", \{ label: "a" \}\)\]\)/);
  // The Muse leg inserted a classified status for its terminal shape; it rides back.
  assert.match(code, /return \{ status: museClassifyStatus\(\[r, pair\]\), r, pair \};/);
  // The classifier definition survives the helper strip (it is plain JS).
  assert.match(code, /const museClassifyStatus = /);
  // No wrapper gap (body shape recognized), no meta gap (carried meta restored).
  assert.ok(!report.gaps.some((g) => g.kind === "wrapper"));
  assert.ok(!report.gaps.some((g) => g.kind === "meta"));
  assert.equal(report.metaName, "sweep");
  assert.ok(report.gaps.some((g) => g.kind === "agentType"));
});

test("grok facts: inline parallel job maps are calls", () => {
  const src = [
    'let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [#{ title: "Review" }] };',
    'let a = agent("First", #{ label: "first" });',
    'let pair = parallel([#{ prompt: "A", label: "a", capability_mode: "read-only" }, #{ prompt: "B", label: "b" }]);',
    "complete(#{ a: a, pair: pair });",
    "",
  ].join("\n");
  const facts = extractGrokFacts(src);
  assert.equal(facts.calls.length, 3);
  assert.equal(facts.calls.filter((c) => c.inParallel).length, 2);
  assert.equal(facts.calls[1].label, "a");
  assert.equal(facts.calls[1].capability, "read-only");
});

test("grok facts: commented and duplicate inline job maps survive", () => {
  const src = [
    'let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [] };',
    "let pair = parallel([",
    "  // correctness axis",
    '  #{ prompt: "A", label: "a" }, // trailing note',
    '  /* tests axis */ #{ prompt: "A", label: "a" },',
    "]);",
    "complete(#{ pair: pair });",
    "",
  ].join("\n");
  const facts = extractGrokFacts(src);
  assert.equal(facts.calls.length, 2);
  assert.notEqual(facts.calls[0].start, facts.calls[1].start);
});

test("grok facts: push builds ignore comments, lookalikes, and resets", () => {
  const src = [
    'let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [] };',
    "let jobs = [];",
    'jobs.push(#{ prompt: "stale", label: "stale" });',
    "jobs = [];",
    'myjobs.push(#{ prompt: "nope", label: "nope" });',
    '// jobs.push(#{ prompt: "ghost", label: "ghost" });',
    'jobs.push(#{ prompt: "real", label: "real" });',
    "let pair = parallel(jobs);",
    "complete(#{ pair: pair });",
    "",
  ].join("\n");
  const facts = extractGrokFacts(src);
  assert.deepEqual(
    facts.calls.map((c) => c.label),
    ["real"],
  );
});

test("grok facts: job-map fields are not read from the prompt string", () => {
  const src = [
    'let meta = #{ name: "s", description: "d", when_to_use: "w", phases: [] };',
    'let pair = parallel([#{ prompt: "set output_schema: Foo before running", output_schema: RESULT_SCHEMA, label: "real" }, #{ prompt: "hello label: ", label: "second" }]);',
    "complete(#{ pair: pair });",
    "",
  ].join("\n");
  const facts = extractGrokFacts(src);
  assert.equal(facts.calls[0].schema, "RESULT_SCHEMA");
  assert.equal(facts.calls[0].label, "real");
  assert.equal(facts.calls[1].label, "second");
});

test("muse body->claude: bare request objects are lowered", () => {
  const src = [
    'const first = await agent({ input: "Do it", agentType: "general-purpose", label: "first" });',
    'return { status: "ok", ref: first, text: "done" };',
    "",
  ].join("\n");
  const { code } = convertMuseToClaude(src, { inputName: "body.muse.js" });
  assert.match(code, /agent\("Do it", \{ agentType: "general-purpose", label: "first" \}\)/);
  assert.doesNotMatch(code, /agent\(\{ input:/);
});

test("muse body facts: choke-routed calls recover prompt and options", () => {
  const { code } = convert(
    'const r = await agent("Do it", { agentType: "bg-fix" });\nreturn r;\n',
    {
      inputName: "s.js",
    },
  );
  const facts = extractMuseFacts(code);
  assert.equal(facts.calls.length, 1);
  assert.equal(facts.calls[0].promptSrc, '"Do it"');
  assert.equal(facts.calls[0].agentType, "bg-fix");
});

test("grok->claude: meta synthesized, calls lowered, result returned", () => {
  const facts = extractGrokFacts(GROK_SRC);
  const { code, gaps } = emitClaudeFromFacts(facts, { inputName: "flow.rhai" });
  assert.match(code, /export const meta = \{/);
  assert.match(code, /name: "sweep",/);
  assert.match(code, /whenToUse: "Test only\.",/);
  assert.match(
    code,
    /const r1 = await agent\("First prompt", \{ label: "first", phase: "Bootstrap" \}\);/,
  );
  assert.match(code, /return \{ result: r1 \};/);
  assert.ok(gaps.some((g) => g.kind === "capability"));
  assert.ok(!gaps.some((g) => g.kind === "return"));
});

test("claude->muse report carries the routing fields", () => {
  const { report } = convert('export const meta = { name: "x" };\nreturn 1;\n', {
    inputName: "f.js",
  });
  assert.equal(report.metaName, "x");
  assert.ok(Array.isArray(report.gaps));
});

test("grok emitter wrapper keeps its legacy shape", () => {
  const { code, facts, gaps } = emitGrok(
    'export const meta = { name: "x" };\nconst r = await agent("hi");\nreturn r;\n',
    { inputName: "f.js" },
  );
  assert.match(code, /Claude Workflow f\.js/);
  assert.equal(facts.calls.length, 1);
  assert.ok(Array.isArray(gaps));
});
