// Canonical eval seed (Muse dialect): inventory, parallel review, optional fix.
// Same run as seed.claude.js / seed.grok.rhai. Muse has no meta block and no
// custom agentTypes: roles are inlined into general-purpose prompts, and
// name/description are supplied at Workflow launch ("seed-audit").

const RESULT_SCHEMA = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "needs-fix"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
};

const input = args ?? {};
const topic = input.topic ?? "the repository";
const wantFix = input.fix === true;

phase("Bootstrap");
log(`auditing ${topic}`);

const bootstrap = await agent({
  input: `You are a mechanical runner. Do the bounded work step by step and report facts as structured data. Change nothing you were not asked to change.\n\nInventory the layout of ${topic}. List the main directories and entry points.`,
  agentType: "general-purpose",
  phase: "Bootstrap",
  label: "bootstrap",
  schema: RESULT_SCHEMA,
});

phase("Review");
const reviews = await parallel([
  {
    input: `You are a read-only reviewer. Read the target and report findings as structured data. Edit nothing and run no commands.\n\nReview ${topic} for correctness. Report concrete defects only.`,
    agentType: "general-purpose",
    phase: "Review",
    label: "review:correctness",
    schema: RESULT_SCHEMA,
  },
  {
    input: `You are a read-only reviewer. Read the target and report findings as structured data. Edit nothing and run no commands.\n\nReview ${topic} for test coverage. Report untested behavior only.`,
    agentType: "general-purpose",
    phase: "Review",
    label: "review:tests",
    schema: RESULT_SCHEMA,
  },
]);

phase("Fix");
let fix = "skipped";
if (wantFix) {
  fix = await agent({
    input: `You are the fixer. Apply the smallest fix for the confirmed finding in your brief and report what changed. Change nothing else.\n\nApply the smallest fix for the confirmed findings in ${topic}.`,
    agentType: "general-purpose",
    phase: "Fix",
    label: "fix",
    schema: RESULT_SCHEMA,
  });
} else {
  log("fix skipped: args.fix is not set");
}

const status = wantFix ? "needs-fix" : "ok";
const text = `audited ${topic}: bootstrap, 2 reviews, fix ${wantFix ? "applied" : "skipped"}`;
return { status: status, ref: bootstrap, text: text, reviews: reviews, fix: fix };
