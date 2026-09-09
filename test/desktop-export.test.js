import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationToMarkdown, exportFilename } from '../src/desktop/export.js';

const sample = {
  id: 'c1',
  title: 'Launch plan',
  presetId: 'week-planner',
  createdAt: Date.UTC(2026, 0, 2, 9, 30),
  updatedAt: Date.UTC(2026, 0, 2, 10, 0),
  messages: [
    { role: 'user', content: 'plan my week' },
    {
      role: 'assistant',
      content: '# Week\n- Mon: ship the landing page',
      tools: [{ name: 'list_files', input: { path: '.' }, status: 'done' }],
    },
  ],
};

test('conversationToMarkdown renders a title, metadata and both roles', () => {
  const md = conversationToMarkdown(sample);
  assert.match(md, /^# Launch plan/);
  assert.match(md, /\*\*Mode:\*\* week-planner/);
  assert.match(md, /## You/);
  assert.match(md, /## toris/);
  assert.match(md, /plan my week/);
  assert.match(md, /Mon: ship the landing page/);
});

test('conversationToMarkdown lists tool activity for a message', () => {
  const md = conversationToMarkdown(sample);
  assert.match(md, /_Tool activity:_/);
  assert.match(md, /list_files · \./);
  assert.match(md, /— done/);
});

test('conversationToMarkdown tolerates a bare/empty conversation', () => {
  const md = conversationToMarkdown({});
  assert.match(md, /# Conversation/);
  assert.doesNotMatch(md, /undefined/);
  const md2 = conversationToMarkdown({ title: 'x', messages: [{ role: 'assistant', content: '' }] });
  assert.match(md2, /_\(empty\)_/);
});

test('conversationToMarkdown collapses excessive blank lines and ends with one newline', () => {
  const md = conversationToMarkdown(sample);
  assert.doesNotMatch(md, /\n{3,}/);
  assert.ok(md.endsWith('\n'));
});

test('exportFilename is filesystem-safe and dated', () => {
  const name = exportFilename(sample);
  assert.match(name, /^toris-launch-plan-2026-01-02\.md$/);
  // Non-latin titles still yield a usable stem.
  const kr = exportFilename({ title: '주간 계획', updatedAt: sample.updatedAt });
  assert.match(kr, /^toris-.+-2026-01-02\.md$/);
  assert.doesNotMatch(kr, /[\\/:*?"<>|]/);
});
