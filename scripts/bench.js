#!/usr/bin/env node
/**
 * Zero-dependency performance harness for the parts of toris that sit on a hot
 * path: CLI start-up, and `spawnCaptured` on both backends.
 *
 * Why these three shapes and not more:
 *
 *   cold-start      every `toris <cmd>` pays it once, so it is the number a
 *                   user actually feels.
 *   trivial spawn   isolates fixed per-call overhead — thread hand-off, wait
 *                   strategy, N-API marshalling — from the work itself. An
 *                   agent loop issues thousands of these.
 *   bulk output     isolates the capture path. A real `npm test` emits
 *                   megabytes, and the buffer trimming strategy shows up here
 *                   and nowhere else.
 *
 * Native and fallback run in the same process against the same commands, so
 * the comparison is apples to apples.
 *
 * Usage:
 *   node scripts/bench.js                 # table
 *   node scripts/bench.js --json          # machine-readable, for diffing runs
 *   node scripts/bench.js --quick         # fewer iterations
 *   node scripts/bench.js --baseline f.json   # table with a delta column
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  spawnCaptured,
  spawnCapturedJs,
  isNativeActive,
  backendInfo,
} from '../src/native/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FULL_ITERATIONS = Object.freeze({ cli: 12, trivial: 60, bulk: 12 });
const QUICK_ITERATIONS = Object.freeze({ cli: 4, trivial: 15, bulk: 4 });
const WARMUP_RATIO = 0.25;

/** Big enough that capture cost dominates spawn cost (~1.1 MB of digits). */
const BULK_COMMAND = 'seq 1 180000';
/** Cap far below the output, so every read goes through the trim path. */
const TRUNCATE_CAP_BYTES = 8 * 1024;

const SPAWN_TIMEOUT_MS = 60_000;
const MS_PER_NS = 1e6;

/** @param {number[]} sorted @param {number} q */
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/**
 * @param {number[]} samples milliseconds
 * @returns {{ n: number, min: number, p50: number, p90: number, mean: number }}
 */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    mean: sorted.length > 0 ? total / sorted.length : 0,
  };
}

/**
 * Run every variant once per round, rotating the order.
 *
 * Two things force this design. Interleaving: a developer machine drifts
 * (thermal, other processes), and measuring variant A to completion before
 * starting B charges that drift entirely to whichever ran during the bad
 * stretch. Round-robin spreads it evenly, so the comparison survives a loaded
 * box. Rotation: within a round the first runner pays cache and scheduler
 * warm-up costs the others do not, and a fixed order would bake that into one
 * variant permanently.
 *
 * @param {Array<{ note: string, fn: () => unknown | Promise<unknown> }>} variants
 * @param {number} iterations
 * @returns {Promise<Map<string, number[]>>} note -> per-round milliseconds
 */
async function measurePaired(variants, iterations) {
  const warmup = Math.max(1, Math.round(iterations * WARMUP_RATIO));
  /** @type {Map<string, number[]>} */
  const samples = new Map(variants.map((v) => [v.note, []]));

  for (let round = 0; round < warmup + iterations; round += 1) {
    for (let slot = 0; slot < variants.length; slot += 1) {
      const variant = variants[(slot + round) % variants.length];
      const started = process.hrtime.bigint();
      await variant.fn();
      const elapsed = Number(process.hrtime.bigint() - started) / MS_PER_NS;
      if (round >= warmup) samples.get(variant.note)?.push(elapsed);
    }
  }
  return samples;
}

/**
 * Cold start is a whole new node process, so it cannot be measured in-process.
 * @returns {{ ok: boolean, detail: string }}
 */
function probeCli() {
  const probe = spawnSync(process.execPath, [join(ROOT, 'bin', 'toris.js'), 'version'], {
    encoding: 'utf8',
  });
  if (probe.status === 0) return { ok: true, detail: (probe.stdout ?? '').trim() };
  const detail = `${probe.stderr ?? ''}`.trim().split('\n')[0] ?? 'unknown failure';
  return { ok: false, detail };
}

function runCliOnce() {
  spawnSync(process.execPath, [join(ROOT, 'bin', 'toris.js'), 'version'], { stdio: 'ignore' });
}

/**
 * @param {typeof spawnCaptured} run
 * @param {string} command
 * @param {{ maxOutputBytes?: number }} [options]
 */
function spawnRunner(run, command, options = {}) {
  return async () => {
    const result = await run(command, { timeoutMs: SPAWN_TIMEOUT_MS, ...options });
    // Touch the strings so a future optimisation cannot make them lazy and
    // silently move the cost outside the measured window.
    if (result.exitCode !== 0) throw new Error(`bench command failed: ${command}`);
    return result.stdout.length + result.stderr.length;
  };
}

/**
 * Native and fallback for one command shape, as an interleavable pair.
 * @param {string} command
 * @param {{ maxOutputBytes?: number }} [options]
 */
function backendPair(command, options) {
  const pair = [{ note: 'js fallback', fn: spawnRunner(spawnCapturedJs, command, options) }];
  // Only label a row "native" when a binding actually loaded — otherwise
  // `spawnCaptured` is the fallback and the row would compare it with itself.
  if (isNativeActive()) {
    pair.unshift({ note: 'native', fn: spawnRunner(spawnCaptured, command, options) });
  }
  return pair;
}

/**
 * @param {{ quick: boolean }} opts
 * @returns {Promise<Array<{ name: string, note: string, stats: ReturnType<typeof summarize> }>>}
 */
async function collect({ quick }) {
  const iters = quick ? QUICK_ITERATIONS : FULL_ITERATIONS;
  const capped = { maxOutputBytes: TRUNCATE_CAP_BYTES };
  const cli = probeCli();

  const cases = [
    {
      name: 'cli cold start',
      iterations: iters.cli,
      variants: cli.ok ? [{ note: 'toris version', fn: runCliOnce }] : [],
      skipped: cli.ok ? '' : cli.detail,
    },
    { name: 'spawn trivial', iterations: iters.trivial, variants: backendPair('exit 0') },
    { name: 'spawn 1.1MB out', iterations: iters.bulk, variants: backendPair(BULK_COMMAND) },
    {
      name: 'spawn 1.1MB capped 8K',
      iterations: iters.bulk,
      variants: backendPair(BULK_COMMAND, capped),
    },
  ];

  /** @type {Array<{ name: string, note: string, stats: ReturnType<typeof summarize> }>} */
  const rows = [];
  for (const bench of cases) {
    if (bench.variants.length === 0) {
      rows.push({ name: bench.name, note: `SKIPPED — ${bench.skipped}`, stats: summarize([]) });
      continue;
    }
    const samples = await measurePaired(bench.variants, bench.iterations);
    for (const variant of bench.variants) {
      rows.push({
        name: bench.name,
        note: variant.note,
        stats: summarize(samples.get(variant.note) ?? []),
      });
    }
  }
  return rows;
}

/** @param {number} ms */
function fmt(ms) {
  if (ms === 0) return '—';
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(2);
}

/**
 * @param {Array<{ name: string, note: string, stats: any }>} rows
 * @param {Map<string, any>} baseline
 */
function renderTable(rows, baseline) {
  const header = ['benchmark', 'backend', 'n', 'min', 'p50', 'p90', 'mean'];
  // Δ tracks min, not p50. Under contention every sample is `true cost +
  // scheduler noise`, and noise is one-sided: it only ever adds. min is
  // therefore the least-biased estimator of the cost the code actually owns,
  // and it is what stays reproducible across runs on a busy machine.
  if (baseline.size > 0) header.push('Δ min');

  const body = rows.map((row) => {
    const cells = [
      row.name,
      row.note,
      String(row.stats.n || '—'),
      fmt(row.stats.min),
      fmt(row.stats.p50),
      fmt(row.stats.p90),
      fmt(row.stats.mean),
    ];
    if (baseline.size > 0) {
      const prev = baseline.get(`${row.name}|${row.note}`);
      cells.push(prev?.min && row.stats.min ? formatDelta(prev.min, row.stats.min) : '—');
    }
    return cells;
  });

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
  /** @param {string[]} cells */
  const line = (cells) =>
    cells.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');

  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const cells of body) console.log(line(cells));
}

/** @param {number} before @param {number} after */
function formatDelta(before, after) {
  const pct = ((after - before) / before) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { json: false, quick: false, baseline: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--quick') args.quick = true;
    else if (argv[i] === '--baseline') args.baseline = resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/** @param {string} file */
function loadBaseline(file) {
  if (!file) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(parsed.rows.map((r) => [`${r.name}|${r.note}`, r.stats]));
  } catch (err) {
    console.error(`could not read baseline ${file}: ${err.message}`);
    return new Map();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await collect({ quick: args.quick });
  const meta = {
    backend: backendInfo(),
    native: isNativeActive(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };

  if (args.json) {
    console.log(JSON.stringify({ meta, rows }, null, 2));
    return;
  }

  console.log(`backend: ${meta.backend}`);
  console.log(`node ${meta.node} on ${meta.platform} — all times in ms\n`);
  renderTable(rows, loadBaseline(args.baseline));
}

main().catch((err) => {
  console.error(`bench failed: ${err.message}`);
  process.exit(1);
});
