import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  getPreset,
  listPresetsForUi,
  DEFAULT_PRESET_ID,
} from '../src/desktop/presets.js';

test('every preset has the fields the bridge and UI need', () => {
  assert.ok(PRESETS.length >= 6, 'expected a useful set of solo-entrepreneur modes');
  for (const p of PRESETS) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.icon, 'string');
    assert.equal(typeof p.tagline, 'string');
    assert.equal(typeof p.tools, 'boolean');
    assert.ok(Array.isArray(p.starters) && p.starters.length > 0, `${p.id} needs starters`);
    // The system prompt is a REAL instruction, not decorative copy.
    assert.ok(p.system.length > 120, `${p.id} system prompt looks too thin`);
    assert.match(p.system, /Mode:/, `${p.id} must declare its Mode:`);
  }
});

test('the solo-entrepreneur jobs are all covered', () => {
  const ids = new Set(PRESETS.map((p) => p.id));
  for (const expected of ['email', 'week-planner', 'marketing', 'summarize', 'code', 'bookkeeping']) {
    assert.ok(ids.has(expected), `missing preset "${expected}"`);
  }
});

test('preset ids are unique', () => {
  const ids = PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('getPreset falls back to the default for an unknown id', () => {
  assert.equal(getPreset('does-not-exist').id, DEFAULT_PRESET_ID);
  assert.equal(getPreset('email').id, 'email');
});

test('listPresetsForUi omits the internal system prompt', () => {
  const ui = listPresetsForUi();
  assert.equal(ui.length, PRESETS.length);
  for (const p of ui) {
    assert.equal(p.system, undefined, 'system prompt must not leak to the UI payload');
    assert.equal(typeof p.label, 'string');
  }
});

test('the bookkeeping mode refuses to pose as a tax advisor', () => {
  const bk = getPreset('bookkeeping');
  assert.match(bk.system, /not an accountant|professional/i);
});
