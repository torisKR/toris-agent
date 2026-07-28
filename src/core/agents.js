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

export function listAgents(category) {
  if (!category) return AGENT_PROFILES;
  return AGENT_PROFILES.filter((a) => a.category === category);
}

export function getAgent(id) {
  return AGENT_PROFILES.find((a) => a.id === id) ?? null;
}
