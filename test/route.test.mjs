import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource, resolveTarget } from "../src/route.mjs";

const CLAUDE_SRC = 'export const meta = { name: "x" };\nconst r = await agent("hi");\nreturn r;\n';
const MUSE_SRC =
  "export default async function workflow(host) {\n  const r = await host.agent({ input: `hi ${x}` });\n  return r;\n}\n";
const GROK_SRC = 'let meta = #{\n    name: "x",\n};\ncomplete(#{ status: "done" });\n';

test("explicit --input wins over path and content", () => {
  assert.equal(detectSource("flow.rhai", CLAUDE_SRC, "claude"), "claude");
  assert.equal(detectSource(".claude/workflows/flow.js", GROK_SRC, "grok"), "grok");
});

test("input dialect is inferred from the path", () => {
  assert.equal(detectSource("w/flow.rhai", CLAUDE_SRC, null), "grok");
  assert.equal(detectSource(".grok/workflows/flow.rhai", CLAUDE_SRC, null), "grok");
  assert.equal(detectSource(".claude/workflows/flow.js", GROK_SRC, null), "claude");
  assert.equal(detectSource("muse/flow.muse.js", CLAUDE_SRC, null), "muse");
});

test("input dialect is sniffed from content", () => {
  assert.equal(detectSource("workflows/flow.js", CLAUDE_SRC, null), "claude");
  assert.equal(detectSource("workflows/flow.js", MUSE_SRC, null), "muse");
  assert.equal(detectSource("workflows/flow.txt", GROK_SRC, null), "grok");
  assert.equal(detectSource("workflows/flow.js", "const x = 1;\n", null), "claude");
});

test("claude inputs default to muse", () => {
  assert.equal(resolveTarget("claude", null), "muse");
  assert.equal(resolveTarget("claude", "grok"), "grok");
});

test("non-claude inputs require an explicit target", () => {
  assert.throws(() => resolveTarget("muse", null), /requires.*-o\/--output/);
  assert.throws(() => resolveTarget("grok", undefined), /requires.*-o\/--output/);
  assert.equal(resolveTarget("muse", "grok"), "grok");
  assert.equal(resolveTarget("grok", "claude"), "claude");
});

test("same source and target is rejected", () => {
  assert.throws(() => resolveTarget("claude", "claude"), /nothing to convert/);
  assert.throws(() => resolveTarget("grok", "bogus"), /unknown target/);
});
