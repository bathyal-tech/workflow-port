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

Or run from source with [Bun](https://bun.sh):

```bash
bun install
bun bin/cli.mjs --help
```

## Use the CLI

Run `--help` for the full argument list; do not guess flags:

```bash
wfport --help
wfport --version
```

Typical runs:

```bash
wfport path/to/workflow.js --out workflow.muse.js --report report.json
wfport path/to/workflow.js --to grok --out workflow.rhai --report report.json
wfport .grok/workflows/flow.rhai -o muse --out flow.muse.js
```

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
