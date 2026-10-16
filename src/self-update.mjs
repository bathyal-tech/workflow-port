// Self-update for the wfport distribution, mirroring the Codex CLI flow:
// on every invocation the CLI checks GitHub Releases for a newer version.
// When one is available it asks: update now, skip once, or skip until the
// next version. Updating replaces the running binary and exits, so the user
// reruns their command on the new version.
//
// Only the compiled release binaries self-update. Checkouts run from source
// (`bun`/`node bin/cli.mjs`) skip the check — there is no installed binary
// to replace. The check never touches stdout (converted source goes there)
// and never fails the run: network errors silently skip the check.

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { VERSION } from "./version.mjs";

/** GitHub repo that hosts the release binaries. */
export const DEFAULT_REPO = "bathyal-tech/workflow-port";

/** Network timeout for the release check; failures skip the check silently. */
export const CHECK_TIMEOUT_MS = 3000;

/**
 * @typedef {object} UpdateInfo
 * @property {string} current currently running version
 * @property {string} latest newest released version
 * @property {string} notesUrl release page for the update
 * @property {string | null} assetUrl download URL for this platform, if shipped
 * @property {string | null} assetName expected asset file name, if this platform is shipped
 */

/**
 * @typedef {import("node:stream").Readable & { isTTY?: boolean }} PromptInput
 */

/**
 * @param {string} value
 * @returns {{ core: number[], pre: string | null }}
 */
function parseVersion(value) {
  const withoutBuild = value.trim().replace(/^[vV]/, "").split("+")[0] ?? "";
  const [coreText, ...preParts] = /** @type {string} */ (withoutBuild).split("-");
  const core = (coreText ?? "").split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const pre = preParts.length > 0 ? preParts.join("-") : null;
  return { core, pre };
}

/**
 * Compare two version strings: -1 when a < b, 0 when equal, 1 when a > b.
 * Numeric core parts compare numerically; a prerelease sorts below its release.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Asset file name for a platform/arch pair, matching bin/build-all.mjs output.
 * Null when that platform is not shipped and must update manually.
 * @param {{ platform?: string, arch?: string }} [options]
 * @returns {string | null}
 */
export function getAssetName({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32" && arch === "x64") return "wfport-windows-x64.exe";
  if (platform === "linux" && arch === "x64") return "wfport-linux-x64";
  if (platform === "linux" && arch === "arm64") return "wfport-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "wfport-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "wfport-darwin-arm64";
  return null;
}

/**
 * Path of the state file remembering "skip until next version".
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getStatePath(env = process.env) {
  if (env.WFPORT_CONFIG_DIR) return join(env.WFPORT_CONFIG_DIR, "update-state.json");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "wfport", "update-state.json");
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "wfport", "update-state.json");
}

/**
 * Version the user dismissed with "skip until next version", if any.
 * @param {string} [statePath]
 * @returns {string | null}
 */
export function getSkippedVersion(statePath = getStatePath()) {
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = /** @type {unknown} */ (JSON.parse(raw));
    const version =
      parsed != null && typeof parsed === "object" && "skipUntilVersion" in parsed
        ? /** @type {Record<string, unknown>} */ (parsed).skipUntilVersion
        : null;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Remember a "skip until next version" dismissal. Best effort: never throws.
 * @param {string} version
 * @param {string} [statePath]
 * @returns {void}
 */
export function setSkippedVersion(version, statePath = getStatePath()) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ skipUntilVersion: version }) + "\n");
  } catch {
    // A dismissal that cannot persist just prompts again next time.
  }
}

/**
 * Whether argv names a bundled runtime instead of an installed binary.
 * @param {string} execPath
 * @returns {boolean}
 */
function isRuntimeExecPath(execPath) {
  const base = execPath
    .split("/")
    .pop()
    ?.split("\\")
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  return base === "bun" || base === "node" || base === "deno" || base === "qjs";
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isEnabled(value) {
  return value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Whether this invocation should check for updates: never for help/version,
 * never when opted out, and never when running from source (no installed
 * binary exists to replace).
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @returns {boolean}
 */
export function shouldCheck(
  argv = process.argv.slice(2),
  env = process.env,
  execPath = process.execPath,
) {
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("--version")) return false;
  if (argv.includes("--no-update-check")) return false;
  if (isEnabled(env.WFPORT_NO_UPDATE_CHECK)) return false;
  if (isEnabled(env.WFPORT_FORCE_UPDATE_CHECK)) return true;
  return !isRuntimeExecPath(execPath);
}

/**
 * @typedef {object} CheckOptions
 * @property {string} [currentVersion]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [repo]
 * @property {string} [apiUrl]
 * @property {number} [timeoutMs]
 * @property {string} [statePath]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {NodeJS.Architecture} [arch]
 */

/**
 * Query the latest GitHub release. Returns null when up to date, when the
 * latest was dismissed, or when the check fails for any reason.
 * @param {CheckOptions} [options]
 * @returns {Promise<UpdateInfo | null>}
 */
export async function checkForUpdate({
  currentVersion = VERSION,
  fetchImpl = globalThis.fetch,
  env = process.env,
  repo = env.WFPORT_UPDATE_REPO ?? DEFAULT_REPO,
  apiUrl = env.WFPORT_RELEASES_API_URL ?? `https://api.github.com/repos/${repo}/releases/latest`,
  timeoutMs = CHECK_TIMEOUT_MS,
  statePath = getStatePath(env),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  let res;
  try {
    res = await fetchImpl(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `wfport/${currentVersion}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let release;
  try {
    release = /** @type {Record<string, unknown>} */ (await res.json());
  } catch {
    return null;
  }
  const tag = typeof release.tag_name === "string" ? release.tag_name : null;
  const latest = tag ? tag.trim().replace(/^[vV]/, "") : null;
  if (!latest || compareVersions(latest, currentVersion) <= 0) return null;
  const skipped = getSkippedVersion(statePath);
  if (skipped && compareVersions(latest, skipped) <= 0) return null;
  const notesUrl =
    typeof release.html_url === "string" && release.html_url.length > 0
      ? release.html_url
      : `https://github.com/${repo}/releases/latest`;
  const assetName = getAssetName({ platform, arch });
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const match = assets.find(
    (asset) =>
      asset != null &&
      typeof asset === "object" &&
      /** @type {Record<string, unknown>} */ (asset).name === assetName,
  );
  const downloadUrl =
    match != null &&
    typeof (/** @type {Record<string, unknown>} */ (match).browser_download_url) === "string"
      ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (match).browser_download_url)
      : null;
  return {
    current: currentVersion,
    latest,
    notesUrl,
    assetUrl:
      downloadUrl ??
      (assetName ? `https://github.com/${repo}/releases/latest/download/${assetName}` : null),
    assetName,
  };
}

/**
 * Ask about an available update, codex-style: update now, skip once, or
 * skip until the next version. Anything but an explicit "1"/"3" skips once.
 * @param {UpdateInfo} info
 * @param {object} [options]
 * @param {PromptInput} [options.input]
 * @param {import("node:stream").Writable} [options.output]
 * @returns {Promise<"update" | "skip" | "skip-version">}
 */
export async function promptForUpdate(
  info,
  { input = process.stdin, output = process.stderr } = {},
) {
  output.write(`\n✨ Update available! ${info.current} -> ${info.latest}\n`);
  output.write(`   Release notes: ${info.notesUrl}\n`);
  if (info.assetUrl) output.write("   1) Update now (exits — rerun wfport after updating)\n");
  output.write("   2) Skip\n");
  output.write("   3) Skip until next version\n");
  const rl = createInterface({ input, output, terminal: false });
  try {
    const answer = (await rl.question("   Choice [1/2/3] (default 2): ")).trim();
    if (answer === "1" && info.assetUrl) return "update";
    if (answer === "3") return "skip-version";
    return "skip";
  } finally {
    rl.close();
  }
}

/**
 * Download the update asset and atomically replace the running binary.
 * @param {UpdateInfo} info
 * @param {object} [options]
 * @param {string} [options.execPath]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<void>}
 */
export async function applyUpdate(
  info,
  { execPath = process.execPath, fetchImpl = globalThis.fetch } = {},
) {
  if (!info.assetUrl)
    throw new Error(`no update asset ships for this platform — see ${info.notesUrl}`);
  const res = await fetchImpl(info.assetUrl, {
    headers: { "User-Agent": `wfport/${info.current}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("downloaded update is empty");
  const tmp = `${execPath}.update-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    try {
      chmodSync(tmp, 0o755);
    } catch {
      // Best effort: Windows ignores POSIX modes.
    }
    renameSync(tmp, execPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort cleanup.
    }
    throw new Error(
      `cannot replace ${execPath} (${/** @type {Error} */ (err).message}) — download ${info.assetName ?? "the binary"} from ${info.notesUrl}`,
    );
  }
}

/**
 * @typedef {object} MaybeSelfUpdateOptions
 * @property {string[]} [argv]
 * @property {string} [execPath]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {PromptInput} [input]
 * @property {import("node:stream").Writable} [output]
 * @property {boolean} [interactive] override TTY detection (tests)
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [apiUrl]
 * @property {string} [statePath]
 */

/**
 * Run the startup update check. Resolves "continue" to run the CLI,
 * "updated" after a successful update (the caller exits so the user reruns),
 * or "update-failed" when the chosen update could not be applied.
 * @param {MaybeSelfUpdateOptions} [options]
 * @returns {Promise<"continue" | "updated" | "update-failed">}
 */
export async function maybeSelfUpdate({
  argv = process.argv.slice(2),
  execPath = process.execPath,
  env = process.env,
  input = process.stdin,
  output = process.stderr,
  interactive = input.isTTY === true,
  fetchImpl = globalThis.fetch,
  apiUrl = env.WFPORT_RELEASES_API_URL,
  statePath = getStatePath(env),
} = {}) {
  if (!shouldCheck(argv, env, execPath)) return "continue";
  const info = await checkForUpdate({
    fetchImpl,
    apiUrl,
    statePath,
    env,
  }).catch(() => null);
  if (!info) return "continue";
  if (!interactive) {
    output.write(
      `wfport: update available: ${info.current} -> ${info.latest} — see ${info.notesUrl}\n`,
    );
    return "continue";
  }
  const choice = await promptForUpdate(info, { input, output }).catch(() => "skip");
  if (choice === "skip-version") {
    setSkippedVersion(info.latest, statePath);
    return "continue";
  }
  if (choice === "skip") return "continue";
  try {
    await applyUpdate(info, { execPath, fetchImpl });
  } catch (err) {
    output.write(`wfport: update failed: ${/** @type {Error} */ (err).message}\n`);
    return "update-failed";
  }
  output.write(`wfport: updated ${info.current} -> ${info.latest}. Please rerun your command.\n`);
  return "updated";
}
