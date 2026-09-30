import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_CONFIG, configPath, mergeConfig, validateConfig } from './config.js';
import { ADAPTERS, detectBinary } from './providers.js';
import { applyDecision } from './apply-gate.js';
import { isRepo, repoRoot, currentBranch } from './git.js';
import { detectChecks } from './verifier.js';
import { newProjectId } from './ids.js';
import { TorisError } from './errors.js';

/** Fill missing preferences, using stored values rather than inherited defaults. */
export async function soloConfig(home) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(configPath(home), 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new Error('expected a configuration object');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new TorisError(`Cannot prepare solo config at ${configPath(home)}: ${err.message}`, 'E_CONFIG');
    }
  }

  const providers = {};
  const availableProviders = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    const bin = stored.providers?.[name]?.bin ?? adapter.bin;
    const available = Boolean(detectBinary(bin));
    providers[name] = { bin, enabled: available };
    if (available && stored.providers?.[name]?.enabled !== false) availableProviders.push(name);
  }
  const preferred = availableProviders.includes(stored.defaultProvider)
    ? stored.defaultProvider
    : availableProviders[0];
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, {
    defaultAutonomy: 'L2',
    maxParallelAgents: 1,
    maxDailyCostUsd: 20,
    defaultProvider: preferred ?? DEFAULT_CONFIG.defaultProvider,
    knowledge: { autoRetrieve: true },
    providers,
  }), stored);

  // Explicit model profiles and routing always win. The CLI owns login and the
  // concrete model; initialization only checks whether its binary is present.
  if (Object.keys(config.models?.profiles ?? {}).length === 0 && preferred) {
    const profile = `${preferred}-cli`;
    config.models = mergeConfig(config.models ?? {}, {
      profiles: { [profile]: { provider: profile, model: 'auto' } },
      routing: { chat: profile, ...(config.models?.routing ?? {}) },
    });
  }
  const problems = validateConfig(config);
  if (problems.length > 0) throw new TorisError(`Invalid solo config: ${problems.join('; ')}`, 'E_CONFIG');
  return { config, availableProviders };
}

/** Register the current project once, preserving any existing project checks. */
export async function soloProject(store, projectPath) {
  const target = resolve(projectPath);
  const isGitRepo = await isRepo(target);
  const root = isGitRepo ? (await repoRoot(target)) ?? target : target;
  const projects = await store.readCollection('projects');
  const existing = projects.find((project) => project.path === root);
  if (existing) return { project: existing, projectCreated: false };

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    // Projects without a Node manifest are supported by detectChecks as well.
  }
  const project = {
    id: newProjectId(),
    name: manifest?.name ?? basename(root),
    path: root,
    isGitRepo,
    branch: isGitRepo ? await currentBranch(root) : null,
    checks: await detectChecks(root),
    addedAt: new Date().toISOString(),
  };
  await store.updateCollection('projects', (items) => [...items, project]);
  return { project, projectCreated: true };
}

export function soloSummary(config, availableProviders, project) {
  return {
    autonomy: config.defaultAutonomy,
    apply: { never: 'disabled', ask: 'manual', auto: 'automatic' }[applyDecision(config.defaultAutonomy)],
    maxParallelAgents: config.maxParallelAgents,
    maxDailyCostUsd: config.maxDailyCostUsd,
    knowledgeAutoRetrieve: config.knowledge?.autoRetrieve === true,
    availableProviders,
    ...project,
  };
}
