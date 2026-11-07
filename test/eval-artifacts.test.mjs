import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyWorkflow } from "../src/verify.mjs";
import { detectSource } from "../src/route.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The LLM eval itself is local-only (test/eval/run.mjs); this test only
// guarantees the six seed/harness artifacts stay syntactically valid in
// their dialects so they cannot rot between local runs.
const FILES = [
  "eval/seeds/seed.claude.js",
  "eval/seeds/seed.muse.js",
  "eval/seeds/seed.grok.rhai",
  "eval/harness/harness.claude.js",
  "eval/harness/harness.muse.js",
  "eval/harness/harness.grok.rhai",
];

for (const rel of FILES) {
  test(`eval artifact verifies clean: ${rel}`, () => {
    const path = join(here, rel);
    const source = readFileSync(path, "utf8");
    const dialect = detectSource(path, source, null);
    const agentsDir = join(here, "eval", "agents");
    const result = verifyWorkflow(source, dialect, { agentsDir });
    assert.deepEqual(
      result.errors.map((e) => `${e.code}: ${e.message}`),
      [],
      `${rel} (${dialect}) must verify with no errors`,
    );
    assert.ok(result.stats.agentCalls > 0, `${rel} must dispatch agents`);
  });
}
