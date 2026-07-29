#!/usr/bin/env node
/**
 * Build the native crate and install it where the loader will find it.
 *
 * `cargo build` alone leaves the artifact in `crates/toris-native/target/`,
 * which `loadBinding()` does not look at — it checks the prebuilt npm package
 * and then `build/toris-native.<triple>.node`. So a plain cargo build appears to
 * succeed while the process keeps silently running the JS fallback, and the
 * failure mode is invisible: everything still works, only slower. Copying the
 * artifact into place is the step that makes a local build actually take effect.
 *
 *   node scripts/build-native.js            # release build for this host
 *   node scripts/build-native.js --debug    # faster compile, slower binary
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { platformTriple } from '../src/native/index.js';
import { findTarget } from './targets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'crates', 'toris-native', 'Cargo.toml');

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { debug: false };
  for (const arg of argv) {
    if (arg === '--debug') args.debug = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const { debug } = parseArgs(process.argv.slice(2));
  const triple = platformTriple();
  const target = findTarget(triple);
  if (!target) {
    // Not a failure: these platforms are meant to run the fallback.
    console.log(`${triple} has no prebuild target — the JS fallback covers it.`);
    return;
  }

  const profile = debug ? 'debug' : 'release';
  const cargoArgs = ['build', '--manifest-path', MANIFEST];
  if (!debug) cargoArgs.push('--release');

  const build = spawnSync('cargo', cargoArgs, { stdio: 'inherit' });
  if (build.error) throw new Error(`cargo not runnable: ${build.error.message}`);
  if (build.status !== 0) throw new Error(`cargo build failed (exit ${build.status})`);

  const from = join(ROOT, 'crates', 'toris-native', 'target', profile, target.dylib);
  const outDir = join(ROOT, 'build');
  const to = join(outDir, `toris-native.${triple}.node`);

  mkdirSync(outDir, { recursive: true });
  copyFileSync(from, to);
  console.log(`installed ${profile} build -> build/toris-native.${triple}.node`);
}

try {
  main();
} catch (err) {
  console.error(`build-native failed: ${err.message}`);
  process.exit(1);
}
