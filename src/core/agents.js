import { UsageError } from './errors.js';

/**
 * Built-in agent profiles. Each profile is a role the orchestrator can assign
 * to a task. `review` roles must run on the opposite provider from the
 * implementer so a model never grades its own homework.
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

export function listAgents(category) {
  if (!category) return AGENT_PROFILES;
  return AGENT_PROFILES.filter((a) => a.category === category);
}

/** The catalogue the TUI picker and Studio agent room share. */
export function listSurfaceAgents(category) {
  const all = [SURFACE_AGENT, ...AGENT_PROFILES];
  if (!category) return all;
  return all.filter((a) => a.category === category);
}

export function getAgent(id) {
  if (id === SURFACE_AGENT.id) return SURFACE_AGENT;
  return AGENT_PROFILES.find((a) => a.id === id) ?? null;
}

/**
 * Resolve a picker value to a surface agent. Blank means the default chat persona.
 * @param {unknown} id
 */
export function resolveSurfaceAgent(id) {
  if (id == null || String(id).trim() === '') return SURFACE_AGENT;
  const agent = getAgent(String(id).trim());
  if (!agent) {
    const known = listSurfaceAgents()
      .map((item) => item.id)
      .join(', ');
    throw new UsageError(`Unknown agent "${id}". Known: ${known}`);
  }
  return agent;
}

/**
 * Prefix match for live palettes: id, title, or category.
 * @param {unknown} prefix
 */
export function matchSurfaceAgents(prefix) {
  const query = String(prefix ?? '')
    .trim()
    .toLowerCase();
  return listSurfaceAgents().filter((agent) => {
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
  if (!agent || agent.id === SURFACE_AGENT.id) return '';
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
