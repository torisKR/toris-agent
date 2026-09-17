import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import { withinBudget } from './autonomy.js';

export const COST_LEDGER_VERSION = 1;
export const COST_FILE = 'cost.json';

/** Round to the four decimal places every receipt already uses. */
export function roundUsd(value) {
  return Number((Number(value) || 0).toFixed(4));
}

export function formatUsd(value, digits = 4) {
  return `$${roundUsd(value).toFixed(digits)}`;
}

/** A non-positive or non-numeric cap is unlimited, matching `withinBudget`. */
export function positiveCap(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Local calendar day (`YYYY-MM-DD`). A solo builder's daily ceiling follows
 * the machine they are sitting at, not UTC.
 */
export function dayKey(when = new Date()) {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return dayKey(new Date());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function costPath(home) {
  return join(home, COST_FILE);
}

export function emptyLedger() {
  return { version: COST_LEDGER_VERSION, days: {} };
}

function cloneLedger(ledger) {
  return {
    version: COST_LEDGER_VERSION,
    days: Object.fromEntries(
      Object.entries(ledger?.days ?? {}).map(([day, entry]) => [
        day,
        {
          spentUsd: roundUsd(entry?.spentUsd),
          entries: Array.isArray(entry?.entries) ? entry.entries.map((item) => ({ ...item })) : [],
        },
      ]),
    ),
  };
}

function recomputeDay(day) {
  const entries = day.entries ?? [];
  return { spentUsd: roundUsd(entries.reduce((sum, item) => sum + (Number(item.costUsd) || 0), 0)), entries };
}

function runTimestamp(run) {
  return run?.finishedAt || run?.createdAt || new Date().toISOString();
}

export function runCostEntry(run) {
  return {
    runId: run.id,
    costUsd: roundUsd(run.costUsd),
    goal: run.goal ?? '',
    status: run.status ?? 'unknown',
    at: runTimestamp(run),
  };
}

export function upsertLedgerEntry(ledger, entry, day) {
  const next = cloneLedger(ledger);
  const key = day || dayKey(entry.at);
  for (const [existingDay, value] of Object.entries(next.days)) {
    next.days[existingDay] = recomputeDay({
      entries: (value.entries ?? []).filter((item) => item.runId !== entry.runId),
    });
    if (next.days[existingDay].entries.length === 0) delete next.days[existingDay];
  }
  const current = next.days[key] ?? { spentUsd: 0, entries: [] };
  next.days[key] = recomputeDay({ entries: [...current.entries, entry] });
  return next;
}

function overlayRuns(ledger, runs) {
  let next = cloneLedger(ledger);
  for (const run of runs ?? []) {
    if (!run?.id) continue;
    next = upsertLedgerEntry(next, runCostEntry(run), dayKey(runTimestamp(run)));
  }
  return next;
}

export async function loadCostLedger(home) {
  try {
    const parsed = JSON.parse(await readFile(costPath(home), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLedger();
    return cloneLedger(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') return emptyLedger();
    throw new Error(`Cannot read cost ledger: ${err.message}`);
  }
}

export async function saveCostLedger(home, ledger) {
  await mkdir(home, { recursive: true });
  const target = costPath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cloneLedger(ledger), null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return ledger;
}

export async function recordRunCost(home, run) {
  if (!home || !run?.id) return emptyLedger();
  const ledger = upsertLedgerEntry(await loadCostLedger(home), runCostEntry(run));
  await saveCostLedger(home, ledger);
  return ledger;
}

export function dailySpendFromRuns(runs, { day, excludeRunId, now } = {}) {
  const key = day || dayKey(now ? new Date(now()) : new Date());
  const entries = [];
  for (const run of runs ?? []) {
    if (!run?.id || run.id === excludeRunId) continue;
    if (dayKey(runTimestamp(run)) !== key) continue;
    entries.push(runCostEntry(run));
  }
  return { day: key, spentUsd: roundUsd(entries.reduce((sum, item) => sum + item.costUsd, 0)), entries };
}

/**
 * Budget guard from the public contract. `spent` is checked against the
 * tighter of the per-run `--budget` and `config.maxDailyCostUsd`.
 * Reaching a positive cap refuses more work (`spent >= cap`).
 */
export function checkBudget(spent, budget, config) {
  const spentUsd = Number(spent) || 0;
  const runCap = positiveCap(budget);
  if (runCap != null && spentUsd >= runCap) {
    return {
      ok: false,
      reason: `run budget of ${formatUsd(runCap, 2)} would be exceeded (${formatUsd(spentUsd)} already spent)`,
    };
  }
  const dailyCap = positiveCap(config?.maxDailyCostUsd);
  if (dailyCap != null && spentUsd >= dailyCap) {
    return {
      ok: false,
      reason: `daily budget of ${formatUsd(dailyCap, 2)} would be exceeded (${formatUsd(spentUsd)} already spent today)`,
    };
  }
  return { ok: true };
}

export function budgetHeadroom({ spentUsd = 0, dailySpentUsd = 0, budgetUsd, maxDailyCostUsd }) {
  const run = withinBudget(spentUsd, 0, budgetUsd);
  const daily = withinBudget(dailySpentUsd + spentUsd, 0, maxDailyCostUsd);
  return {
    runRemaining: run.remaining,
    dailyRemaining: daily.remaining,
    remaining: Math.min(run.remaining, daily.remaining),
  };
}

export function canAfford({ spentUsd, dailySpentUsd, estimateUsd, budgetUsd, maxDailyCostUsd }) {
  const run = withinBudget(spentUsd, estimateUsd, budgetUsd);
  if (!run.ok) {
    return {
      ok: false,
      remaining: run.remaining,
      reason: `budget exhausted (${formatUsd(budgetUsd, 2)} run cap reached)`,
    };
  }
  const daily = withinBudget(dailySpentUsd + spentUsd, estimateUsd, maxDailyCostUsd);
  if (!daily.ok) {
    return {
      ok: false,
      remaining: daily.remaining,
      reason: `daily budget exhausted (${formatUsd(maxDailyCostUsd, 2)} cap reached)`,
    };
  }
  return { ok: true, remaining: Math.min(run.remaining, daily.remaining) };
}

export function dailyBudgetMessage(maxDailyCostUsd, spentUsd) {
  return `${checkBudget(spentUsd, undefined, { maxDailyCostUsd }).reason}. Raise maxDailyCostUsd in config.json or wait until tomorrow (local date).`;
}

function daySummary(ledger, day, capUsd) {
  const entry = ledger.days[day] ?? { spentUsd: 0, entries: [] };
  const spentUsd = roundUsd(entry.spentUsd);
  const remainingUsd = capUsd == null ? null : roundUsd(Math.max(0, capUsd - spentUsd));
  return {
    day,
    spentUsd,
    capUsd,
    remainingUsd,
    runCount: entry.entries.length,
    entries: entry.entries,
  };
}

/**
 * Merge the on-disk ledger with run files so spend from before this feature
 * still counts, then return today + recent days + recent runs.
 */
export async function summarizeCost({ home, store, config, now, limitDays = 14, limitRuns = 12 } = {}) {
  const at = now ? new Date(typeof now === 'function' ? now() : now) : new Date();
  const today = dayKey(at);
  const ledgerOnDisk = home ? await loadCostLedger(home) : emptyLedger();
  const runs = store && typeof store.listRuns === 'function' ? await store.listRuns() : [];
  const ledger = overlayRuns(ledgerOnDisk, runs);
  const capUsd = positiveCap(config?.maxDailyCostUsd);
  const days = Object.keys(ledger.days)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, limitDays)
    .map((day) => daySummary(ledger, day, capUsd));
  if (!days.some((item) => item.day === today)) {
    days.unshift(daySummary(ledger, today, capUsd));
  }
  const recent = (runs.length > 0 ? runs : Object.values(ledger.days).flatMap((day) => day.entries))
    .slice()
    .sort((a, b) => String(b.at ?? b.createdAt ?? b.id) < String(a.at ?? a.createdAt ?? a.id) ? -1 : 1)
    .slice(0, limitRuns)
    .map((item) => ({
      id: item.id ?? item.runId,
      runId: item.runId ?? item.id,
      costUsd: roundUsd(item.costUsd),
      status: item.status ?? 'unknown',
      goal: item.goal ?? '',
      at: item.at ?? item.finishedAt ?? item.createdAt ?? null,
    }));
  return {
    timezone: 'local',
    today: daySummary(ledger, today, capUsd),
    days,
    runs: recent,
  };
}
