#!/usr/bin/env node
/**
 * Prove a freshly packed binary actually works before it reaches the registry.
 *
 * Run once per CI matrix leg, right after pack-native.js:
 *   node scripts/verify-native.js --triple darwin-arm64
 *
 * `pack-native.js` only proves a file was copied. This proves the file
 * dlopens, exports the ABI the loader expects, and returns real process
 * output. That distinction matters because every failure mode downstream of
 * here is silent: a binary that cannot load makes `loadBinding()` fall through
 * to the JS path, so a broken publish looks exactly like a healthy one until
 * someone measures spawn latency in production.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { findTarget, packageNameFor } from './targets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { triple: '', outDir: join(ROOT, 'npm') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--triple') args.triple = argv[++i] ?? '';
    else if (argv[i] === '--out-dir') args.outDir = resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

// The binding takes a whole command line and runs it through the platform
// shell (`/bin/sh -c`, or `cmd /C` on Windows), so `echo` is spelled the same
// way on every target.
const PROBE = 'echo toris-ok';

async function main() {
  const { triple, outDir } = parseArgs(process.argv.slice(2));
  if (!triple) throw new Error('--triple is required');

  const target = findTarget(triple);
  if (!target) throw new Error(`Unknown triple: ${triple}`);

  // Load the packed artifact, not the build tree, so this checks the exact
  // bytes that will be published.
  const binary = join(outDir, `native-${triple}`, `toris-native.${triple}.node`);
  const binding = require(binary);

  if (typeof binding?.spawnCaptured !== 'function') {
    throw new Error(
      `${packageNameFor(triple)} loaded but does not export spawnCaptured() — ` +
        'the loader would reject it and fall back to JS',
    );
  }

  const result = await binding.spawnCaptured(PROBE, { timeoutMs: 10_000 });

  if (result.exitCode !== 0) {
    throw new Error(`probe exited ${result.exitCode}: ${result.stderr}`);
  }
  if (!String(result.stdout).includes('toris-ok')) {
    throw new Error(`probe stdout lacked the marker: ${JSON.stringify(result.stdout)}`);
  }

  const info = typeof binding.nativeInfo === 'function' ? binding.nativeInfo() : 'unknown';
  console.log(`verified ${packageNameFor(triple)} — ${info}`);
}

main().catch((err) => {
  console.error(`verify-native failed: ${err.message}`);
  process.exit(1);
});
