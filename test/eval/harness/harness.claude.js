export const meta = {
  name: "roundtrip-harness",
  description: "Six one-way wfport conversion checks with hard gates and LLM judge",
  whenToUse: "Local eval only — run via test/eval/run.mjs, never in CI or bun test.",
  phases: [
    { title: "Convert", detail: "one agent per directed conversion leg" },
    { title: "Judge", detail: "one independent judge per leg" },
  ],
};

const CONVERT_SCHEMA = {
  type: "object",
  required: ["leg", "hardGate", "candidate"],
  properties: {
    leg: { type: "string" },
    hardGate: { type: "string", enum: ["pass", "fail"] },
    candidate: { type: "string" },
    gapsFixed: { type: "array", items: { type: "string" } },
    gapsWaived: { type: "array", items: { type: "string" } },
    detail: { type: "string" },
  },
};

const JUDGE_SCHEMA = {
  type: "object",
  required: ["leg", "overall", "findings"],
  properties: {
    leg: { type: "string" },
    work: { type: "string", enum: ["pass", "fail"] },
    roles: { type: "string", enum: ["pass", "fail"] },
    schemas: { type: "string", enum: ["pass", "fail"] },
    dialect: { type: "string", enum: ["pass", "fail"] },
    overall: { type: "string", enum: ["pass", "fail"] },
    findings: { type: "string" },
  },
};

function convertPrompt(leg, source, target, seed, candidate, report) {
  return [
    `Leg ${leg}: convert ${seed} from ${source} to ${target}. Use the wfport skill. Never convert by hand and never edit the seed.`,
    `Step 1: from the repo root run exactly: bun bin/cli.mjs ${seed} --to ${target} --out ${candidate} --report ${report} (exit 2 means gaps need your fixes, not failure).`,
    "Step 2: read the JSON gap report. Fix the candidate file for EVERY gap by kind:",
    '- agentType: inline the role text from test/eval/agents/<name>.md into the target form (Muse: prepend to the general-purpose prompt; Grok: agent_type plus capability_mode on EVERY call — "read-only" when the agent file tools are read-only, "all" otherwise; never drop capability_mode).',
    "- schema/output_schema: keep only type/enum/required/properties/items for Muse; for Grok re-quote as a #{ } map; never point output_schema at an options object.",
    "- prompt: carry interpolation exactly (JS template literal; Rhai plain + for string variables, json_encode only for non-string values — strip json_encode the CLI wrapped around a plain string variable such as topic); do not drop interpolated values.",
    "- meta: for a Claude target write phases as { title, detail } objects, never bare strings, and remove stale source-dialect header comments from the candidate.",
    "- parallel: rebuild in the target fan-out shape (Claude thunks, Muse request objects with input, Grok #{ prompt } job maps).",
    "- control-flow: translate every branch/loop preserving conditions on args; do not flatten conditionals away.",
    "- capability_mode/capability: derive from the agent file tools list, never guess.",
    "- model: drop model pins (the session route inherits).",
    `Step 3: run bun bin/cli.mjs verify ${candidate} --format agent and fix until it prints no ERROR lines. Step 4: return CONVERT_SCHEMA with hardGate pass only when verify is error-free and every gap is in gapsFixed or gapsWaived with a reason in detail.`,
  ].join("\n");
}

function judgePrompt(leg, seed, candidate, report) {
  return [
    `Judge leg ${leg} only. Read the seed ${seed}, the candidate ${candidate}, and the gap report ${report} yourself. Do not trust the converter: you never see its reasoning, only these files. The gap report is the raw pre-fix CLI report, so a gap it lists may already be fixed in the candidate — score the candidate, not the report.`,
    "Score four axes pass/fail with evidence in findings: work (same calls, branches on args, and terminal result), roles (same agent roles/prompts and read-only vs write capability), schemas (same schema fields, phases, labels, meta name), dialect (valid idiomatic target dialect, no leftover source-dialect syntax).",
    "overall is pass only when all four axes pass. Name the exact missing or altered behavior for every fail.",
  ].join("\n");
}

phase("Convert");
log("six one-way conversion legs");

const conversions = await parallel([
  () =>
    agent(
      convertPrompt(
        "claude-to-muse",
        "claude",
        "muse",
        "test/eval/seeds/seed.claude.js",
        "test/eval/out/claude-to-muse/seed.muse.js",
        "test/eval/out/claude-to-muse/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:claude-muse",
        schema: CONVERT_SCHEMA,
      },
    ),
  () =>
    agent(
      convertPrompt(
        "claude-to-grok",
        "claude",
        "grok",
        "test/eval/seeds/seed.claude.js",
        "test/eval/out/claude-to-grok/seed.grok.rhai",
        "test/eval/out/claude-to-grok/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:claude-grok",
        schema: CONVERT_SCHEMA,
      },
    ),
  () =>
    agent(
      convertPrompt(
        "muse-to-claude",
        "muse",
        "claude",
        "test/eval/seeds/seed.muse.js",
        "test/eval/out/muse-to-claude/seed.claude.js",
        "test/eval/out/muse-to-claude/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:muse-claude",
        schema: CONVERT_SCHEMA,
      },
    ),
  () =>
    agent(
      convertPrompt(
        "muse-to-grok",
        "muse",
        "grok",
        "test/eval/seeds/seed.muse.js",
        "test/eval/out/muse-to-grok/seed.grok.rhai",
        "test/eval/out/muse-to-grok/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:muse-grok",
        schema: CONVERT_SCHEMA,
      },
    ),
  () =>
    agent(
      convertPrompt(
        "grok-to-claude",
        "grok",
        "claude",
        "test/eval/seeds/seed.grok.rhai",
        "test/eval/out/grok-to-claude/seed.claude.js",
        "test/eval/out/grok-to-claude/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:grok-claude",
        schema: CONVERT_SCHEMA,
      },
    ),
  () =>
    agent(
      convertPrompt(
        "grok-to-muse",
        "grok",
        "muse",
        "test/eval/seeds/seed.grok.rhai",
        "test/eval/out/grok-to-muse/seed.muse.js",
        "test/eval/out/grok-to-muse/report.json",
      ),
      {
        agentType: "seed-runner",
        phase: "Convert",
        label: "convert:grok-muse",
        schema: CONVERT_SCHEMA,
      },
    ),
]);

phase("Judge");
log("independent judge per leg");

const verdicts = await parallel([
  () =>
    agent(
      judgePrompt(
        "claude-to-muse",
        "test/eval/seeds/seed.claude.js",
        "test/eval/out/claude-to-muse/seed.muse.js",
        "test/eval/out/claude-to-muse/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:claude-muse",
        schema: JUDGE_SCHEMA,
      },
    ),
  () =>
    agent(
      judgePrompt(
        "claude-to-grok",
        "test/eval/seeds/seed.claude.js",
        "test/eval/out/claude-to-grok/seed.grok.rhai",
        "test/eval/out/claude-to-grok/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:claude-grok",
        schema: JUDGE_SCHEMA,
      },
    ),
  () =>
    agent(
      judgePrompt(
        "muse-to-claude",
        "test/eval/seeds/seed.muse.js",
        "test/eval/out/muse-to-claude/seed.claude.js",
        "test/eval/out/muse-to-claude/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:muse-claude",
        schema: JUDGE_SCHEMA,
      },
    ),
  () =>
    agent(
      judgePrompt(
        "muse-to-grok",
        "test/eval/seeds/seed.muse.js",
        "test/eval/out/muse-to-grok/seed.grok.rhai",
        "test/eval/out/muse-to-grok/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:muse-grok",
        schema: JUDGE_SCHEMA,
      },
    ),
  () =>
    agent(
      judgePrompt(
        "grok-to-claude",
        "test/eval/seeds/seed.grok.rhai",
        "test/eval/out/grok-to-claude/seed.claude.js",
        "test/eval/out/grok-to-claude/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:grok-claude",
        schema: JUDGE_SCHEMA,
      },
    ),
  () =>
    agent(
      judgePrompt(
        "grok-to-muse",
        "test/eval/seeds/seed.grok.rhai",
        "test/eval/out/grok-to-muse/seed.muse.js",
        "test/eval/out/grok-to-muse/report.json",
      ),
      {
        agentType: "readonly-reviewer",
        phase: "Judge",
        label: "judge:grok-muse",
        schema: JUDGE_SCHEMA,
      },
    ),
]);

return { conversions, verdicts };
