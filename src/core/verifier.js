import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Run one shell check and capture evidence. Never throws — a failure is data. */
export function runCheck(command, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (exitCode, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({
        command,
        exitCode,
        passed: exitCode === 0,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        ...(note ? { note } : {}),
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => finish(127, err.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * Run every configured check in order. Stops at the first failure so a broken
 * build does not burn the rest of the budget.
 */
export async function verify(commands, { cwd, timeoutMs } = {}) {
  const checks = [];
  for (const command of commands) {
    const result = await runCheck(command, { cwd, timeoutMs });
    checks.push(result);
    if (!result.passed) break;
  }
  // No checks is vacuously passing; callers distinguish "nothing to prove"
  // from "proved" by inspecting checks.length.
  return { checks, passed: checks.every((c) => c.passed) };
}

/** npm scripts worth running, cheapest signal first. */
const NPM_SCRIPTS = Object.freeze(['typecheck', 'lint', 'test', 'build']);

/** Infer sensible checks from a project's package.json manifest. */
export function inferChecks(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];
  const scripts = packageJson.scripts ?? {};
  return NPM_SCRIPTS.filter((name) => typeof scripts[name] === 'string').map(
    (name) => `npm run ${name}`,
  );
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // absent marker file is the normal case, not an error
  }
}

async function readJsonIfPresent(path) {
  const text = await readIfPresent(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // a broken manifest should not abort detection
  }
}

/**
 * Marker files whose mere presence implies a safe, always-available check.
 * Both commands exit 0 on a project with no tests, so detecting them can only
 * add signal — never a spurious red.
 */
const MARKER_CHECKS = Object.freeze([
  { marker: 'Cargo.toml', check: 'cargo test' },
  { marker: 'go.mod', check: 'go test ./...' },
]);

/**
 * Python is detected by evidence rather than by the presence of a manifest:
 * a pyproject.toml alone does not mean pytest is installed, and a check that
 * always fails is worse than no check at all.
 */
const PYTEST_MARKERS = Object.freeze(['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']);
const PYTEST_MENTION = /pytest/i;

async function detectPytest(projectPath) {
  for (const marker of PYTEST_MARKERS) {
    const text = await readIfPresent(join(projectPath, marker));
    if (text !== null && PYTEST_MENTION.test(text)) return ['pytest'];
  }
  return [];
}

/** Only trust a Makefile that actually declares a `test` target. */
const MAKE_TEST_TARGET = /^test\s*:/m;

async function detectMake(projectPath) {
  for (const name of ['Makefile', 'makefile']) {
    const text = await readIfPresent(join(projectPath, name));
    if (text !== null && MAKE_TEST_TARGET.test(text)) return ['make test'];
  }
  return [];
}

async function detectMarkers(projectPath) {
  const found = [];
  for (const { marker, check } of MARKER_CHECKS) {
    if ((await readIfPresent(join(projectPath, marker))) !== null) found.push(check);
  }
  return found;
}

/**
 * Infer checks by looking at the project on disk, across ecosystems.
 * Used when a run has no checks recorded, so a solo developer gets real
 * verification without having to re-register the project every time they add a
 * test script. Detection is conservative: a command is only proposed when the
 * repository shows evidence it will actually run.
 * @param {string} projectPath
 * @returns {Promise<string[]>}
 */
export async function detectChecks(projectPath) {
  if (typeof projectPath !== 'string' || projectPath === '') return [];
  const detected = [
    ...inferChecks(await readJsonIfPresent(join(projectPath, 'package.json'))),
    ...(await detectMarkers(projectPath)),
    ...(await detectPytest(projectPath)),
  ];
  // A Makefile is the fallback only when nothing more specific was found:
  // in a polyglot repo `make test` usually re-runs what we already detected.
  if (detected.length > 0) return [...new Set(detected)];
  return detectMake(projectPath);
}

const EXCERPT_LINES = 12;

/**
 * The tail of a failed check's output — the part a human actually reads.
 * stderr wins over stdout because that is where compilers and test runners put
 * the reason; a bare exit code is evidence of nothing.
 * @returns {string} '' when the check passed or produced no output
 */
export function failureExcerpt(check, { maxLines = EXCERPT_LINES } = {}) {
  if (!check || check.passed) return '';
  const source = (check.stderr ?? '').trim() || (check.stdout ?? '').trim();
  if (source === '') return check.note ? String(check.note) : '';
  return source.split('\n').slice(-maxLines).join('\n');
}
