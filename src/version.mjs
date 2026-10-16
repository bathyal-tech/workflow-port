import pkg from "../package.json" with { type: "json" };

/**
 * Current wfport version. Single source of truth is package.json; importing
 * it (instead of reading it from disk) keeps `--version` and the update
 * check working inside the compiled single-file binary.
 * @type {string}
 */
export const VERSION = pkg.version;
