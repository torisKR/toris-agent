import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  defaultAutonomy: 'L2',
  maxParallelAgents: 3,
  maxDailyCostUsd: 20,
  maxRetriesPerTask: 2,
  providerTimeoutMs: 900000,
  defaultProvider: 'claude',
  providers: Object.freeze({
    claude: Object.freeze({ bin: 'claude', enabled: true }),
    codex: Object.freeze({ bin: 'codex', enabled: true }),
  }),
});

/** Resolve the toris home dir. Order: explicit arg > TORIS_HOME > ~/.toris */
export function resolveHome(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.TORIS_HOME) return resolve(process.env.TORIS_HOME);
  return join(homedir(), '.toris');
}

export const configPath = (home) => join(home, 'config.json');

/**
 * Deep-merge defaults with stored config. Never mutates either input.
 * Unknown keys are preserved so a newer config survives an older binary.
 */
export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    const bothPlainObjects =
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current);
    out[key] = bothPlainObjects ? mergeConfig(current, value) : value;
  }
  return out;
}

const AUTONOMY = new Set(['L1', 'L2', 'L3', 'L4', 'L5']);

/** @returns {string[]} list of human-readable problems */
export function validateConfig(config) {
  const problems = [];
  if (!AUTONOMY.has(config.defaultAutonomy)) {
    problems.push(`defaultAutonomy must be one of L1..L5, got "${config.defaultAutonomy}"`);
  }
  const n = config.maxParallelAgents;
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    problems.push(`maxParallelAgents must be an integer 1..16, got ${JSON.stringify(n)}`);
  }
  if (typeof config.maxDailyCostUsd !== 'number' || config.maxDailyCostUsd < 0) {
    problems.push(`maxDailyCostUsd must be a non-negative number, got ${JSON.stringify(config.maxDailyCostUsd)}`);
  }
  return problems;
}

export async function loadConfig(home) {
  let raw = null;
  try {
    raw = JSON.parse(await readFile(configPath(home), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Config at ${configPath(home)} is unreadable: ${err.message}`);
    }
  }
  const config = mergeConfig(DEFAULT_CONFIG, raw);
  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(`Invalid config at ${configPath(home)}:\n  - ${problems.join('\n  - ')}`);
  }
  return { config, exists: raw !== null };
}

export async function saveConfig(home, config) {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}
