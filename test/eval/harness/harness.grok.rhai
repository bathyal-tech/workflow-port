let meta = #{
    name: "roundtrip-harness",
    description: "Six one-way wfport conversion checks with hard gates and LLM judge",
    when_to_use: "Local eval only. Run via test/eval/run.mjs, never in CI or bun test.",
    phases: [
        #{ title: "Convert", detail: "one agent per directed conversion leg" },
        #{ title: "Judge", detail: "one independent judge per leg" },
    ],
};

let CONVERT_SCHEMA = #{
  "type": "object",
  "required": ["leg", "hardGate", "candidate"],
  "properties": #{
    "leg": #{ "type": "string" },
    "hardGate": #{ "type": "string", "enum": ["pass", "fail"] },
    "candidate": #{ "type": "string" },
    "gapsFixed": #{ "type": "array", "items": #{ "type": "string" } },
    "gapsWaived": #{ "type": "array", "items": #{ "type": "string" } },
    "detail": #{ "type": "string" },
  },
};

let JUDGE_SCHEMA = #{
  "type": "object",
  "required": ["leg", "overall", "findings"],
  "properties": #{
    "leg": #{ "type": "string" },
    "work": #{ "type": "string", "enum": ["pass", "fail"] },
    "roles": #{ "type": "string", "enum": ["pass", "fail"] },
    "schemas": #{ "type": "string", "enum": ["pass", "fail"] },
    "dialect": #{ "type": "string", "enum": ["pass", "fail"] },
    "overall": #{ "type": "string", "enum": ["pass", "fail"] },
    "findings": #{ "type": "string" },
  },
};

fn convertPrompt(leg, seed, target, candidate, report) {
    let text = "Leg " + leg + ": convert " + seed + " to " + target + ". Use the wfport skill. Never convert by hand and never edit the seed. ";
    text += "Step 1: from the repo root run exactly: bun bin/cli.mjs " + seed + " --to " + target + " --out " + candidate + " --report " + report + " (exit 2 means gaps need your fixes, not failure). ";
    text += "Step 2: read the JSON gap report. Fix the candidate for EVERY gap by kind: agentType inline the role from test/eval/agents files (for Grok targets put capability_mode on EVERY agent call: read-only when the agent file tools are read-only, all otherwise; never drop it); schema keep only type/enum/required/properties/items for Muse and re-quote as a map for Grok; prompt carry interpolation exactly (Rhai plain + for string variables, json_encode only for non-string values); meta for a Claude target write phases as title/detail objects and remove stale source-dialect header comments; parallel rebuild in the target fan-out shape; control-flow preserve every branch on args; capability derive from the agent file tools; model drop pins. ";
    text += "Step 3: run bun bin/cli.mjs verify " + candidate + " --format agent and fix until no ERROR lines. Step 4: return hardGate pass only when verify is error-free and every gap is fixed or waived with a reason.";
    text
}

fn judgePrompt(leg, seed, candidate, report) {
    let text = "Judge leg " + leg + " only. Read the seed " + seed + ", the candidate " + candidate + ", and the gap report " + report + " yourself. You never see converter reasoning. The gap report is the raw pre-fix CLI report, so a listed gap may already be fixed in the candidate: score the candidate, not the report. ";
    text += "Score four axes pass/fail with evidence: work (same calls, branches, terminal result), roles (same roles and capability), schemas (same fields, phases, labels, meta name), dialect (valid idiomatic target). overall is pass only when all four pass. Name the exact missing behavior for every fail.";
    text
}

phase("Convert");
log("six one-way conversion legs");

let conversions = parallel([
    #{ prompt: convertPrompt("claude-to-muse", "test/eval/seeds/seed.claude.js", "muse", "test/eval/out/claude-to-muse/seed.muse.js", "test/eval/out/claude-to-muse/report.json"), label: "convert:claude-muse", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
    #{ prompt: convertPrompt("claude-to-grok", "test/eval/seeds/seed.claude.js", "grok", "test/eval/out/claude-to-grok/seed.grok.rhai", "test/eval/out/claude-to-grok/report.json"), label: "convert:claude-grok", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
    #{ prompt: convertPrompt("muse-to-claude", "test/eval/seeds/seed.muse.js", "claude", "test/eval/out/muse-to-claude/seed.claude.js", "test/eval/out/muse-to-claude/report.json"), label: "convert:muse-claude", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
    #{ prompt: convertPrompt("muse-to-grok", "test/eval/seeds/seed.muse.js", "grok", "test/eval/out/muse-to-grok/seed.grok.rhai", "test/eval/out/muse-to-grok/report.json"), label: "convert:muse-grok", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
    #{ prompt: convertPrompt("grok-to-claude", "test/eval/seeds/seed.grok.rhai", "claude", "test/eval/out/grok-to-claude/seed.claude.js", "test/eval/out/grok-to-claude/report.json"), label: "convert:grok-claude", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
    #{ prompt: convertPrompt("grok-to-muse", "test/eval/seeds/seed.grok.rhai", "muse", "test/eval/out/grok-to-muse/seed.muse.js", "test/eval/out/grok-to-muse/report.json"), label: "convert:grok-muse", capability_mode: "all", phase: "Convert", output_schema: CONVERT_SCHEMA },
]);

phase("Judge");
log("independent judge per leg");

let verdicts = parallel([
    #{ prompt: judgePrompt("claude-to-muse", "test/eval/seeds/seed.claude.js", "test/eval/out/claude-to-muse/seed.muse.js", "test/eval/out/claude-to-muse/report.json"), label: "judge:claude-muse", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
    #{ prompt: judgePrompt("claude-to-grok", "test/eval/seeds/seed.claude.js", "test/eval/out/claude-to-grok/seed.grok.rhai", "test/eval/out/claude-to-grok/report.json"), label: "judge:claude-grok", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
    #{ prompt: judgePrompt("muse-to-claude", "test/eval/seeds/seed.muse.js", "test/eval/out/muse-to-claude/seed.claude.js", "test/eval/out/muse-to-claude/report.json"), label: "judge:muse-claude", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
    #{ prompt: judgePrompt("muse-to-grok", "test/eval/seeds/seed.muse.js", "test/eval/out/muse-to-grok/seed.grok.rhai", "test/eval/out/muse-to-grok/report.json"), label: "judge:muse-grok", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
    #{ prompt: judgePrompt("grok-to-claude", "test/eval/seeds/seed.grok.rhai", "test/eval/out/grok-to-claude/seed.claude.js", "test/eval/out/grok-to-claude/report.json"), label: "judge:grok-claude", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
    #{ prompt: judgePrompt("grok-to-muse", "test/eval/seeds/seed.grok.rhai", "test/eval/out/grok-to-muse/seed.muse.js", "test/eval/out/grok-to-muse/report.json"), label: "judge:grok-muse", capability_mode: "read-only", phase: "Judge", output_schema: JUDGE_SCHEMA },
]);

complete(#{ conversions: conversions, verdicts: verdicts });
