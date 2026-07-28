import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, inferChecks } from '../src/core/verifier.js';
import { tmpdir } from 'node:os';

test('a passing command is reported as passed with exit code 0', async () => {
  const result = await verify(['node -e "process.exit(0)"'], { cwd: tmpdir() });
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].exitCode, 0);
});

test('a failing command flips the overall result', async () => {
  const result = await verify(['node -e "process.exit(3)"'], { cwd: tmpdir() });
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].exitCode, 3);
});

test('one failure among many fails the whole verification', async () => {
  const result = await verify(['node -e "process.exit(0)"', 'node -e "process.exit(1)"'], { cwd: tmpdir() });
  assert.equal(result.passed, false);
  assert.equal(result.checks.length, 2);
});

test('no checks means vacuously passed', async () => {
  const result = await verify([], { cwd: tmpdir() });
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks, []);
});

test('a command that does not exist is a failure, not a crash', async () => {
  const result = await verify(['definitely-not-a-real-binary-xyz'], { cwd: tmpdir() });
  assert.equal(result.passed, false);
});

test('inferChecks picks up standard npm scripts', () => {
  const checks = inferChecks({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } });
  assert.ok(checks.some((c) => c.includes('test')));
  assert.ok(checks.some((c) => c.includes('lint')));
});

test('inferChecks returns nothing for a package with no scripts', () => {
  assert.deepEqual(inferChecks({}), []);
  assert.deepEqual(inferChecks(null), []);
});
