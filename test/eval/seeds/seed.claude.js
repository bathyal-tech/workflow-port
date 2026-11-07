export const meta = {
  name: "seed-audit",
  description: "Canonical eval seed: inventory, parallel review, optional fix",
  whenToUse: "Eval seed only — the same run exists once per dialect for wfport conversion checks.",
  phases: [
    { title: "Bootstrap", detail: "inventory the target" },
    { title: "Review", detail: "review two axes in parallel" },
    { title: "Fix", detail: "optional fix when args.fix is set" },
  ],
};

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

const bootstrap = await agent(
  `Inventory the layout of ${topic}. List the main directories and entry points.`,
  {
    agentType: "seed-runner",
    phase: "Bootstrap",
    label: "bootstrap",
    schema: RESULT_SCHEMA,
  },
);

phase("Review");
const reviews = await parallel([
  () =>
    agent(`Review ${topic} for correctness. Report concrete defects only.`, {
      agentType: "readonly-reviewer",
      phase: "Review",
      label: "review:correctness",
      schema: RESULT_SCHEMA,
    }),
  () =>
    agent(`Review ${topic} for test coverage. Report untested behavior only.`, {
      agentType: "readonly-reviewer",
      phase: "Review",
      label: "review:tests",
      schema: RESULT_SCHEMA,
    }),
]);

phase("Fix");
let fix = "skipped";
if (wantFix) {
  fix = await agent(`Apply the smallest fix for the confirmed findings in ${topic}.`, {
    agentType: "seed-fixer",
    phase: "Fix",
    label: "fix",
    schema: RESULT_SCHEMA,
  });
} else {
  log("fix skipped: args.fix is not set");
}

return { bootstrap, reviews, fix };
