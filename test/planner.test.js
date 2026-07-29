import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsonArray,
  normalizeTasks,
  fallbackPlan,
  buildPlanPrompt,
  VALID_AGENTS,
} from '../src/core/planner.js';
import { AGENT_PROFILES } from '../src/core/agents.js';

test('extracts a JSON array from a fenced reply', () => {
  const reply = 'Sure!\n```json\n[{"title":"A"}]\n```\nHope that helps';
  assert.deepEqual(extractJsonArray(reply), [{ title: 'A' }]);
});

test('extracts a bare JSON array surrounded by prose', () => {
  assert.deepEqual(extractJsonArray('here: [{"title":"B"}] done'), [{ title: 'B' }]);
});

test('returns null when there is no array', () => {
  assert.equal(extractJsonArray('no json at all'), null);
  assert.equal(extractJsonArray(undefined), null);
});

test('normalizeTasks drops entries without a usable title', () => {
  const tasks = normalizeTasks([{ title: 'Keep' }, { title: '   ' }, { nope: 1 }, null]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Keep');
});

test('normalizeTasks coerces an unknown agent to implementer', () => {
  assert.equal(normalizeTasks([{ title: 'X', agent: 'wizard' }])[0].agent, 'implementer');
});

test('normalizeTasks assigns stable ordering and pending status', () => {
  const tasks = normalizeTasks([{ title: 'A' }, { title: 'B' }]);
  assert.deepEqual(
    tasks.map((t) => t.order),
    [0, 1],
  );
  assert.ok(tasks.every((t) => t.status === 'pending'));
});

test('normalizeTasks caps runaway plans', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` }));
  assert.equal(normalizeTasks(many).length, 12);
});

test('fallbackPlan always yields actionable tasks', () => {
  const tasks = fallbackPlan('do the thing');
  assert.ok(tasks.length >= 2);
  assert.match(tasks[0].title, /do the thing/);
});

test('plan prompt includes repository context when a project is given', () => {
  assert.match(buildPlanPrompt('g', { name: 'api', path: '/srv/api' }), /\/srv\/api/);
});

test('the plan prompt tells the model it is planning for one operator', () => {
  // Arrange / Act
  const prompt = buildPlanPrompt('add a cache', { name: 'api', path: '/srv/api' });

  // Assert: without this, plans grow sign-off, hand-off and review-board steps
  // that a solo developer has to delete by hand every single run.
  assert.match(prompt, /single developer/i);
  assert.match(prompt, /No sign-off, hand-off, stakeholder or status-report tasks/i);
});

test('the plan prompt names the checks the work will be judged against', () => {
  // Arrange / Act
  const prompt = buildPlanPrompt('add a cache', {
    name: 'api',
    path: '/srv/api',
    checks: ['npm test', 'npm run lint'],
  });

  // Assert
  assert.match(prompt, /npm test/);
  assert.match(prompt, /npm run lint/);
});

test('the plan prompt omits the checks section when nothing is known', () => {
  const noChecks = buildPlanPrompt('g', { name: 'api', path: '/srv/api' });
  assert.ok(!noChecks.includes('Verification commands'));
  assert.ok(!buildPlanPrompt('g', null).includes('Verification commands'));
});

test('the planner offers exactly the agents the registry defines', () => {
  // Arrange: a plan naming an agent the executor cannot resolve silently
  // degrades to the default agent, so the two lists must not drift.
  const registry = AGENT_PROFILES.map((a) => a.id).sort();

  // Act
  const advertised = [...VALID_AGENTS].sort();

  // Assert
  assert.deepEqual(advertised, registry);
});

test('every advertised agent appears in the plan prompt', () => {
  const prompt = buildPlanPrompt('g', null);
  for (const agent of VALID_AGENTS) {
    assert.ok(prompt.includes(agent), `${agent} is selectable but never mentioned to the model`);
  }
});

test('normalizeTasks keeps a known agent and rewrites an invented one', () => {
  // Arrange
  const plan = [
    { title: 'A', agent: 'code-reviewer' },
    { title: 'B', agent: 'chief-happiness-officer' },
  ];

  // Act
  const tasks = normalizeTasks(plan);

  // Assert
  assert.equal(tasks[0].agent, 'code-reviewer');
  assert.ok(VALID_AGENTS.has(tasks[1].agent), 'an unknown agent must fall back to a real one');
});
