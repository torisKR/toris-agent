import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDagEdge,
  removeDagEdge,
  detectCycles,
  wouldCreateCycle,
  parseDagDocument,
  EDGE_KINDS,
} from '../src/core/knowledge/index.js';

test('ordering kinds are a DAG: a cycle is rejected', () => {
  const once = addDagEdge([], { from: 'a', to: 'b', kind: 'prerequisite' });
  const twice = addDagEdge(once, { from: 'b', to: 'c', kind: 'supports' });
  assert.equal(detectCycles(twice).length, 0);
  assert.equal(wouldCreateCycle(twice, 'c', 'a', 'supports'), true);
  assert.throws(
    () => addDagEdge(twice, { from: 'c', to: 'a', kind: 'derived-from' }),
    /cycle/,
  );
});

test('self-links are cycles', () => {
  assert.throws(() => addDagEdge([], { from: 'a', to: 'a', kind: 'supports' }), /itself|cycle/);
});

test('duplicate edges are rejected', () => {
  const once = addDagEdge([], { from: 'a', to: 'b', kind: 'supports' });
  assert.throws(() => addDagEdge(once, { from: 'a', to: 'b', kind: 'supports' }), /already exists/);
});

test('conflicts may go both ways without counting as a DAG cycle', () => {
  const once = addDagEdge([], { from: 'a', to: 'b', kind: 'conflicts' });
  const twice = addDagEdge(once, { from: 'b', to: 'a', kind: 'conflicts' });
  assert.equal(detectCycles(twice).length, 0);
  assert.equal(twice.length, 2);
});

test('dag.json parser accepts {edges} and a bare array', () => {
  assert.deepEqual(parseDagDocument('[]').edges, []);
  const parsed = parseDagDocument(
    JSON.stringify({ edges: [{ from: 'a', to: 'b', kind: 'supports' }] }),
  );
  assert.equal(parsed.edges[0].from, 'a');
  assert.throws(() => parseDagDocument('{'), /not valid JSON/);
});

test('unknown kinds are rejected', () => {
  assert.throws(() => addDagEdge([], { from: 'a', to: 'b', kind: 'related' }), /Unknown DAG edge kind/);
  assert.ok(EDGE_KINDS.includes('prerequisite'));
});

test('removeDagEdge drops exactly one matching edge', () => {
  const once = addDagEdge([], { from: 'a', to: 'b', kind: 'supports' });
  const twice = addDagEdge(once, { from: 'a', to: 'c', kind: 'supports' });
  const remaining = removeDagEdge(twice, { from: 'a', to: 'b', kind: 'supports' });
  assert.deepEqual(remaining, [{ from: 'a', to: 'c', kind: 'supports' }]);
  assert.throws(
    () => removeDagEdge(remaining, { from: 'a', to: 'b', kind: 'supports' }),
    (error) => error.code === 'E_UNKNOWN_EDGE',
  );
});

test('removeDagEdge drops only the first of duplicate matches', () => {
  const duplicate = [
    { from: 'a', to: 'b', kind: 'supports' },
    { from: 'a', to: 'c', kind: 'prerequisite' },
    { from: 'a', to: 'b', kind: 'supports' },
  ];
  const remaining = removeDagEdge(duplicate, { from: 'a', to: 'b', kind: 'supports' });
  assert.deepEqual(remaining, [
    { from: 'a', to: 'c', kind: 'prerequisite' },
    { from: 'a', to: 'b', kind: 'supports' },
  ]);
});
