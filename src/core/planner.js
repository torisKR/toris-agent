import { newTaskId } from './ids.js';

const PLAN_INSTRUCTION = `You are a planning agent. Decompose the goal into 2-6 concrete, independently verifiable tasks.
Reply with ONLY a JSON array, no prose, no code fences. Each element:
{"title": "imperative summary", "agent": "implementer|test-author|refactorer|doc-writer", "detail": "what to change and where", "verify": "how to prove it works"}`;

export function buildPlanPrompt(goal, project) {
  const context = project
    ? `Repository: ${project.name} at ${project.path}.`
    : 'No repository context provided.';
  return `${PLAN_INSTRUCTION}\n\n${context}\n\nGoal: ${goal}`;
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

const VALID_AGENTS = new Set(['implementer', 'test-author', 'refactorer', 'doc-writer', 'researcher', 'architect']);

/** Normalise raw model output into tasks. Invalid entries are dropped, not trusted. */
export function normalizeTasks(raw, { now = Date.now } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim())
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
      { title: `Implement: ${goal}`, agent: 'implementer', detail: goal, verify: 'Project checks pass' },
      { title: 'Add tests covering the change', agent: 'test-author', detail: goal, verify: 'New tests fail before, pass after' },
    ],
    { now },
  );
}
