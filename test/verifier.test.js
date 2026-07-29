import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, inferChecks, detectChecks, failureExcerpt } from '../src/core/verifier.js';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Build a throwaway project directory from a {filename: contents} map. */
async function fixtureProject(files) {
  const dir = await mkdtemp(join(tmpdir(), 'toris-verify-'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, 'utf8');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

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
  const result = await verify(['node -e "process.exit(0)"', 'node -e "process.exit(1)"'], {
    cwd: tmpdir(),
  });
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

test('detectChecks reads npm scripts straight off disk', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({
    'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
  });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['npm run lint', 'npm run test']);
});

test('detectChecks finds a cargo project', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({ 'Cargo.toml': '[package]\nname = "demo"\n' });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['cargo test']);
});

test('detectChecks finds a go module', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({ 'go.mod': 'module example.com/demo\n' });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['go test ./...']);
});

test('detectChecks proposes pytest only when the project mentions it', async () => {
  // Arrange: a pyproject.toml alone is not evidence that pytest is installed.
  const withPytest = await fixtureProject({
    'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
  });
  const without = await fixtureProject({
    'pyproject.toml': '[project]\nname = "demo"\n',
  });

  // Act
  const detected = await detectChecks(withPytest.dir);
  const skipped = await detectChecks(without.dir);

  // Assert
  await withPytest.cleanup();
  await without.cleanup();
  assert.deepEqual(detected, ['pytest']);
  assert.deepEqual(skipped, [], 'guessing a command that will not run is worse than no check');
});

test('detectChecks trusts a Makefile only when it declares a test target', async () => {
  // Arrange
  const withTarget = await fixtureProject({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run\n' });
  const without = await fixtureProject({ Makefile: 'build:\n\tcc x.c\n' });

  // Act
  const detected = await detectChecks(withTarget.dir);
  const skipped = await detectChecks(without.dir);

  // Assert
  await withTarget.cleanup();
  await without.cleanup();
  assert.deepEqual(detected, ['make test']);
  assert.deepEqual(skipped, []);
});

test('a more specific ecosystem wins over a generic make test', async () => {
  // Arrange: in a polyglot repo `make test` usually re-runs what we already found.
  const { dir, cleanup } = await fixtureProject({
    'Cargo.toml': '[package]\nname = "demo"\n',
    Makefile: 'test:\n\tcargo test\n',
  });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['cargo test']);
});

test('detectChecks combines ecosystems in a polyglot repo without duplicates', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['npm run test', 'cargo test']);
  assert.equal(new Set(checks).size, checks.length);
});

test('detectChecks survives a project with nothing recognisable', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({ 'README.md': 'hello' });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, []);
});

test('detectChecks ignores a corrupt package.json instead of throwing', async () => {
  // Arrange
  const { dir, cleanup } = await fixtureProject({
    'package.json': '{ this is not json',
    'go.mod': 'module example.com/demo\n',
  });

  // Act
  const checks = await detectChecks(dir);

  // Assert
  await cleanup();
  assert.deepEqual(checks, ['go test ./...'], 'a broken manifest must not abort detection');
});

test('detectChecks returns nothing for a missing or empty path', async () => {
  assert.deepEqual(await detectChecks(''), []);
  assert.deepEqual(await detectChecks(undefined), []);
  assert.deepEqual(await detectChecks(join(tmpdir(), 'toris-does-not-exist-xyz')), []);
});

test('a failed check surfaces the tail of its output, not just an exit code', async () => {
  // Arrange
  const result = await verify(
    ['node -e "console.error(\'boom: assertion failed\'); process.exit(1)"'],
    {
      cwd: tmpdir(),
    },
  );

  // Act
  const excerpt = failureExcerpt(result.checks[0]);

  // Assert
  assert.match(excerpt, /boom: assertion failed/);
});

test('failureExcerpt prefers stderr, caps its length, and stays quiet on success', () => {
  // Arrange
  const noisy = {
    passed: false,
    stdout: 'ignored stdout',
    stderr: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
  };

  // Act
  const excerpt = failureExcerpt(noisy, { maxLines: 5 });

  // Assert
  assert.deepEqual(excerpt.split('\n'), ['line 35', 'line 36', 'line 37', 'line 38', 'line 39']);
  assert.equal(
    failureExcerpt({ passed: true, stderr: 'x' }),
    '',
    'a passing check has nothing to explain',
  );
  assert.equal(failureExcerpt(null), '');
});

test('failureExcerpt falls back to stdout, then to the timeout note', () => {
  assert.equal(
    failureExcerpt({ passed: false, stdout: 'only stdout', stderr: '  ' }),
    'only stdout',
  );
  assert.equal(
    failureExcerpt({ passed: false, stdout: '', stderr: '', note: 'timed out after 5ms' }),
    'timed out after 5ms',
  );
});
