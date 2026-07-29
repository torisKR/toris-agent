import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { RECOMMENDED_AUTONOMY } from './autonomy.js';

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  // Solo-dev default: git is the undo button for one person, so pause at push,
  // not at every local write/commit. See RECOMMENDED_AUTONOMY in autonomy.js.
  defaultAutonomy: RECOMMENDED_AUTONOMY,
  maxParallelAgents: 3,
  maxDailyCostUsd: 20,
  maxRetriesPerTask: 2,
  providerTimeoutMs: 900000,
  defaultProvider: 'claude',
  providers: Object.freeze({
    claude: Object.freeze({ bin: 'claude', enabled: true }),
    codex: Object.freeze({ bin: 'codex', enabled: true }),
  }),
  // Model profiles start empty on purpose. The development plan forbids pinning
  // example model IDs in product code, so the user owns this mapping: roles ->
  // profiles -> models. `toris init` writes a starter block and every error
  // names the exact config key to set.
  models: Object.freeze({
    profiles: Object.freeze({}),
    routing: Object.freeze({}),
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
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current);
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
    problems.push(
      `maxDailyCostUsd must be a non-negative number, got ${JSON.stringify(config.maxDailyCostUsd)}`,
    );
  }
  return problems;
}

/** Legacy `providers` keys and the CLI-backed provider each one maps to. */
const LEGACY_CLI_PROVIDERS = Object.freeze({ claude: 'claude-cli', codex: 'codex-cli' });

/**
 * Configs written before `models.profiles` existed carry only a `providers`
 * block, which made a bare `toris` send an already-connected user back through
 * the connect wizard. Derive equivalent CLI profiles in memory instead — the
 * file on disk is never rewritten, and an explicit profile setup wins.
 * Returns the input unchanged when there is nothing to migrate.
 */
export function migrateLegacyProviders(config) {
  const hasProfiles = Object.keys(config?.models?.profiles ?? {}).length > 0;
  if (hasProfiles) return config;

  const derived = {};
  for (const [key, provider] of Object.entries(LEGACY_CLI_PROVIDERS)) {
    if (config?.providers?.[key]?.enabled === true) {
      derived[provider] = { provider, model: 'auto' };
    }
  }
  const names = Object.keys(derived);
  if (names.length === 0) return config;

  const models = config?.models ?? {};
  return {
    ...config,
    models: {
      ...models,
      profiles: { ...(models.profiles ?? {}), ...derived },
      routing: { chat: names[0], ...(models.routing ?? {}) },
    },
  };
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
  const config = migrateLegacyProviders(mergeConfig(DEFAULT_CONFIG, raw));
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
