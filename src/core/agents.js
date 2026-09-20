import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { TorisError, UsageError } from './errors.js';

/**
 * Built-in agent profiles. Each profile is a role the orchestrator can assign
 * to a task. `review` roles must run on the opposite provider from the
 * implementer so a model never grades its own homework.
 *
 * Project and home overlays (`<repo>/.toris/agents/*.json`, `~/.toris/agents/*.json`)
 * merge into this same catalogue — they do not create a second list.
 */
export const AGENT_PROFILES = Object.freeze([
  { id: 'planner', category: 'plan', title: 'Planner', summary: 'Decomposes a goal into ordered, verifiable tasks.', writes: false },
  { id: 'architect', category: 'plan', title: 'Architect', summary: 'Chooses structure, boundaries and trade-offs before code exists.', writes: false },
  { id: 'researcher', category: 'plan', title: 'Researcher', summary: 'Finds prior art, libraries and API facts before implementing.', writes: false },
  { id: 'implementer', category: 'build', title: 'Implementer', summary: 'Writes the code for exactly one task.', writes: true },
  { id: 'test-author', category: 'build', title: 'Test Author', summary: 'Writes failing tests first, then keeps them honest.', writes: true },
  { id: 'refactorer', category: 'build', title: 'Refactorer', summary: 'Removes duplication and dead code without changing behaviour.', writes: true },
  { id: 'code-reviewer', category: 'review', title: 'Code Reviewer', summary: 'Reviews a diff for correctness, clarity and contract drift.', writes: false },
  { id: 'security-reviewer', category: 'review', title: 'Security Reviewer', summary: 'Audits for secrets, injection, authz and unsafe file/network use.', writes: false },
  { id: 'verifier', category: 'verify', title: 'Verifier', summary: 'Runs the project checks and reports pass/fail with evidence.', writes: false },
  { id: 'doc-writer', category: 'ship', title: 'Doc Writer', summary: 'Updates README, changelog and usage docs to match reality.', writes: true },
  { id: 'release-manager', category: 'ship', title: 'Release Manager', summary: 'Prepares version bumps, changelogs and release notes.', writes: true },
]);

export const AGENT_CATEGORIES = Object.freeze(['plan', 'build', 'review', 'verify', 'ship']);

/**
 * The operator-facing chat persona. Kept out of AGENT_PROFILES so a planner
 * cannot assign a task to "toris" — that name is the session, not a task role.
 */
export const SURFACE_AGENT = Object.freeze({
  id: 'toris',
  category: 'core',
  title: 'Toris',
  summary: 'General coding agent for the repository you are standing in.',
  writes: true,
});

export const DEFAULT_SURFACE_AGENT_ID = SURFACE_AGENT.id;

export const SURFACE_CATEGORIES = Object.freeze(['core', ...AGENT_CATEGORIES]);

const PROFILE_KEYS = Object.freeze(['id', 'title', 'category', 'writes', 'summary', 'system']);
const ID_PATTERN = /^[a-z][a-z-]*$/;
const TITLE_MAX = 80;
const SUMMARY_MIN = 11;
const SUMMARY_MAX = 500;
const SYSTEM_MAX = 8_000;

/** @typedef {{surface:object, profiles:ReadonlyArray<object>}} AgentCatalogue */

export const BUILTIN_CATALOGUE = Object.freeze({
  surface: SURFACE_AGENT,
  profiles: AGENT_PROFILES,
});

function catalogueOf(catalogue) {
  return catalogue && typeof catalogue === 'object' && Array.isArray(catalogue.profiles)
    ? catalogue
    : BUILTIN_CATALOGUE;
}

export function listAgents(category, catalogue) {
  const profiles = catalogueOf(catalogue).profiles;
  if (!category) return profiles;
  return profiles.filter((a) => a.category === category);
}

/** The catalogue the TUI picker and Studio agent room share. */
export function listSurfaceAgents(category, catalogue) {
  const { surface, profiles } = catalogueOf(catalogue);
  const all = [surface, ...profiles];
  if (!category) return all;
  return all.filter((a) => a.category === category);
}

export function getAgent(id, catalogue) {
  const { surface, profiles } = catalogueOf(catalogue);
  if (id === surface.id) return surface;
  return profiles.find((a) => a.id === id) ?? null;
}

/**
 * Resolve a picker value to a surface agent. Blank means the default chat persona.
 * @param {unknown} id
 * @param {AgentCatalogue} [catalogue]
 */
export function resolveSurfaceAgent(id, catalogue) {
  const live = catalogueOf(catalogue);
  if (id == null || String(id).trim() === '') return live.surface;
  const agent = getAgent(String(id).trim(), live);
  if (!agent) {
    const known = listSurfaceAgents(undefined, live)
      .map((item) => item.id)
      .join(', ');
    throw new UsageError(`Unknown agent "${id}". Known: ${known}`);
  }
  return agent;
}

/**
 * Prefix match for live palettes: id, title, or category.
 * @param {unknown} prefix
 * @param {AgentCatalogue} [catalogue]
 */
export function matchSurfaceAgents(prefix, catalogue) {
  const query = String(prefix ?? '')
    .trim()
    .toLowerCase();
  return listSurfaceAgents(undefined, catalogue).filter((agent) => {
    if (!query) return true;
    return (
      agent.id.startsWith(query) ||
      agent.title.toLowerCase().startsWith(query) ||
      agent.category.startsWith(query)
    );
  });
}

/** Extra system text for a selected role. Empty for the default chat persona. */
export function agentRolePrompt(agent) {
  if (!agent) return '';
  if (typeof agent.system === 'string' && agent.system.trim()) return agent.system.trim();
  if (agent.id === SURFACE_AGENT.id) return '';
  return [
    `You are currently acting as the "${agent.title}" (${agent.id}) agent.`,
    agent.summary,
    agent.writes
      ? 'You may edit files when that is required to complete the request.'
      : 'Do not edit files. Advise, review or plan only.',
  ].join('\n');
}

/** @param {string} basePrompt @param {object|null} agent */
export function withAgentPrompt(basePrompt, agent) {
  const role = agentRolePrompt(agent);
  return role ? `${basePrompt}\n\n${role}` : basePrompt;
}

/**
 * Aligned TUI listing. The selected row is marked so `/agent` is a picker.
 * @param {ReadonlyArray<{id:string, category:string, summary:string}>} agents
 * @param {string} [selectedId]
 */
export function renderAgentCatalog(agents, selectedId = SURFACE_AGENT.id) {
  const items = Array.isArray(agents) ? agents : [];
  const idWidth = Math.max(8, ...items.map((agent) => agent.id.length));
  const catWidth = Math.max(8, ...items.map((agent) => agent.category.length));
  return items
    .map((agent) => {
      const mark = agent.id === selectedId ? '*' : ' ';
      return `  ${mark} ${agent.id.padEnd(idWidth)}  ${agent.category.padEnd(catWidth)}  ${agent.summary}`;
    })
    .join('\n');
}

/**
 * Overlay directories, lowest precedence first: home then project.
 * Built-ins live in AGENT_PROFILES and are not a search path.
 * @param {{home?:string, projectPath?:string}} [roots]
 */
export function agentSearchPaths({ home, projectPath } = {}) {
  return [
    home ? join(home, 'agents') : null,
    projectPath ? join(projectPath, '.toris', 'agents') : null,
  ].filter(Boolean);
}

function invalidAgent(file, message) {
  return new TorisError(`${file}: ${message}`, 'E_INVALID_AGENT');
}

/**
 * Strict schema for one on-disk profile. Unknown keys and missing fields fail.
 * @param {unknown} raw
 * @param {{file?:string, source?:string, stem?:string}} [meta]
 */
export function parseAgentProfile(raw, { file = 'profile', source = 'project', stem } = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidAgent(file, 'must be a JSON object with id, title, category, writes and summary.');
  }
  const extra = Object.keys(raw).filter((key) => !PROFILE_KEYS.includes(key));
  if (extra.length > 0) {
    throw invalidAgent(
      file,
      `unknown field${extra.length > 1 ? 's' : ''} ${extra.map((key) => `"${key}"`).join(', ')}. Allowed: ${PROFILE_KEYS.join(', ')}.`,
    );
  }
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    throw invalidAgent(file, 'needs an "id" slug like "aso-specialist" (lowercase letters and hyphens).');
  }
  if (stem && stem !== raw.id) {
    throw invalidAgent(file, `filename must be "${raw.id}.json" to match id (found "${stem}.json").`);
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    throw invalidAgent(file, 'needs a non-empty "title".');
  }
  if (raw.title.trim().length > TITLE_MAX) {
    throw invalidAgent(file, `"title" is too long (max ${TITLE_MAX} characters).`);
  }
  if (typeof raw.category !== 'string' || !SURFACE_CATEGORIES.includes(raw.category)) {
    throw invalidAgent(file, `invalid category "${raw.category}". One of: ${SURFACE_CATEGORIES.join(', ')}.`);
  }
  if (raw.id === SURFACE_AGENT.id && raw.category !== 'core') {
    throw invalidAgent(file, 'id "toris" is the chat persona and must use category "core".');
  }
  if (typeof raw.writes !== 'boolean') {
    throw invalidAgent(file, 'needs "writes" as a boolean (true if this role may edit files).');
  }
  if (typeof raw.summary !== 'string' || raw.summary.trim().length < SUMMARY_MIN) {
    throw invalidAgent(file, `needs a "summary" of at least ${SUMMARY_MIN} characters.`);
  }
  if (raw.summary.trim().length > SUMMARY_MAX) {
    throw invalidAgent(file, `"summary" is too long (max ${SUMMARY_MAX} characters).`);
  }
  if (raw.system !== undefined) {
    if (typeof raw.system !== 'string' || raw.system.trim() === '') {
      throw invalidAgent(file, '"system" must be a non-empty string when present.');
    }
    if (raw.system.length > SYSTEM_MAX) {
      throw invalidAgent(file, `"system" is too long (${raw.system.length} chars; max ${SYSTEM_MAX}).`);
    }
  }
  return Object.freeze({
    id: raw.id,
    title: raw.title.trim(),
    category: raw.category,
    writes: raw.writes,
    summary: raw.summary.trim(),
    ...(raw.system ? { system: raw.system.trim() } : {}),
    source,
  });
}

/** On-disk JSON only — `source` is runtime metadata and is not written. */
export function serializeAgentProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw invalidAgent('profile', 'must be a JSON object with id, title, category, writes and summary.');
  }
  return {
    id: profile.id,
    title: profile.title,
    category: profile.category,
    writes: profile.writes,
    summary: profile.summary,
    ...(profile.system ? { system: profile.system } : {}),
  };
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

/**
 * Write one project-local overlay to `<projectPath>/.toris/agents/<id>.json`.
 * Validates with `parseAgentProfile` first. Duplicate file is `E_AGENT_EXISTS`.
 * Does not write `~/.toris/agents/`.
 * @param {unknown} raw
 * @param {{projectPath?:string}} [roots]
 */
export async function writeAgentProfile(raw, { projectPath } = {}) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw invalidAgent('profile', 'project path is required to write a project-local agent profile.');
  }
  const parsed = parseAgentProfile(raw, { file: 'profile', source: 'project' });
  const file = join(projectPath, '.toris', 'agents', `${parsed.id}.json`);
  try {
    await access(file);
    throw new TorisError(`${file}: agent "${parsed.id}" already exists.`, 'E_AGENT_EXISTS');
  } catch (err) {
    if (err && err.code === 'E_AGENT_EXISTS') throw err;
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const disk = serializeAgentProfile(parsed);
  await atomicWrite(file, `${JSON.stringify(disk, null, 2)}\n`);
  return Object.freeze({ ...parsed, source: 'project', file });
}

/** Load and validate one `<id>.json` profile file. */
export async function loadAgentProfileFile(file, { source = 'project' } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw invalidAgent(file, `cannot read file (${err.message}).`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalidAgent(file, `not valid JSON (${err.message}). Fix the file or remove it.`);
  }
  return parseAgentProfile(raw, { file, source, stem: basename(file, '.json') });
}

function sourceForDir(dir, { home, projectPath } = {}) {
  if (home && dir === join(home, 'agents')) return 'home';
  if (projectPath && dir === join(projectPath, '.toris', 'agents')) return 'project';
  return 'project';
}

/**
 * Read every `*.json` file in `dirs` (not recursive). Later directories win
 * on id, matching skills: builtin < home < project.
 * Missing directories are normal. A bad file throws TorisError, not a crash,
 * unless `skipInvalid` is set (Studio catalogue: keep the rest of the list).
 * @param {string[]} dirs
 * @param {{home?:string, projectPath?:string, skipInvalid?:boolean}} [roots]
 */
export async function discoverAgentProfiles(dirs, roots = {}) {
  const byId = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      if (roots.skipInvalid) continue;
      throw invalidAgent(dir, `cannot read directory (${err.message}).`);
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const source = sourceForDir(dir, roots);
    for (const entry of files) {
      try {
        const profile = await loadAgentProfileFile(join(dir, entry.name), { source });
        byId.set(profile.id, profile);
      } catch (err) {
        if (roots.skipInvalid && err?.code === 'E_INVALID_AGENT') continue;
        throw err;
      }
    }
  }
  return [...byId.values()];
}

/**
 * Merge overlays onto the built-in catalogue. Same id replaces the built-in
 * (or a lower-precedence overlay). `toris` replaces the chat persona only.
 * @param {ReadonlyArray<object>} [overlays]
 */
export function composeAgentCatalogue(overlays = []) {
  if (!Array.isArray(overlays) || overlays.length === 0) return BUILTIN_CATALOGUE;
  let surface = SURFACE_AGENT;
  const byId = new Map(
    AGENT_PROFILES.map((agent) => [agent.id, Object.freeze({ ...agent, source: 'builtin' })]),
  );
  for (const extra of overlays) {
    if (!extra || typeof extra !== 'object') continue;
    if (extra.id === SURFACE_AGENT.id) {
      surface = Object.freeze({
        id: SURFACE_AGENT.id,
        category: 'core',
        title: extra.title,
        summary: extra.summary,
        writes: extra.writes,
        ...(extra.system ? { system: extra.system } : {}),
        source: extra.source ?? 'project',
      });
      continue;
    }
    byId.set(extra.id, extra);
  }
  return Object.freeze({
    surface,
    profiles: Object.freeze([...byId.values()]),
  });
}

/**
 * Live catalogue for this home + project. No network. Absent dirs are empty.
 * Studio passes `skipInvalid: true` so one broken file cannot hide the rest.
 * @param {{home?:string, projectPath?:string, skipInvalid?:boolean}} [roots]
 */
export async function loadAgentCatalogue({ home, projectPath, skipInvalid = false } = {}) {
  const overlays = await discoverAgentProfiles(agentSearchPaths({ home, projectPath }), {
    home,
    projectPath,
    skipInvalid,
  });
  return composeAgentCatalogue(overlays);
}

/** `builtin` unless the profile came from a home or project overlay. */
export function agentSourceOf(agent) {
  return agent?.source === 'home' || agent?.source === 'project' ? agent.source : 'builtin';
}
