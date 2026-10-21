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
  assert.match(code, /return \{ r, pair \};/);
  // No wrapper gap (body shape recognized), no meta gap (carried meta restored).
  assert.ok(!report.gaps.some((g) => g.kind === "wrapper"));
  assert.ok(!report.gaps.some((g) => g.kind === "meta"));
  assert.equal(report.metaName, "sweep");
  assert.ok(report.gaps.some((g) => g.kind === "agentType"));
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
