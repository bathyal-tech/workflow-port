import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  applyUpdate,
  checkForUpdate,
  compareVersions,
  getAssetName,
  maybeSelfUpdate,
  promptForUpdate,
  shouldCheck,
} from "../src/self-update.mjs";
import { VERSION } from "../src/version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures", "sample.workflow.js.txt");

/**
 * Writable that collects everything written, for capturing prompt output.
 * @returns {{ stream: Writable, text: () => string }}
 */
function collector() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

/**
 * Readable preloaded with one answer line, standing in for a TTY.
 * @param {string} answer
 * @returns {PassThrough}
 */
function answerInput(answer) {
  const stream = new PassThrough();
  stream.write(answer);
  stream.end();
  return stream;
}

/**
 * Local stand-in for the GitHub Releases API plus one asset download.
 */
class ReleaseServer {
  /** @type {import("node:http").Server} */
  server;
  /** @type {string} */
  tag;
  /** @type {string} */
  binary;
  /** @type {string} */
  assetName;

  /**
   * @param {string} tag release tag, e.g. "v9.9.9"
   * @param {string} binary asset bytes to serve
   * @param {string} assetName asset file name to advertise
   */
  constructor(tag, binary, assetName) {
    this.tag = tag;
    this.binary = binary;
    this.assetName = assetName;
    this.server = createServer((req, res) => {
      const base = `http://127.0.0.1:${this.port()}`;
      if (req.url === "/latest") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tag_name: this.tag,
            html_url: `${base}/notes`,
            assets: [{ name: this.assetName, browser_download_url: `${base}/dl` }],
          }),
        );
      } else if (req.url === "/dl") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(this.binary);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  }

  /** @returns {Promise<string>} base URL of the server */
  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve(undefined)));
    return `http://127.0.0.1:${this.port()}`;
  }

  /** @returns {number} */
  port() {
    const addr = this.server.address();
    assert.ok(addr != null && typeof addr === "object");
    return addr.port;
  }

  /** @returns {Promise<void>} */
  async stop() {
    await new Promise((resolve) => this.server.close(() => resolve(undefined)));
  }

  /** @returns {string} */
  apiUrl() {
    return `http://127.0.0.1:${this.port()}/latest`;
  }
}

test("compareVersions orders releases, v-prefixes, and prereleases", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("0.2.0-alpha", "0.2.0"), -1);
});

test("getAssetName matches the build-all outputs and nulls unknown platforms", () => {
  assert.equal(getAssetName({ platform: "linux", arch: "x64" }), "wfport-linux-x64");
  assert.equal(getAssetName({ platform: "linux", arch: "arm64" }), "wfport-linux-arm64");
  assert.equal(getAssetName({ platform: "darwin", arch: "x64" }), "wfport-darwin-x64");
  assert.equal(getAssetName({ platform: "darwin", arch: "arm64" }), "wfport-darwin-arm64");
  assert.equal(getAssetName({ platform: "win32", arch: "x64" }), "wfport-windows-x64.exe");
  assert.equal(getAssetName({ platform: "win32", arch: "arm64" }), null);
});

test("shouldCheck skips help, version, opt-outs, and source runs", () => {
  const binary = "/usr/local/bin/wfport";
  assert.equal(shouldCheck(["--help"], {}, binary), false);
  assert.equal(shouldCheck(["--version"], {}, binary), false);
  assert.equal(shouldCheck(["--no-update-check", "flow.js"], {}, binary), false);
  assert.equal(shouldCheck(["flow.js"], { WFPORT_NO_UPDATE_CHECK: "1" }, binary), false);
  assert.equal(shouldCheck(["flow.js"], {}, "/opt/homebrew/bin/bun"), false);
  assert.equal(shouldCheck(["flow.js"], {}, "C:\\nodejs\\node.exe"), false);
  assert.equal(shouldCheck(["flow.js"], {}, binary), true);
  assert.equal(shouldCheck(["flow.js"], { WFPORT_FORCE_UPDATE_CHECK: "1" }, "/usr/bin/bun"), true);
});

test("checkForUpdate reports a newer release", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer("v9.9.9", "new-binary", getAssetName() ?? "wfport-test-asset");
  const base = await srv.start();
  t.after(() => srv.stop());
  const info = await checkForUpdate({
    currentVersion: "0.1.0",
    apiUrl: `${base}/latest`,
    statePath: join(dir, "state.json"),
    env: {},
  });
  assert.ok(info);
  assert.equal(info.latest, "9.9.9");
  assert.match(info.notesUrl, /notes/);
  assert.match(info.assetUrl ?? "", /\/dl$/);
});

test("checkForUpdate stays silent when current, dismissed, or unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer("v9.9.9", "new-binary", "wfport-linux-x64");
  const base = await srv.start();
  const dismissed = join(dir, "dismissed.json");
  writeFileSync(dismissed, JSON.stringify({ skipUntilVersion: "9.9.9" }) + "\n");
  try {
    assert.equal(
      await checkForUpdate({
        currentVersion: "9.9.9",
        apiUrl: `${base}/latest`,
        statePath: join(dir, "missing.json"),
        env: {},
      }),
      null,
    );
    assert.equal(
      await checkForUpdate({
        currentVersion: "0.1.0",
        apiUrl: `${base}/latest`,
        statePath: dismissed,
        env: {},
      }),
      null,
    );
    assert.equal(
      await checkForUpdate({
        currentVersion: "0.1.0",
        apiUrl: "http://127.0.0.1:1/latest",
        statePath: join(dir, "missing.json"),
        env: {},
        timeoutMs: 1000,
      }),
      null,
    );
  } finally {
    await srv.stop();
  }
});

test("prompt offers update, skip, and skip-until-next-version like codex", async () => {
  const info = {
    current: "0.1.0",
    latest: "0.2.0",
    notesUrl: "https://example.test/notes",
    assetUrl: "https://example.test/dl",
    assetName: "wfport-linux-x64",
  };
  const out1 = collector();
  assert.equal(
    await promptForUpdate(info, { input: answerInput("1\n"), output: out1.stream }),
    "update",
  );
  assert.match(out1.text(), /Update available! 0\.1\.0 -> 0\.2\.0/);
  assert.match(out1.text(), /Skip until next version/);

  const out2 = collector();
  assert.equal(
    await promptForUpdate(info, { input: answerInput("3\n"), output: out2.stream }),
    "skip-version",
  );
  const out3 = collector();
  assert.equal(
    await promptForUpdate(info, { input: answerInput("\n"), output: out3.stream }),
    "skip",
  );
  const out4 = collector();
  assert.equal(
    await promptForUpdate(
      { ...info, assetUrl: null, assetName: null },
      { input: answerInput("1\n"), output: out4.stream },
    ),
    "skip",
  );
});

test("update choice replaces the binary and exits for a rerun", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer(
    "v0.2.0",
    "wfport-0.2.0-binary",
    getAssetName() ?? "wfport-test-asset",
  );
  const base = await srv.start();
  t.after(() => srv.stop());
  const target = join(dir, "wfport");
  writeFileSync(target, "wfport-0.1.0-binary");
  const out = collector();
  const result = await maybeSelfUpdate({
    argv: [],
    execPath: target,
    env: {},
    input: answerInput("1\n"),
    output: out.stream,
    interactive: true,
    apiUrl: `${base}/latest`,
    statePath: join(dir, "state.json"),
  });
  assert.equal(result, "updated");
  assert.equal(readFileSync(target, "utf8"), "wfport-0.2.0-binary");
  assert.match(out.text(), /rerun/i);
});

test("skip-until-next-version persists and silences only that version", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer("v0.2.0", "wfport-0.2.0-binary", "wfport-test-asset");
  const base = await srv.start();
  t.after(() => srv.stop());
  const statePath = join(dir, "state.json");
  const target = join(dir, "wfport");
  writeFileSync(target, "wfport-0.1.0-binary");
  const out = collector();
  const result = await maybeSelfUpdate({
    argv: [],
    execPath: target,
    env: {},
    input: answerInput("3\n"),
    output: out.stream,
    interactive: true,
    apiUrl: `${base}/latest`,
    statePath,
  });
  assert.equal(result, "continue");
  assert.equal(readFileSync(target, "utf8"), "wfport-0.1.0-binary");
  assert.equal(
    await checkForUpdate({ currentVersion: "0.1.0", apiUrl: `${base}/latest`, statePath, env: {} }),
    null,
  );
});

test("applyUpdate swaps the executable bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer("v0.2.0", "replaced-bytes", "wfport-test-asset");
  await srv.start();
  t.after(() => srv.stop());
  const target = join(dir, "wfport");
  writeFileSync(target, "old-bytes");
  await applyUpdate(
    {
      current: "0.1.0",
      latest: "0.2.0",
      notesUrl: `${srv.apiUrl()}`,
      assetUrl: `http://127.0.0.1:${srv.port()}/dl`,
      assetName: "wfport-test-asset",
    },
    { execPath: target },
  );
  assert.equal(readFileSync(target, "utf8"), "replaced-bytes");
});

test("non-interactive runs print a notice and continue without updating", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const srv = new ReleaseServer("v0.2.0", "new-bytes", "wfport-test-asset");
  const base = await srv.start();
  t.after(() => srv.stop());
  const target = join(dir, "wfport");
  writeFileSync(target, "old-bytes");
  const out = collector();
  const result = await maybeSelfUpdate({
    argv: [],
    execPath: target,
    env: {},
    input: new PassThrough(),
    output: out.stream,
    interactive: false,
    apiUrl: `${base}/latest`,
    statePath: join(dir, "state.json"),
  });
  assert.equal(result, "continue");
  assert.equal(readFileSync(target, "utf8"), "old-bytes");
  assert.match(out.text(), /update available: 0\.1\.0 -> 0\.2\.0/);
});

test("CLI accepts --no-update-check and reports the embedded version", () => {
  const dir = mkdtempSync(join(tmpdir(), "wfport-update-"));
  const report = join(dir, "report.json");
  const converted = spawnSync(
    process.execPath,
    ["bin/cli.mjs", "--no-update-check", fixture, "--report", report],
    { cwd: root, encoding: "utf8", env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" } },
  );
  assert.equal(converted.status, 2);
  assert.equal(JSON.parse(readFileSync(report, "utf8")).source, "claude");
  const version = spawnSync(process.execPath, ["bin/cli.mjs", "--version"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WFPORT_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `wfport ${VERSION}`);
});
