import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, asNumber, requirePositional } from '../src/cli/args.js';
import { UsageError } from '../src/core/errors.js';

test('parses positionals, long flags and aliases together', () => {
  const { positionals, flags } = parseArgs(['run', 'ship it', '-p', 'api', '--autonomy', 'L3']);
  assert.deepEqual(positionals, ['run', 'ship it']);
  assert.equal(flags.project, 'api');
  assert.equal(flags.autonomy, 'L3');
});

test('treats known booleans as flags, not value consumers', () => {
  const { positionals, flags } = parseArgs(['run', '--dry-run', 'goal']);
  assert.equal(flags['dry-run'], true);
  assert.deepEqual(positionals, ['run', 'goal'], 'boolean must not swallow the next token');
});

test('supports --key=value form', () => {
  assert.equal(parseArgs(['run', '--budget=2.5']).flags.budget, '2.5');
});

test('a flag followed by another flag becomes boolean', () => {
  const { flags } = parseArgs(['runs', '--status', '--json']);
  assert.equal(flags.status, true);
  assert.equal(flags.json, true);
});

test('-- terminator passes the rest through as positionals', () => {
  const { positionals } = parseArgs(['run', '--', '--not-a-flag']);
  assert.deepEqual(positionals, ['run', '--not-a-flag']);
});

test('rejects unknown short flags', () => {
  assert.throws(() => parseArgs(['-z']), UsageError);
});

test('asNumber rejects non-numeric input', () => {
  assert.equal(asNumber('2.5', 'budget'), 2.5);
  assert.equal(asNumber(undefined, 'budget'), undefined);
  assert.throws(() => asNumber('abc', 'budget'), UsageError);
});

test('requirePositional reports the missing name', () => {
  assert.throws(() => requirePositional([], 0, 'runId'), /runId/);
});
