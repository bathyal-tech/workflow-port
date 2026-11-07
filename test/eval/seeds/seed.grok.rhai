let meta = #{
    name: "seed-audit",
    description: "Canonical eval seed: inventory, parallel review, optional fix",
    when_to_use: "Eval seed only. Same run as the Claude and Muse seeds.",
    phases: [
        #{ title: "Bootstrap", detail: "inventory the target" },
        #{ title: "Review", detail: "review two axes in parallel" },
        #{ title: "Fix", detail: "optional fix when args.fix is set" },
    ],
};

let RESULT_SCHEMA = #{
  "type": "object",
  "required": ["status", "summary"],
  "properties": #{
    "status": #{ "type": "string", "enum": ["ok", "needs-fix"] },
    "summary": #{ "type": "string" },
    "findings": #{ "type": "array", "items": #{ "type": "string" } },
  },
};

let input = if args != () { args } else { #{} };
let topic = if input.topic != () { input.topic } else { "the repository" };
let wantFix = input.fix == true;

phase("Bootstrap");
log("auditing " + topic);

let bootstrap = agent(
    "Inventory the layout of " + topic + ". List the main directories and entry points.",
    #{ label: "bootstrap", agent_type: "seed-runner", capability_mode: "all", phase: "Bootstrap", output_schema: RESULT_SCHEMA },
);

phase("Review");
let reviews = parallel([
    #{ prompt: "Review " + topic + " for correctness. Report concrete defects only.", label: "review:correctness", agent_type: "readonly-reviewer", capability_mode: "read-only", phase: "Review", output_schema: RESULT_SCHEMA },
    #{ prompt: "Review " + topic + " for test coverage. Report untested behavior only.", label: "review:tests", agent_type: "readonly-reviewer", capability_mode: "read-only", phase: "Review", output_schema: RESULT_SCHEMA },
]);

phase("Fix");
let fix = "skipped";
if wantFix {
    fix = agent(
        "Apply the smallest fix for the confirmed findings in " + topic + ".",
        #{ label: "fix", agent_type: "seed-fixer", capability_mode: "all", phase: "Fix", output_schema: RESULT_SCHEMA },
    );
} else {
    log("fix skipped: args.fix is not set");
}

complete(#{ bootstrap: bootstrap, reviews: reviews, fix: fix });
