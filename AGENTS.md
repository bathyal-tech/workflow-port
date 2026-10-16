# AGENTS.md

## Commands

- `bun install` - install dependencies
- `bun test` - run the full test suite
- `bun run verify` - format check + lint + typecheck + tests (the full gate)
- `bun run typecheck` - typecheck JSDoc-annotated JS with tsgo
- `bun run lint` - lint with oxlint
- `bun run format` / `bun run format:check` - format / check with oxfmt
- `bun run build` - compile the single-file binary to `dist/wfport`
- `bun run build:all` - cross-compile release binaries for all targets

## Code Map

- `src` - application source
- `test` - automated tests (`*.test.mjs`, fixture in `test/fixtures/`)
- `bin/cli.mjs` - the `wfport` CLI entry point (also the compile target)
- `bin/build-all.mjs` - cross-compiles release binaries into `dist/`

## Conventions

- Bun for everything: runtime, tests, scripts, and `bun build --compile` releases.
- Write modules as ES modules using the `.mjs` extension.
- Name test files with the `*.test.mjs` pattern.
- JSDoc-annotate all functions; `tsgo --noEmit` must pass with zero errors.
- Conventional commits (enforced by commitlint); pre-commit runs lint-staged.
- Releases via the `release` workflow (dispatch with the next version);
  `main` is protected — work lands through PRs with the CI gate green.
