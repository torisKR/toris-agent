import { newTaskId } from './ids.js';
import { AGENT_PROFILES, BUILTIN_CATALOGUE } from './agents.js';

/** Task roles the planner may assign. `core` personas stay out of plans. */
export function validAgents(catalogue) {
  const profiles = catalogue?.profiles ?? AGENT_PROFILES;
  return new Set(profiles.filter((agent) => agent.category !== 'core').map((agent) => agent.id));
}

// Derived from the profile catalogue so `toris agents`, the plan prompt and the
// task normaliser can never disagree about which roles exist.
export const VALID_AGENTS = validAgents(BUILTIN_CATALOGUE);

function planInstruction(catalogue) {
  const choices = [...validAgents(catalogue)].join('|');
  return `You are a planning agent working for a single developer, with no team to coordinate.
Decompose the goal into the FEWEST concrete, independently verifiable tasks that finish it — 1 task if a single edit does it, never more than 6.
No sign-off, hand-off, stakeholder or status-report tasks; there is nobody to hand off to.
Reply with ONLY a JSON array, no prose, no code fences. Each element:
{"title": "imperative summary", "agent": "${choices}", "detail": "what to change and where", "verify": "how to prove it works"}`;
}

export function buildPlanPrompt(goal, project, { catalogue } = {}) {
  const context = project
    ? `Repository: ${project.name} at ${project.path}.`
    : 'No repository context provided.';
  // Naming the real commands keeps each task's "verify" field honest: the model
  // proposes proof the harness can actually run.
  const checks = project?.checks?.length
    ? `Verification commands available in this project: ${project.checks.join(', ')}.`
    : '';
  return [planInstruction(catalogue), '', context, ...(checks ? [checks] : []), '', `Goal: ${goal}`].join(
    '\n',
  );
}

/** Pull the first JSON array out of a model reply that may contain fences or prose. */
export function extractJsonArray(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Normalise raw model output into tasks. Invalid entries are dropped, not trusted. */
export function normalizeTasks(raw, { now = Date.now, catalogue } = {}) {
  if (!Array.isArray(raw)) return [];
  const agents = validAgents(catalogue);
  return raw
    .filter(
      (item) =>
        item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim(),
    )
    .slice(0, 12)
    .map((item, index) => ({
      id: newTaskId(now),
      order: index,
      title: item.title.trim().slice(0, 200),
      agent: agents.has(item.agent) ? item.agent : 'implementer',
      detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 2000) : '',
      verify: typeof item.verify === 'string' ? item.verify.trim().slice(0, 500) : '',
      status: 'pending',
    }));
}

/** Deterministic fallback so a run is still useful with no provider available. */
export function fallbackPlan(goal, { now = Date.now, catalogue } = {}) {
  return normalizeTasks(
    [
      {
        title: `Implement: ${goal}`,
        agent: 'implementer',
        detail: goal,
        verify: 'Project checks pass',
      },
      {
        title: 'Add tests covering the change',
        agent: 'test-author',
        detail: goal,
        verify: 'New tests fail before, pass after',
      },
    ],
    { now, catalogue },
  );
}
