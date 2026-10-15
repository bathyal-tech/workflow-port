# workflow-port

Convert [Claude Workflow](https://docs.claude.com) scripts (`.claude/workflows/*.js`)
to [Muse](https://muse.ai) Workflow scripts or Grok Build (`.grok/workflows/*.rhai`,
[vendor reference](https://github.com/xai-org/grok-build)) scripts. Zero dependencies; Node ≥ 20.

It does **codemod + gap report**, not a silent semantic port: everything mechanical
is rewritten, and everything that needs a human decision is listed in a JSON report.

## Usage

```bash
node bin/cli.mjs path/to/workflow.js -o workflow.muse.js --report report.json
node bin/cli.mjs path/to/workflow.js --to grok -o workflow.rhai --report report.json
# without -o the converted source goes to stdout, the report to stderr
```

Exit 0 means a clean mechanical conversion; exit 2 means gaps need review.

## Mapping

The Claude source is first normalized to canonical facts — the `host.agent`
request shape (`input`, `label`, `phase`, `schema`, `model`, original
`agentType`). Both emitters derive from those facts.

| Canonical | Muse Workflow | Grok Build (Rhai) |
| --- | --- | --- |
| run shape | `export default async function workflow(host) { … }` | Rhai script, meta first |
| meta | `const meta` (name moves to launch) | `let meta = #{ name, description, when_to_use, phases: [#{ title }] }` |
| one agent | `host.agent({ input, ... })` | `agent(prompt, #{ label, capability_mode, output_schema, phase })` |
| fan-out | `host.parallel([requests])` | `parallel([#{ prompt, label, ... }])` (job list) |
| phase / log | `host.phase` / `host.log` | `phase` / `log` |
| custom agentType | `general-purpose` + report | `capability_mode` (`read-only` for reviewer-like types, else `all`) + report |
| schema | inline subset checked | `output_schema` (re-quote as `#{ "type": ... }`) + report |
| finish | `return { status, ref, text }` | `complete(#{ ... })` |

The Grok emitter emits a skeleton: meta and every agent call are lowered, but
JS control flow, interpolated prompts, and dynamically built parallel job
lists are flagged for hand translation — Rhai has no mechanical JS equivalent,
and Grok-only primitives (`await_user`, `pause`, `budget()`) have no source
counterpart to derive from.

## What the report flags

Custom `agentType`s (Muse only knows `general-purpose` / `workflow-subagent` —
inline the `.claude/agents/<name>.md` prompt by hand); schemas using keys Muse
inline schemas reject (`description`, `anyOf`, `$ref`, …) or over 4 KiB; dynamic
option objects; `Date.now` / `Math.random`; fan-out beyond ~15 children; missing
terminal `return { status, ref, text }`. The `--agents-dir` option (default: sibling
`../agents`) checks whether each custom type's agent file exists.

## Design note: one canonical language?

Grok has a third workflow dialect, so should there be one canonical definition with
the rest derived — or a new agnostic language? This tool's bet: **canonize the
strictest existing dialect (Muse's `host.agent` request-object form) and derive the
others from it**, rather than inventing a fourth language. Muse's form is the most
constrained (inline-schema subset, child caps, `result.ref` handoffs), so anything
expressible there lowers cleanly to Claude's looser form; the reverse needs exactly
the gap report this tool emits. A new agnostic DSL would also need to pick a side on
semantics that genuinely differ (parallel-null-on-throw, resume replay, schema
strictness) — that's a runtime project, not a converter. If a canonical IR emerges,
it should be Muse's module shape, with emitters, not a fresh syntax.

## Converted agents

`muse --agents <JSON>` exists but its schema isn't in the exported wire schema
(`muse schema generate-ts`), so converted agents ship as inlined prompts on
`general-purpose` calls — not as launch overlays — until that schema is published.

## Development

```bash
npm test   # node --test, fixture in test/fixtures/
```
