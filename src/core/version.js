/**
 * The single source of truth for the running `toris` version.
 *
 * There are two ways the code ships. Installed from npm or run from the repo,
 * `package.json` sits on disk a couple of directories up and `createRequire`
 * reads it. Built as a standalone SEA binary, there is no `package.json` on the
 * user's machine at all — it is embedded into the executable as an asset at
 * build time (see scripts/build-sea.js), and `node:sea` hands it back.
 *
 * Centralising this keeps every surface (banner, `version`, `update`, chat
 * receipts) reporting the same string, and keeps the SEA-vs-disk branch in one
 * place instead of four.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {{name:string, version:string} | undefined} */
let cached;

/** @returns {{name:string, version:string}} the running build's manifest fields */
function manifest() {
  if (cached) return cached;

  // A standalone binary answers from the embedded asset; nothing is on disk.
  try {
    const sea = require('node:sea');
    if (sea.isSea?.()) {
      const pkg = JSON.parse(sea.getAsset('package.json', 'utf8'));
      cached = { name: pkg.name, version: pkg.version };
      return cached;
    }
  } catch {
    // node:sea is unavailable or the asset is missing — fall through to disk.
  }

  const pkg = require('../../package.json');
  cached = { name: pkg.name, version: pkg.version };
  return cached;
}

/** @returns {string} the semver of the running build */
export function torisVersion() {
  return manifest().version;
}

/** @returns {string} the published package name */
export function torisName() {
  return manifest().name;
}
