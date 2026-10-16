---
name: wfport
description: Convert workflow scripts between Claude, Muse, and Grok dialects using the wfport CLI.
---

# wfport

Use the `wfport` CLI to convert a workflow script from any dialect
(`claude`, `muse`, `grok`) to another. It does codemod plus a JSON gap
report: mechanical rewrites are applied, and anything needing a human
decision is listed in the report. Do not reimplement the conversion by
hand; always run the CLI.

## Get the CLI

Download the single binary for your platform from GitHub Releases (no
runtime to install):

- `https://github.com/bathyal-tech/workflow-port/releases`

Assets per release:

- `wfport-linux-x64`
- `wfport-linux-arm64`
- `wfport-darwin-x64`
- `wfport-darwin-arm64`
- `wfport-windows-x64.exe`

```bash
# example: linux x64
curl -L -o wfport \
  https://github.com/bathyal-tech/workflow-port/releases/latest/download/wfport-linux-x64
chmod +x wfport
./wfport --help
```

Or run from source with [Bun](https://bun.sh) from a checkout of the
tool repo:

```bash
git clone https://github.com/bathyal-tech/workflow-port.git
cd workflow-port
bun install
bun bin/cli.mjs --help
```

## Use the CLI

Run `--help` for the full argument list; do not guess flags:

```bash
wfport --help
wfport --version
```

Typical runs (from the project that owns the workflow, not from `/tmp`):

```bash
wfport .claude/workflows/toil-block.js --out .muse/workflows/toil-block.js --report /tmp/toil-block.report.json
wfport .claude/workflows/plan.js --to grok --out .grok/workflows/plan.rhai --report /tmp/plan.report.json
wfport .grok/workflows/flow.rhai -o muse --out .muse/workflows/flow.js
```

## Where to write the output

Mirror the source path into the target dialect's directory, keeping the
base name:

- `.claude/workflows/<name>.js` → `.muse/workflows/<name>.js`
  (Claude → Muse)
- `.claude/workflows/<name>.js` → `.grok/workflows/<name>.rhai`
  (Claude → Grok)
- `.grok/workflows/<name>.rhai` → `.muse/workflows/<name>.js`
  (Grok → Muse)

Pass the mirrored path via `--out` so the finished artifact lands as an
unstaged file inside the project under conversion — never in `/tmp`.
Leave it unstaged so the user can diff and test it before committing.

Done means both: the converted file is placed at its mirrored path,
and the gap report has been read with every gap surfaced to the user.

Notes:

- Input dialect (`-i`, `--input`, `--from`) is inferred from the path
  and file content when omitted, defaulting to `claude`.
- Target dialect (`-o`, `--output`, `--to`) defaults to `muse` for
  `claude` inputs and is required otherwise.
- Without `--out`, converted source goes to stdout; without `--report`,
  the gap report JSON goes to stderr.
- Exit codes: `0` clean conversion, `1` usage or config error,
  `2` gaps need review. Always read the gap report and surface its
  gaps to the user instead of silently ignoring them.
