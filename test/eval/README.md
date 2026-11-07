# Conversion eval (local only)

Six one-way `wfport` conversion checks with hard gates and an LLM
judge. Design record: [docs/roundtrip-harness.md](../../docs/roundtrip-harness.md).

- `seeds/` — one canonical workflow (`seed-audit`) hand-written per
  dialect; each seed sources its two outbound legs.
- `harness/` — the same test workflow per dialect: six conversion
  agents (via the installed `wfport` skill), then six independent
  judge agents. A leg passes only on clean `wfport verify`, all
  gaps fixed or waived, and all four judge axes passing.
- `agents/` — role files the seeds reference.
- `run.mjs` — launcher. Probes `PATH` for `claude`/`grok`/`muse`,
  checks the `wfport` skill per host, launches each available
  host’s harness on its floating-latest model, and writes a merged
  report to `out/` (git-ignored). No host or no skill is a skip.

```bash
bun run eval -- --dry-run   # probes only, launches nothing
bun run eval                # launch every available host
bun run eval -- --only muse # one host
```

Never runs in CI or `bun test`; CI only verifies the six files
parse (`wfport verify`). Launch templates can be overridden with
`WFPORT_EVAL_<HOST>_CMD` (`{harness}` is substituted).
