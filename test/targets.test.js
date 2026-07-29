import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  TARGETS,
  NATIVE_SCOPE,
  packageNameFor,
  findTarget,
  optionalDependenciesFor,
} from '../scripts/targets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = async (...p) => JSON.parse(await readFile(join(ROOT, ...p), 'utf8'));

/**
 * These tests exist because the failure they guard against is invisible. npm
 * treats an unresolvable optionalDependency as success, so if the published
 * matrix and the declared optional deps ever disagree, users on the orphaned
 * platform get a working install that quietly runs the slow JS fallback
 * forever. Nothing crashes, no warning is printed. Only a pinned comparison
 * catches it.
 */

test('every target is fully specified', () => {
  for (const t of TARGETS) {
    assert.ok(t.triple, 'triple is required');
    assert.ok(t.rustTarget, `${t.triple}: rustTarget is required`);
    assert.ok(t.os, `${t.triple}: os is required`);
    assert.ok(t.cpu, `${t.triple}: cpu is required`);
    assert.ok(t.runner, `${t.triple}: runner is required`);
    assert.ok(t.dylib, `${t.triple}: dylib is required`);
  }
});

test('triples are unique', () => {
  const seen = new Set(TARGETS.map((t) => t.triple));
  assert.equal(seen.size, TARGETS.length, 'duplicate triple in TARGETS');
});

test('package.json optionalDependencies match TARGETS exactly', async () => {
  const pkg = await readJson('package.json');
  const declared = pkg.optionalDependencies ?? {};

  assert.deepEqual(
    Object.keys(declared).sort(),
    TARGETS.map((t) => packageNameFor(t.triple)).sort(),
    'optionalDependencies drifted from scripts/targets.js',
  );

  // A stale version pin is the same silent failure: the dep never resolves.
  for (const [name, range] of Object.entries(declared)) {
    assert.equal(range, pkg.version, `${name} is pinned to ${range}, not ${pkg.version}`);
  }
});

test('optionalDependenciesFor reproduces the declared block', async () => {
  const pkg = await readJson('package.json');
  assert.deepEqual(optionalDependenciesFor(pkg.version), pkg.optionalDependencies ?? {});
});

test('the release matrix covers every target', async () => {
  const yaml = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

  // Deliberately textual: pulling in a YAML parser to check five strings would
  // add a dependency to a project that currently has zero.
  const inMatrix = [...yaml.matchAll(/^\s*-\s*triple:\s*(\S+)\s*$/gm)].map((m) => m[1]);

  assert.deepEqual(
    inMatrix.sort(),
    TARGETS.map((t) => t.triple).sort(),
    'release.yml build matrix drifted from scripts/targets.js',
  );

  // Building a triple on the wrong runner produces a binary that packs fine
  // and then refuses to load on the user's machine.
  for (const t of TARGETS) {
    const leg = new RegExp(
      `-\\s*triple:\\s*${t.triple}\\s*\\n\\s*runner:\\s*${t.runner}\\s*\\n\\s*rust_target:\\s*${t.rustTarget}\\b`,
    );
    assert.match(yaml, leg, `${t.triple} leg must use ${t.runner} / ${t.rustTarget}`);
  }
});

test('package names are scoped and derived from the triple', () => {
  for (const t of TARGETS) {
    assert.equal(packageNameFor(t.triple), `${NATIVE_SCOPE}/native-${t.triple}`);
  }
});

test('findTarget round-trips known triples and rejects unknown ones', () => {
  for (const t of TARGETS) {
    assert.equal(findTarget(t.triple)?.rustTarget, t.rustTarget);
  }
  assert.equal(findTarget('sparc64-solaris'), undefined);
});

test('the loader asks for a triple this matrix can supply', async () => {
  const { platformTriple } = await import('../src/native/index.js');
  const triple = platformTriple();

  // Unsupported platforms are fine — they get the JS fallback — but the triple
  // the loader computes must be spelled the same way the packages are named.
  if (findTarget(triple)) {
    assert.equal(packageNameFor(triple), `${NATIVE_SCOPE}/native-${triple}`);
  } else {
    assert.match(triple, /^[a-z0-9]+-[a-z0-9-]+$/, `unexpected triple shape: ${triple}`);
  }
});
