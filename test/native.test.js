import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  spawnCaptured,
  spawnCapturedJs,
  isNativeActive,
  backendInfo,
  platformTriple,
} from '../src/native/index.js';

const isWindows = process.platform === 'win32';

/**
 * Build a command whose real work is a GRANDchild of the process we spawn.
 *
 * This is the shape that breaks `child_process.exec(cmd, { timeout })`: the
 * leading `sleep` stops the shell from exec-optimising into the payload, so the
 * shell stays alive as the direct child and the payload sits one level deeper.
 * Killing only the direct child leaves the payload orphaned under init.
 */
function grandchildCommand(marker) {
  const payload = `node -e "setTimeout(()=>{},47000)" ${marker}`;
  return `sleep 0.05 && ${payload}`;
}

/** @returns {string} ps lines mentioning the marker, excluding the grep itself. */
function survivors(marker) {
  try {
    return execSync(`ps -eo pid,ppid,command | grep -F '${marker}' | grep -v grep`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    // grep exits 1 when nothing matches — that is the passing case.
    return '';
  }
}

function reap(marker) {
  try {
    execSync(`pkill -f '${marker}' 2>/dev/null || true`);
  } catch {
    // Best effort.
  }
}

let markerSeq = 0;
function nextMarker() {
  markerSeq += 1;
  // PID keeps parallel runs and unrelated processes out of the match.
  return `toris-orphan-probe-${process.pid}-${markerSeq}`;
}

/**
 * The core contract, asserted against whichever implementation is passed in.
 * @param {string} label
 * @param {typeof spawnCaptured} run
 */
function contractSuite(label, run) {
  test(`${label}: captures stdout, stderr and exit code`, async () => {
    const result = await run('echo out && echo err >&2 && exit 3', { timeoutMs: 5000 });
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
    assert.equal(result.timedOut, false);
  });

  test(`${label}: reports success for a clean command`, async () => {
    const result = await run('echo fine', { timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stdout, /fine/);
  });

  test(`${label}: honours cwd`, async () => {
    const result = await run(isWindows ? 'cd' : 'pwd', {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().length > 0);
  });

  test(`${label}: flags timeout instead of hanging`, async () => {
    const started = Date.now();
    const result = await run('sleep 30', { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    // Generous ceiling; the point is that it returned rather than waiting 30s.
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  });

  test(`${label}: keeps the tail when output exceeds the cap`, async () => {
    const result = await run('seq 1 20000', { timeoutMs: 20_000, maxOutputBytes: 512 });
    assert.equal(result.truncated, true);
    assert.ok(
      Buffer.byteLength(result.stdout) <= 512,
      `kept ${Buffer.byteLength(result.stdout)} bytes`,
    );
    // The tail is what carries the error in a real build log.
    assert.match(result.stdout.trim(), /20000$/);
  });

  test(`${label}: leaves no orphaned grandchild after a timeout`, async () => {
    const marker = nextMarker();
    try {
      const result = await run(grandchildCommand(marker), { timeoutMs: 900 });
      assert.equal(result.timedOut, true);

      // Give the OS a moment to finish tearing the group down.
      await sleep(500);
      const alive = survivors(marker);
      assert.equal(alive, '', `orphaned process survived the timeout:\n${alive}`);
    } finally {
      reap(marker);
    }
  });
}

// The fallback must be correct on its own — a user without a prebuild for their
// platform still gets group-kill semantics, not the broken exec() behaviour.
contractSuite('js fallback', spawnCapturedJs);

// The dispatching entry point, exercising whichever backend is installed here.
contractSuite(`active backend (${isNativeActive() ? 'native' : 'fallback'})`, spawnCaptured);

test('backendInfo names the active backend', () => {
  const info = backendInfo();
  assert.ok(info.length > 0);
  if (isNativeActive()) {
    assert.match(info, /toris-native|native/);
  } else {
    assert.match(info, /fallback/);
  }
});

test('platformTriple is stable and matches the host', () => {
  const triple = platformTriple();
  assert.equal(triple, platformTriple());
  assert.ok(triple.startsWith(process.platform), `${triple} should start with ${process.platform}`);
  assert.ok(triple.includes(process.arch), `${triple} should mention ${process.arch}`);
});

test('linux triples distinguish glibc from musl', () => {
  // The two are not interchangeable, so the name must separate them. Asserted
  // structurally so the test is meaningful on every host.
  const triple = platformTriple();
  if (process.platform === 'linux') {
    assert.match(triple, /-(gnu|musl)$/);
  } else {
    assert.doesNotMatch(triple, /-(gnu|musl)$/);
  }
});
