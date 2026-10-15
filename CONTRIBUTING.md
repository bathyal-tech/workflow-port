# Contributing

Thanks for helping with workflow-port. This project keeps the bar high and
the process light: small, well-described pull requests that pass the automated
gates get reviewed.

## How to contribute

1. Fork the repo and create a branch from `main`.
2. Install [Bun](https://bun.sh) and run `bun install`.
3. Make your change, then run the full gate: `bun run verify`
   (oxfmt check, oxlint, `tsgo --noEmit`, tests).
4. Write commits in [conventional commits](https://www.conventionalcommits.org/)
   style — commit-message linting is enforced, and
   [release-please](https://github.com/googleapis/release-please) turns those
   messages into the changelog and version bumps, so `feat:` and `fix:`
   prefixes matter.
5. Open a pull request against `main` using the template. CI runs the gate on
   Linux and macOS, smoke-tests the compiled binary, and verifies all release
   targets still cross-compile.

First-time contributors: GitHub requires maintainer approval before Actions
run on your PR — that is normal abuse protection, not suspicion. A maintainer
will approve the run and review.

## What good PRs look like

- One logical change per PR, with tests in `test/*.test.mjs` covering new
  behavior.
- JSDoc on every new function — `bun run typecheck` must stay at zero errors.
- No new runtime dependencies without discussion in the PR (the distributed
  binary stays lean by staying dependency-free).
- Security-sensitive changes (anything touching the release workflow,
  attestations, or published assets) get extra scrutiny; see
  [SECURITY.md](SECURITY.md).

## Releases

Releases have two human-gated steps. First, open a version PR that bumps
`version` in `package.json` (conventional-commit subjects since the last tag
become the notes, so keep them accurate). After it merges, run the `release`
workflow from Actions with that same version: it re-verifies the tree, tags,
builds all five `wfport` binaries, attaches SLSA build-provenance
attestations, and publishes the GitHub Release. Never push tags by hand —
let the pipeline do it.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
