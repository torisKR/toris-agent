import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonArray, normalizeTasks, fallbackPlan, buildPlanPrompt } from '../src/core/planner.js';

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
  assert.deepEqual(tasks.map((t) => t.order), [0, 1]);
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
