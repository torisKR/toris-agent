import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, resolveAutonomy, withinBudget, AUTONOMY_LEVELS } from '../src/core/autonomy.js';
import { ApprovalDeniedError } from '../src/core/errors.js';

test('L1 plans but never writes', () => {
  assert.equal(gate('L1', 'plan').allowed, true);
  assert.equal(gate('L1', 'write').allowed, false);
});

test('a blocked action is marked as approvable, not fatal', () => {
  const decision = gate('L2', 'commit');
  assert.equal(decision.allowed, false);
  assert.equal(decision.needsApproval, true, 'a human must be able to unblock it');
  assert.match(decision.reason, /L2/);
});

test('only L4 and above may push', () => {
  for (const level of ['L1', 'L2', 'L3']) assert.equal(gate(level, 'push').allowed, false, level);
  for (const level of ['L4', 'L5']) assert.equal(gate(level, 'push').allowed, true, level);
});

test('privileges are monotonic up the ladder', () => {
  const order = ['L1', 'L2', 'L3', 'L4', 'L5'];
  for (const action of ['plan', 'write', 'commit', 'push']) {
    const allowed = order.map((l) => gate(l, action).allowed);
    const firstYes = allowed.indexOf(true);
    assert.ok(firstYes !== -1, `${action} must be permitted somewhere`);
    assert.ok(allowed.slice(firstYes).every(Boolean), `${action} must never be revoked at a higher level`);
  }
});

test('an unknown action is denied and not approvable', () => {
  const decision = gate('L5', 'launch-missiles');
  assert.equal(decision.allowed, false);
  assert.equal(decision.needsApproval, false);
});

test('autonomy level parsing is case-insensitive but strict', () => {
  assert.equal(resolveAutonomy('l3').level, 'L3');
  assert.throws(() => resolveAutonomy('L9'), ApprovalDeniedError);
});

test('every declared level carries a human-readable label', () => {
  for (const [key, value] of Object.entries(AUTONOMY_LEVELS)) {
    assert.equal(value.level, key);
    assert.ok(value.label.length > 0);
  }
});

test('budget guard blocks work that exceeds the remaining allowance', () => {
  assert.equal(withinBudget(1, 0.5, 2).ok, true);
  assert.equal(withinBudget(1.8, 0.5, 2).ok, false);
  assert.equal(withinBudget(999, 5, 0).ok, true, 'no budget means no ceiling');
});
