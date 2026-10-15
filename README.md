# workflow-port

Convert [Claude Workflow](https://docs.claude.com) scripts
(`.claude/workflows/*.js`) to
[Muse Workflow](https://muse.ai) scripts or
[Grok Build](https://github.com/xai-org/grok-build) (`.grok/workflows/*.rhai`)
scripts. Zero runtime dependencies; runs on [Bun](https://bun.sh).

It does **codemod + gap report**, not a silent semantic port: everything
mechanical is rewritten, and everything that needs a human decision is listed
in a JSON report.

## Install

Download the single binary for your platform from
[GitHub Releases](https://github.com/bathyal-tech/workflow-port/releases) —
no runtime to install:

```bash
# example: linux x64
curl -L -o wfport \
  https://github.com/bathyal-tech/workflow-port/releases/latest/download/wfport-linux-x64
chmod +x wfport
./wfport --help
```

Or run from source with Bun:

```bash
bun install
bun bin/cli.mjs path/to/workflow.js -o workflow.muse.js --report report.json
```

## Usage

```bash
wfport path/to/workflow.js -o workflow.muse.js --report report.json
wfport path/to/workflow.js --to grok -o workflow.rhai --report report.json
# without -o the converted source goes to stdout, the report to stderr
```

Exit 0 means a clean mechanical conversion; exit 2 means gaps need review.

## Mapping

The Claude source is first normalized to canonical facts — the `host.agent`
request shape (`input`, `label`, `phase`, `schema`, `model`, original
`agentType`). Both emitters derive from those facts.

| Canonical        | Muse Workflow                                        | Grok Build (Rhai)                                                            |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| run shape        | `export default async function workflow(host) { … }` | Rhai script, meta first                                                      |
| meta             | `const meta` (name moves to launch)                  | `let meta = #{ name, description, when_to_use, phases: [#{ title }] }`       |
| one agent        | `host.agent({ input, ... })`                         | `agent(prompt, #{ label, capability_mode, output_schema, phase })`           |
| fan-out          | `host.parallel([requests])`                          | `parallel([#{ prompt, label, ... }])` (job list)                             |
| phase / log      | `host.phase` / `host.log`                            | `phase` / `log`                                                              |
| custom agentType | `general-purpose` + report                           | `capability_mode` (`read-only` for reviewer-like types, else `all`) + report |
| schema           | inline subset checked                                | `output_schema` (re-quote as `#{ "type": ... }`) + report                    |
| finish           | `return { status, ref, text }`                       | `complete(#{ ... })`                                                         |

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
terminal `return { status, ref, text }`. The `--agents-dir` option (default:
sibling `../agents`) checks whether each custom type's agent file exists.

## Design note: one canonical language?

Grok has a third workflow dialect, so should there be one canonical definition
with the rest derived — or a new agnostic language? This tool's bet:
**canonize the strictest existing dialect (Muse's `host.agent` request-object
form) and derive the others from it**, rather than inventing a fourth language.
Muse's form is the most constrained (inline-schema subset, child caps,
`result.ref` handoffs), so anything expressible there lowers cleanly to
Claude's looser form; the reverse needs exactly the gap report this tool emits.
A new agnostic DSL would also need to pick a side on semantics that genuinely
differ (parallel-null-on-throw, resume replay, schema strictness) — that's a
runtime project, not a converter. If a canonical IR emerges, it should be
Muse's module shape, with emitters, not a fresh syntax.

## Converted agents

`muse --agents <JSON>` exists but its schema isn't in the exported wire schema
(`muse schema generate-ts`), so converted agents ship as inlined prompts on
`general-purpose` calls — not as launch overlays — until that schema is
published.

## Development

```bash
bun install   # install dependencies
bun test      # run the test suite (fixture in test/fixtures/)
bun run verify  # format check + lint + typecheck + tests
bun run build   # compile the single-file binary to dist/wfport
bun run build:all  # cross-compile release binaries for all targets
```

Verification is set up with:

- [tsgo](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`)
  for typechecking JSDoc-annotated JavaScript (`bun run typecheck`)
- [oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting
  (`bun run format`, `bun run format:check`)
- [oxlint](https://oxc.rs/docs/guide/usage/linter) for linting (`bun run lint`)
- [Husky](https://typicode.github.io/husky/) +
  [lint-staged](https://github.com/lint-staged/lint-staged) for the pre-commit
  hook, and [commitlint](https://commitlint.js.org/) with the
  [conventional commits](https://www.conventionalcommits.org/) preset for
  commit-message linting

## Prior art and references

- [jscodeshift](https://github.com/facebook/jscodeshift) — the classic JS
  codemod toolkit; this tool's Muse emitter follows the same rewrite-plus-review
  philosophy on a narrower domain
- [Bun single-file executables](https://bun.sh/docs/bundler/executables) —
  how the release binaries are built
- [TypeScript-Go (tsgo)](https://github.com/microsoft/typescript-go) — the
  native typechecker behind `bun run typecheck`
- [Oxc](https://oxc.rs/) — the toolchain behind oxlint and oxfmt
- [Claude Code docs](https://docs.claude.com) and
  [grok-build](https://github.com/xai-org/grok-build) — the source and target
  workflow dialects

## Built with Muse

This package — the Bun migration, the verification setup (Husky,
commitlint, lint-staged, tsgo, oxlint, oxfmt), the release automation, and
this documentation — was built entirely with
[Muse Code](https://muse.ai), an agentic coding assistant, working from a
short brief. Every change went through the same gates a human contributor
hits: `bun run verify` (format, lint, typecheck, tests), conventional-commit
message linting, and pre-commit hooks. The converter logic itself is
intentionally conservative: it rewrites what is mechanical and reports what
needs a person, and the assistant that built it worked the same way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs run the full gate on Linux and
macOS plus binary smoke tests; releases go through the `release` workflow
(run it from Actions with the next version — never push tags by hand).
Security issues: [SECURITY.md](SECURITY.md). Participation follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — copyright held by bathyal-tech contributors.
