import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoProvider } from '../src/desktop/demo-provider.js';
import { createChatSession } from '../src/core/chat.js';

const collect = async (iterator) => {
  const events = [];
  for await (const evt of iterator) events.push(evt);
  return events;
};

test('demo provider streams text deltas then a final done event', async () => {
  const provider = createDemoProvider({ delayMs: 0 });
  const events = await collect(
    provider.stream({
      system: 'Mode: General assistant.',
      messages: [{ role: 'user', content: 'hello there' }],
      tools: [],
    }),
  );
  const text = events.filter((e) => e.type === 'text');
  const done = events.filter((e) => e.type === 'done');
  assert.ok(text.length > 0, 'should stream at least one text delta');
  assert.equal(done.length, 1, 'exactly one done event');
  assert.equal(done[0].toolCalls.length, 0);
  assert.match(done[0].text, /Demo mode/i);
});

test('demo provider flavours its reply by preset mode', async () => {
  const provider = createDemoProvider({ delayMs: 0 });
  const events = await collect(
    provider.stream({
      system: 'Mode: Email. Turn a rough intent into a finished email.',
      messages: [{ role: 'user', content: 'chase an overdue invoice' }],
      tools: [],
    }),
  );
  const done = events.find((e) => e.type === 'done');
  assert.match(done.text, /Subject:/, 'email mode should return a subject line');
});

test('demo provider emits a tool call when tools are available and asked to list', async () => {
  const provider = createDemoProvider({ delayMs: 0 });
  const events = await collect(
    provider.stream({
      system: 'Mode: Coding copilot.',
      messages: [{ role: 'user', content: 'list the files in this project' }],
      tools: [{ name: 'list_files' }, { name: 'run_command' }],
    }),
  );
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.toolCalls.length, 1);
  assert.equal(done.toolCalls[0].name, 'list_files');
});

test('demo provider never emits tools when none are registered', async () => {
  const provider = createDemoProvider({ delayMs: 0 });
  const events = await collect(
    provider.stream({
      system: 'Mode: Email.',
      messages: [{ role: 'user', content: 'run a command please' }],
      tools: [],
    }),
  );
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.toolCalls.length, 0);
});

test('demo provider drives the real chat engine tool loop end to end', async () => {
  const provider = createDemoProvider({ delayMs: 0 });
  const ran = [];
  const tools = [
    {
      name: 'list_files',
      description: 'list',
      run: async () => {
        ran.push('list_files');
        return 'a.js\nb.js';
      },
    },
  ];
  const session = createChatSession({
    provider,
    model: 'demo',
    system: 'Mode: Coding copilot.',
    tools,
  });
  const result = await session.send('please list files in the repo');
  assert.deepEqual(ran, ['list_files'], 'the engine actually invoked the tool');
  assert.match(result.text, /list_files/, 'final answer references the tool output');
  assert.ok(result.usage.turns >= 2, 'a tool loop takes at least two model turns');
});

test('demo provider respects an abort signal', async () => {
  const provider = createDemoProvider({ delayMs: 50 });
  const controller = new AbortController();
  const iterator = provider.stream({
    system: 'Mode: General assistant.',
    messages: [{ role: 'user', content: 'a fairly long message to stream slowly' }],
    tools: [],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(async () => {
    for await (const _ of iterator) {
      /* drain until aborted */
    }
  });
});
