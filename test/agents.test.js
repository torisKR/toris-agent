import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROFILES, AGENT_CATEGORIES, BUILTIN_CATALOGUE, listAgents, getAgent, listSurfaceAgents, SURFACE_AGENT, resolveSurfaceAgent, matchSurfaceAgents, agentRolePrompt, withAgentPrompt, renderAgentCatalog, composeAgentCatalogue, parseAgentProfile, agentSearchPaths } from '../src/core/agents.js';

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

test('the TUI/GUI catalogue puts the chat persona first, then every task role', () => {
  const surface = listSurfaceAgents();
  assert.equal(surface[0].id, SURFACE_AGENT.id);
  assert.equal(surface.length, AGENT_PROFILES.length + 1);
  assert.equal(listSurfaceAgents('core')[0].id, 'toris');
  assert.equal(listSurfaceAgents('build').length, listAgents('build').length);
});

test('resolveSurfaceAgent treats a blank id as the chat persona', () => {
  assert.equal(resolveSurfaceAgent(undefined).id, 'toris');
  assert.equal(resolveSurfaceAgent('').id, 'toris');
  assert.equal(resolveSurfaceAgent('implementer').id, 'implementer');
  assert.throws(() => resolveSurfaceAgent('wizard'), /Known:/);
});

test('getAgent can resolve the chat persona without putting it in the planner list', () => {
  assert.equal(getAgent('toris').title, 'Toris');
  assert.equal(AGENT_PROFILES.some((agent) => agent.id === 'toris'), false);
});

test('matchSurfaceAgents prefix-matches id, title and category', () => {
  assert.deepEqual(matchSurfaceAgents('impl').map((agent) => agent.id), ['implementer']);
  assert.ok(matchSurfaceAgents('plan').some((agent) => agent.id === 'planner'));
  assert.ok(matchSurfaceAgents('Build').some((agent) => agent.id === 'implementer'));
  assert.equal(matchSurfaceAgents('').length, listSurfaceAgents().length);
});

test('role prompts stay silent for the default persona and constrain writers', () => {
  assert.equal(agentRolePrompt(SURFACE_AGENT), '');
  assert.match(agentRolePrompt(getAgent('implementer')), /Implementer/);
  assert.match(agentRolePrompt(getAgent('code-reviewer')), /Do not edit files/);
  assert.equal(withAgentPrompt('base', SURFACE_AGENT), 'base');
  assert.match(withAgentPrompt('base', getAgent('planner')), /Planner/);
});

test('the TUI catalogue marks the selected agent', () => {
  const text = renderAgentCatalog(listSurfaceAgents(), 'implementer');
  assert.match(text, /\* implementer/);
  assert.match(text, /  toris /);
});

test('an empty overlay catalogue is the builtin list, same object identity', () => {
  assert.equal(composeAgentCatalogue(), BUILTIN_CATALOGUE);
  assert.equal(composeAgentCatalogue([]).profiles, AGENT_PROFILES);
  assert.equal(listAgents(undefined, BUILTIN_CATALOGUE), AGENT_PROFILES);
});

test('composeAgentCatalogue overlays replace the same id and append new ones', () => {
  const custom = parseAgentProfile({
    id: 'aso-specialist',
    title: 'ASO Specialist',
    category: 'plan',
    writes: false,
    summary: 'Turns a change into store listing copy.',
  });
  const implementer = parseAgentProfile({
    id: 'implementer',
    title: 'App Implementer',
    category: 'build',
    writes: true,
    summary: 'Writes product code with store metadata in mind.',
  });
  const catalogue = composeAgentCatalogue([custom, implementer]);
  assert.equal(getAgent('aso-specialist', catalogue).title, 'ASO Specialist');
  assert.equal(getAgent('implementer', catalogue).title, 'App Implementer');
  assert.equal(getAgent('implementer').title, 'Implementer');
  assert.ok(listSurfaceAgents(undefined, catalogue).some((agent) => agent.id === 'aso-specialist'));
  assert.equal(listAgents('plan', catalogue).some((agent) => agent.id === 'aso-specialist'), true);
  assert.equal(resolveSurfaceAgent('aso-specialist', catalogue).writes, false);
});

test('a project can replace the chat persona without putting it on the planner list', () => {
  const overlay = parseAgentProfile({
    id: 'toris',
    title: 'House Toris',
    category: 'core',
    writes: true,
    summary: 'General agent tuned for this product repo.',
    system: 'You ship small and cite the receipt.',
  });
  const catalogue = composeAgentCatalogue([overlay]);
  assert.equal(catalogue.surface.title, 'House Toris');
  assert.equal(catalogue.profiles.some((agent) => agent.id === 'toris'), false);
  assert.equal(agentRolePrompt(catalogue.surface), 'You ship small and cite the receipt.');
});

test('parseAgentProfile rejects unknown keys, bad ids and non-boolean writes', () => {
  const base = {
    id: 'aso-specialist',
    title: 'ASO Specialist',
    category: 'plan',
    writes: false,
    summary: 'Turns a change into store listing copy.',
  };
  assert.throws(() => parseAgentProfile({ ...base, extra: true }), /unknown field/);
  assert.throws(() => parseAgentProfile({ ...base, id: 'ASO' }), /id/);
  assert.throws(() => parseAgentProfile({ ...base, writes: 'yes' }), /writes/);
  assert.throws(() => parseAgentProfile({ ...base, category: 'ops' }), /category/);
  assert.throws(() => parseAgentProfile({ ...base, summary: 'too short' }), /summary/);
  assert.throws(
    () => parseAgentProfile({ ...base, id: 'toris', category: 'build' }),
    /chat persona/,
  );
  assert.throws(() => parseAgentProfile(base, { file: 'x.json', stem: 'other' }), /filename/);
  assert.throws(() => parseAgentProfile([]), /JSON object/);
});

test('agentSearchPaths orders home then project, like skills', () => {
  assert.deepEqual(agentSearchPaths({ home: '/h/.toris', projectPath: '/w' }), [
    '/h/.toris/agents',
    '/w/.toris/agents',
  ]);
  assert.deepEqual(agentSearchPaths({}), []);
});

test('a custom system prompt replaces the derived role text', () => {
  const agent = parseAgentProfile({
    id: 'legal-reviewer',
    title: 'Legal Reviewer',
    category: 'review',
    writes: false,
    summary: 'Reads copy for claims the store will reject.',
    system: 'Flag unsubstantiated claims. Do not draft replacements.',
  });
  assert.equal(agentRolePrompt(agent), 'Flag unsubstantiated claims. Do not draft replacements.');
});

