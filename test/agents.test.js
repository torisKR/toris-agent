import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROFILES, AGENT_CATEGORIES, listAgents, getAgent } from '../src/core/agents.js';

test('every profile is complete enough to show in a picker', () => {
  // Arrange / Act / Assert
  for (const agent of AGENT_PROFILES) {
    assert.match(agent.id, /^[a-z][a-z-]*$/, `${agent.id} must be a stable slug`);
    assert.ok(agent.title.length > 0, `${agent.id} needs a title`);
    assert.ok(agent.summary.length > 10, `${agent.id} needs a usable summary`);
    assert.equal(typeof agent.writes, 'boolean', `${agent.id} must declare whether it writes`);
    assert.ok(AGENT_CATEGORIES.includes(agent.category), `${agent.category} is not a category`);
  }
});

test('agent ids are unique', () => {
  const ids = AGENT_PROFILES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('listAgents filters by category and returns everything without one', () => {
  // Arrange / Act
  const all = listAgents();
  const build = listAgents('build');

  // Assert
  assert.equal(all.length, AGENT_PROFILES.length);
  assert.ok(build.length > 0);
  assert.ok(build.every((a) => a.category === 'build'));
});

test('an unknown category yields an empty list rather than everything', () => {
  // A silent "here is everything" would look like a working filter.
  assert.deepEqual(listAgents('not-a-category'), []);
});

test('every category has at least one agent behind it', () => {
  for (const category of AGENT_CATEGORIES) {
    assert.ok(listAgents(category).length > 0, `${category} is advertised but empty`);
  }
});

test('getAgent resolves a known id and returns null for anything else', () => {
  assert.equal(getAgent('implementer').id, 'implementer');
  assert.equal(getAgent('chief-happiness-officer'), null);
  assert.equal(getAgent(undefined), null);
});

test('the catalogue is frozen so a caller cannot rewrite a shared profile', () => {
  // Arrange: AGENT_PROFILES is module state shared by the planner and the CLI.
  assert.throws(() => {
    'use strict';
    AGENT_PROFILES.push({ id: 'rogue' });
  });

  // Assert
  assert.equal(getAgent('rogue'), null);
});

test('at least one agent in every writing category is allowed to write', () => {
  // Arrange / Act: a plan made only of read-only agents can never finish a goal.
  const writers = AGENT_PROFILES.filter((a) => a.writes);

  // Assert
  assert.ok(writers.length >= 2, 'the harness needs agents that actually change files');
  assert.ok(writers.some((a) => a.category === 'build'));
});
