import { newTaskId } from './ids.js';
import { AGENT_PROFILES } from './agents.js';

// Derived from the profile catalogue so `toris agents`, the plan prompt and the
// task normaliser can never disagree about which roles exist.
export const VALID_AGENTS = new Set(AGENT_PROFILES.map((a) => a.id));

const AGENT_CHOICES = [...VALID_AGENTS].join('|');

// One operator, no handoffs: a plan is a to-do list, not a project charter.
// Padding a one-line fix into six tasks costs the developer a provider call per
// task and gives them more to review, so the prompt asks for the fewest.
const PLAN_INSTRUCTION = `You are a planning agent working for a single developer, with no team to coordinate.
Decompose the goal into the FEWEST concrete, independently verifiable tasks that finish it — 1 task if a single edit does it, never more than 6.
No sign-off, hand-off, stakeholder or status-report tasks; there is nobody to hand off to.
Reply with ONLY a JSON array, no prose, no code fences. Each element:
{"title": "imperative summary", "agent": "${AGENT_CHOICES}", "detail": "what to change and where", "verify": "how to prove it works"}`;

export function buildPlanPrompt(goal, project) {
  const context = project
    ? `Repository: ${project.name} at ${project.path}.`
    : 'No repository context provided.';
  // Naming the real commands keeps each task's "verify" field honest: the model
  // proposes proof the harness can actually run.
  const checks = project?.checks?.length
    ? `Verification commands available in this project: ${project.checks.join(', ')}.`
    : '';
  return [PLAN_INSTRUCTION, '', context, ...(checks ? [checks] : []), '', `Goal: ${goal}`].join(
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
export function normalizeTasks(raw, { now = Date.now } = {}) {
  if (!Array.isArray(raw)) return [];
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
      agent: VALID_AGENTS.has(item.agent) ? item.agent : 'implementer',
      detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 2000) : '',
      verify: typeof item.verify === 'string' ? item.verify.trim().slice(0, 500) : '',
      status: 'pending',
    }));
}

/** Deterministic fallback so a run is still useful with no provider available. */
export function fallbackPlan(goal, { now = Date.now } = {}) {
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
    { now },
  );
}
