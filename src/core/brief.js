import { dayKey, formatUsd, summarizeCost } from './cost.js';
import { KnowledgeStore, searchIndex, tokenizeQuery } from './knowledge/index.js';
import { readDaemonStatus } from '../daemon/state.js';

export const BRIEF_PERIODS = Object.freeze(['today']);
export const DEFAULT_BRIEF_PERIOD = 'today';
export const BRIEF_RUN_LIMIT = 8;
export const BRIEF_KNOWLEDGE_MIN = 3;
export const BRIEF_KNOWLEDGE_MAX = 5;

const BRIEF_GOAL_RE = /^(?:toris(?:-agent)?\s+)?brief(?:\s+today)?(?:\s+--json)?$/i;
const GOAL_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'add',
  'fix',
  'with',
  'from',
  'this',
  'that',
  'into',
  'your',
  'our',
  'run',
  'test',
  'goal',
  'make',
  'use',
  'a',
  'an',
  'to',
  'of',
  'on',
  'in',
]);

export const BRIEF_SCHEDULE_HINT =
  '`toris brief` is a foreground CLI digest, not a coding goal. The daemon only enqueues run jobs. Schedule the CLI with cron or a systemd/launchd timer (`0 9 * * * toris brief`). See docs/BRIEF.md.';

/** True when a schedule/run goal is someone trying to fire the digest as work. */
export function looksLikeBriefGoal(goal) {
  return BRIEF_GOAL_RE.test(String(goal ?? '').trim());
}

export function resolveBriefPeriod(period) {
  const value = String(period ?? DEFAULT_BRIEF_PERIOD).trim().toLowerCase() || DEFAULT_BRIEF_PERIOD;
  if (!BRIEF_PERIODS.includes(value)) {
    throw new Error(`Unknown brief period "${period}". Use \`today\`.`);
  }
  return value;
}

function runTimestamp(run) {
  return run?.finishedAt || run?.createdAt || null;
}

export function verifyOutcome(run) {
  const passed = run?.verification?.passed;
  if (passed === true) return 'pass';
  if (passed === false) return 'fail';
  return null;
}

export function summarizeGoal(goal, max = 64) {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function publicRun(run) {
  return {
    id: run.id,
    goal: summarizeGoal(run.goal, 96),
    status: run.status ?? 'unknown',
    verify: verifyOutcome(run),
    at: runTimestamp(run),
  };
}

function runsForPeriod(runs, { period, day, limit }) {
  const scoped = period === 'today' ? (runs ?? []).filter((run) => dayKey(runTimestamp(run)) === day) : runs ?? [];
  return scoped.slice(0, limit).map(publicRun);
}

function keywordsFromGoals(runs) {
  const tokens = [];
  for (const run of runs ?? []) {
    for (const token of tokenizeQuery(run.goal)) {
      if (GOAL_STOPWORDS.has(token) || tokens.includes(token)) continue;
      tokens.push(token);
    }
  }
  return tokens.slice(0, 8).join(' ');
}

function headlineOf(entry) {
  return {
    kind: entry.kind,
    id: entry.id,
    domain: entry.domain ?? null,
    title: summarizeGoal(entry.title || entry.id, 72),
    score: entry.score ?? null,
  };
}

function latestTacit(index, limit) {
  const entries = Array.isArray(index) ? index : (index?.entries ?? []);
  const preferred = entries.filter((entry) => entry.kind === 'tacit' || entry.kind === 'inbox');
  const inbox = preferred.filter((entry) => entry.kind === 'inbox').reverse();
  const tacit = preferred.filter((entry) => entry.kind === 'tacit').reverse();
  return [...inbox, ...tacit].slice(0, limit).map(headlineOf);
}

function searchHeadlines(index, query, limit) {
  const hits = searchIndex(index, query, { limit: 20 }).filter(
    (entry) => entry.kind === 'tacit' || entry.kind === 'node' || entry.kind === 'inbox',
  );
  hits.sort((a, b) => {
    const rank = (kind) => (kind === 'tacit' || kind === 'inbox' ? 0 : 1);
    return rank(a.kind) - rank(b.kind) || b.score - a.score;
  });
  return hits.slice(0, limit).map(headlineOf);
}

async function collectKnowledge({ home, cwd, runs, limit }) {
  const store = new KnowledgeStore({ home, projectPath: cwd || home });
  let status;
  try {
    status = await store.status();
  } catch {
    return { available: false, headlines: [] };
  }
  if (!status.ok) return { available: false, headlines: [] };

  let index;
  try {
    index = await store.loadIndex();
  } catch {
    return { available: true, headlines: [] };
  }

  const query = keywordsFromGoals(runs);
  const headlines = query ? searchHeadlines(index, query, limit) : [];
  const picked = headlines.length > 0 ? headlines : latestTacit(index, limit);
  return { available: true, headlines: picked };
}

async function collectDaemon(home) {
  try {
    const status = await readDaemonStatus(home);
    return {
      running: Boolean(status.running),
      pid: status.pid ?? null,
      nextDueAt: status.schedules?.nextDueAt ?? null,
      nextId: status.schedules?.nextId ?? null,
      scheduleCount: Number(status.schedules?.count) || 0,
      schedulesEnabled: Number(status.schedules?.enabled) || 0,
    };
  } catch {
    return {
      running: false,
      pid: null,
      nextDueAt: null,
      nextId: null,
      scheduleCount: 0,
      schedulesEnabled: 0,
    };
  }
}

/**
 * Read-only secretary digest. Reuses the cost ledger, run store, daemon
 * heartbeat, and knowledge index — no new persistence.
 */
export async function buildBrief({
  home,
  store,
  config,
  cwd,
  period,
  now,
  limitRuns = BRIEF_RUN_LIMIT,
  limitKnowledge = BRIEF_KNOWLEDGE_MAX,
} = {}) {
  const resolved = resolveBriefPeriod(period);
  const at = now ? new Date(typeof now === 'function' ? now() : now) : new Date();
  const day = dayKey(at);
  const cost = await summarizeCost({
    home,
    store,
    config,
    now: at,
    limitDays: 1,
    limitRuns,
  });
  const listed = store && typeof store.listRuns === 'function' ? await store.listRuns() : [];
  const runs = runsForPeriod(listed, { period: resolved, day, limit: limitRuns });
  const [daemon, knowledge] = await Promise.all([
    collectDaemon(home),
    collectKnowledge({ home, cwd, runs, limit: Math.min(BRIEF_KNOWLEDGE_MAX, Math.max(BRIEF_KNOWLEDGE_MIN, limitKnowledge)) }),
  ]);
  return {
    period: resolved,
    day,
    timezone: 'local',
    generatedAt: at.toISOString(),
    spend: {
      day: cost.today.day,
      spentUsd: cost.today.spentUsd,
      capUsd: cost.today.capUsd,
      remainingUsd: cost.today.remainingUsd,
      runCount: cost.today.runCount,
    },
    runs,
    daemon,
    knowledge,
  };
}

export function formatSpendLine(spend) {
  const cap = spend.capUsd == null ? 'unlimited' : formatUsd(spend.capUsd);
  const remaining = spend.remainingUsd == null ? 'unlimited' : formatUsd(spend.remainingUsd);
  return {
    today: `${formatUsd(spend.spentUsd)} / ${cap}`,
    remaining,
    runs: String(spend.runCount),
  };
}
