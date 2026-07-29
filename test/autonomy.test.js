import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gate,
  resolveAutonomy,
  withinBudget,
  AUTONOMY_LEVELS,
  autonomyRank,
  autoApprovesTools,
  AUTO_APPROVE_FROM,
  RECOMMENDED_AUTONOMY,
  GATED_ACTIONS,
} from '../src/core/autonomy.js';
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
    assert.ok(
      allowed.slice(firstYes).every(Boolean),
      `${action} must never be revoked at a higher level`,
    );
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

test('every rung differs from its neighbour in at least one capability', () => {
  // Arrange: L4 and L5 used to be byte-identical apart from their label, so the
  // autonomy table showed two rows a user could not choose between.
  const levels = Object.values(AUTONOMY_LEVELS);

  // Act + Assert
  for (let i = 1; i < levels.length; i += 1) {
    const previous = levels[i - 1];
    const current = levels[i];
    const differs = GATED_ACTIONS.some(
      (action) => gate(previous.level, action).allowed !== gate(current.level, action).allowed,
    );
    assert.ok(differs, `${previous.level} and ${current.level} grant exactly the same powers`);
  }
});

test('only L5 may push to the default branch', () => {
  // Arrange / Act / Assert
  for (const level of ['L1', 'L2', 'L3', 'L4']) {
    assert.equal(gate(level, 'push-default').allowed, false, level);
  }
  assert.equal(gate('L5', 'push-default').allowed, true);
});

test('a side-branch push is permitted a rung before the default branch', () => {
  // Arrange / Act
  const l4 = gate('L4', 'push');
  const l4Default = gate('L4', 'push-default');

  // Assert
  assert.equal(l4.allowed, true, 'L4 may push its own branch');
  assert.equal(l4Default.allowed, false, 'L4 must not touch the default branch');
  assert.equal(l4Default.needsApproval, true, 'a human can still unblock it');
});

test('rank exposes ladder order without parsing the level string', () => {
  // Arrange
  const levels = ['L1', 'L2', 'L3', 'L4', 'L5'];

  // Act
  const ranks = levels.map(autonomyRank);

  // Assert
  assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
  assert.ok(
    ranks.every((r, i) => i === 0 || r > ranks[i - 1]),
    'ranks must be strictly increasing',
  );
});

test('tool auto-approval starts at the recommended solo level and never turns off again', () => {
  // Arrange
  const levels = ['L1', 'L2', 'L3', 'L4', 'L5'];

  // Act
  const approvals = levels.map(autoApprovesTools);

  // Assert: the chat path auto-approves mutating tools from AUTO_APPROVE_FROM up,
  // and the run path must agree or the same flag would mean two different things.
  assert.equal(AUTO_APPROVE_FROM, autonomyRank(RECOMMENDED_AUTONOMY));
  assert.deepEqual(approvals, [false, false, true, true, true]);
  const firstYes = approvals.indexOf(true);
  assert.ok(approvals.slice(firstYes).every(Boolean), 'auto-approval must be monotonic');
});

test('the recommended solo default writes and commits but never pushes', () => {
  // Arrange / Act
  const level = RECOMMENDED_AUTONOMY;

  // Assert: git is a solo developer's undo button, so local commits are cheap to
  // reverse; pushing is the first step that leaves their machine.
  assert.equal(gate(level, 'write').allowed, true);
  assert.equal(gate(level, 'commit').allowed, true);
  assert.equal(gate(level, 'push').allowed, false);
});

test('every level explains the blast radius, not just its name', () => {
  for (const level of Object.values(AUTONOMY_LEVELS)) {
    assert.ok(level.detail.length > 20, `${level.level} needs a usable explanation`);
    assert.equal(typeof level.rank, 'number');
  }
});

test('autonomy levels are frozen so a caller cannot widen its own permissions', () => {
  // Arrange
  const l1 = resolveAutonomy('L1');

  // Act: a stray assignment must not silently grant write access.
  assert.throws(() => {
    'use strict';
    l1.writes = true;
  });

  // Assert
  assert.equal(gate('L1', 'write').allowed, false);
});
