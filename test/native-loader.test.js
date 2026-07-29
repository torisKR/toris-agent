import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { spawnCaptured, spawnCapturedJs, isNativeActive } from '../src/native/index.js';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_ENTRY = join(ROOT, 'src', 'native', 'index.js');

/**
 * Load the native module in a fresh process so `loadBinding()` re-runs under a
 * different environment. The binding is resolved once at import time, so this
 * is the only honest way to exercise the "no native available" branch.
 *
 * @param {Record<string,string>} env extra environment for the child
 * @returns {Promise<{active: boolean, info: string, result: object}>}
 */
async function probeLoader(env) {
  const script = `
    import { isNativeActive, backendInfo, spawnCaptured } from ${JSON.stringify(NATIVE_ENTRY)};
    const result = await spawnCaptured('echo loader-probe && echo err >&2 && exit 7', {
      timeoutMs: 10000,
    });
    process.stdout.write(JSON.stringify({
      active: isNativeActive(),
      info: backendInfo(),
      result,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    cwd: ROOT,
  });
  return JSON.parse(stdout);
}

test('loader falls back cleanly when the native binary is unavailable', async () => {
  const probe = await probeLoader({ TORIS_DISABLE_NATIVE: '1' });

  assert.equal(probe.active, false, 'native must not be active when disabled');
  assert.match(probe.info, /fallback/i, `backendInfo should name the fallback, got "${probe.info}"`);

  // The point of the fallback is that behaviour is unchanged, not merely that
  // it loads: a user with no prebuild must still get correct results.
  assert.equal(probe.result.exitCode, 7);
  assert.match(probe.result.stdout, /loader-probe/);
  assert.match(probe.result.stderr, /err/);
  assert.equal(probe.result.timedOut, false);
});

test('loader selects the native backend when a binary is present', async (t) => {
  if (!isNativeActive()) {
    t.skip('no native binary built for this host; nothing to select');
    return;
  }
  const probe = await probeLoader({});

  assert.equal(probe.active, true);
  assert.doesNotMatch(probe.info, /fallback/i);
  assert.equal(probe.result.exitCode, 7);
});

// Commands chosen to cover the parts of the contract most likely to diverge
// between two independent implementations: exit codes, both streams, ordering,
// empty output, and multi-line payloads.
const EQUIVALENCE_CASES = Object.freeze([
  'echo plain',
  'echo out && echo err >&2 && exit 4',
  'printf "no-trailing-newline"',
  'true',
  'printf "a\\nb\\nc\\n"',
  'exit 42',
]);

test('native and fallback agree on run_command results', async (t) => {
  if (!isNativeActive()) {
    t.skip('native backend unavailable; equivalence is vacuous on this host');
    return;
  }

  for (const command of EQUIVALENCE_CASES) {
    const [native, fallback] = await Promise.all([
      spawnCaptured(command, { timeoutMs: 10_000 }),
      spawnCapturedJs(command, { timeoutMs: 10_000 }),
    ]);

    assert.deepEqual(
      {
        exitCode: native.exitCode,
        stdout: native.stdout,
        stderr: native.stderr,
        timedOut: native.timedOut,
        truncated: native.truncated,
      },
      {
        exitCode: fallback.exitCode,
        stdout: fallback.stdout,
        stderr: fallback.stderr,
        timedOut: fallback.timedOut,
        truncated: fallback.truncated,
      },
      `backends diverged for: ${command}`,
    );
  }
});

test('truncation behaves identically across backends', async (t) => {
  if (!isNativeActive()) {
    t.skip('native backend unavailable');
    return;
  }
  const command = 'seq 1 20000';
  const options = { timeoutMs: 20_000, maxOutputBytes: 512 };
  const [native, fallback] = await Promise.all([
    spawnCaptured(command, options),
    spawnCapturedJs(command, options),
  ]);

  assert.equal(native.truncated, true);
  assert.equal(fallback.truncated, true);
  // Both must keep the tail — that is where a real build log carries its error.
  assert.equal(native.stdout.trim().endsWith('20000'), true);
  assert.equal(fallback.stdout.trim().endsWith('20000'), true);
  assert.ok(Buffer.byteLength(native.stdout) <= 512);
  assert.ok(Buffer.byteLength(fallback.stdout) <= 512);
});

/**
 * Value exports declared in a .d.ts. Types and interfaces are erased at
 * runtime, so only `function`, `const` and `class` are comparable.
 * @param {string} source
 * @returns {Set<string>}
 */
function declaredValueExports(source) {
  const names = new Set();
  const pattern = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

// These guard against the most likely failure mode for hand-written types:
// the JS grows an export and the .d.ts silently goes stale, leaving consumers
// with a type error on a function that exists.
test('native .d.ts declares every runtime export', async () => {
  const source = await readFile(join(ROOT, 'src', 'native', 'index.d.ts'), 'utf8');
  const declared = declaredValueExports(source);
  const actual = Object.keys(await import('../src/native/index.js'));

  const missing = actual.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `src/native/index.d.ts is missing: ${missing.join(', ')}`);
});

test('package .d.ts declares every runtime export', async () => {
  const source = await readFile(join(ROOT, 'src', 'index.d.ts'), 'utf8');
  const declared = declaredValueExports(source);
  const actual = Object.keys(await import('../src/index.js'));

  const missing = actual.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `src/index.d.ts is missing: ${missing.join(', ')}`);
});
