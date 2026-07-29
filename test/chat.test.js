import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatSession } from '../src/core/chat.js';
import { toWire as anthropicWire } from '../src/providers/anthropic.js';
import { toWire as openaiWire } from '../src/providers/openai.js';

/**
 * A scripted provider: each entry is one model turn. Lets us drive the agent
 * loop deterministically, with no network and no API key.
 */
function fakeProvider(turns) {
  const seen = [];
  let i = 0;
  return {
    name: 'fake',
    seen,
    async *stream({ messages }) {
      seen.push(messages);
      const turn = turns[i] ?? { text: '', toolCalls: [] };
      i += 1;
      if (turn.text) yield { type: 'text', delta: turn.text };
      yield {
        type: 'done',
        text: turn.text ?? '',
        toolCalls: turn.toolCalls ?? [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

test('a plain answer ends the loop after one turn', async () => {
  const session = createChatSession({
    provider: fakeProvider([{ text: 'hello there' }]),
    model: 'test-model',
  });

  const result = await session.send('hi');

  assert.equal(result.text, 'hello there');
  assert.equal(result.usage.turns, 1);
  assert.equal(session.history.length, 2);
});

test('a tool call is executed and fed back to the model', async () => {
  const calls = [];
  const provider = fakeProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { v: 42 } }] },
    { text: 'done' },
  ]);

  const session = createChatSession({
    provider,
    model: 'test-model',
    tools: [
      {
        name: 'echo',
        description: 'echo',
        run: async (input) => {
          calls.push(input);
          return { echoed: input.v };
        },
      },
    ],
  });

  const result = await session.send('use the tool');

  assert.deepEqual(calls, [{ v: 42 }]);
  assert.equal(result.text, 'done');
  assert.equal(result.usage.turns, 2);
  const toolMsg = session.history.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /"echoed": 42/);
});

test('a tool that throws reports back instead of killing the run', async () => {
  const provider = fakeProvider([
    { toolCalls: [{ id: 'c1', name: 'boom', input: {} }] },
    { text: 'recovered' },
  ]);

  const session = createChatSession({
    provider,
    model: 'test-model',
    tools: [
      {
        name: 'boom',
        description: 'always fails',
        run: async () => {
          throw new Error('disk on fire');
        },
      },
    ],
  });

  const result = await session.send('go');

  assert.equal(result.text, 'recovered');
  const toolMsg = session.history.find((m) => m.role === 'tool');
  assert.equal(toolMsg.isError, true);
  assert.match(toolMsg.content, /disk on fire/);
});

test('a denied approval blocks the side effect and tells the model why', async () => {
  let ran = false;
  const provider = fakeProvider([
    { toolCalls: [{ id: 'c1', name: 'deploy', input: {} }] },
    { text: 'understood' },
  ]);

  const session = createChatSession({
    provider,
    model: 'test-model',
    approve: async () => false,
    tools: [
      {
        name: 'deploy',
        description: 'ship it',
        needsApproval: true,
        run: async () => {
          ran = true;
        },
      },
    ],
  });

  await session.send('deploy please');

  assert.equal(ran, false, 'a denied tool must never execute');
  const toolMsg = session.history.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /denied/i);
});

test('an unknown tool is reported without crashing the session', async () => {
  const provider = fakeProvider([
    { toolCalls: [{ id: 'c1', name: 'nope', input: {} }] },
    { text: 'ok' },
  ]);
  const session = createChatSession({ provider, model: 'test-model' });

  const result = await session.send('go');

  assert.equal(result.text, 'ok');
  assert.match(session.history.find((m) => m.role === 'tool').content, /No tool named "nope"/);
});

test('the loop refuses to run forever', async () => {
  const forever = {
    name: 'fake',
    async *stream() {
      yield {
        type: 'done',
        text: '',
        toolCalls: [{ id: 'c', name: 'noop', input: {} }],
        usage: {},
      };
    },
  };
  const session = createChatSession({
    provider: forever,
    model: 'test-model',
    tools: [{ name: 'noop', description: 'noop', run: async () => 'ok' }],
  });

  await assert.rejects(() => session.send('spin'), /without finishing/);
});

test('anthropic wire format merges consecutive tool results into one turn', () => {
  const wire = anthropicWire([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'working',
      toolCalls: [
        { id: 'a', name: 't1', input: {} },
        { id: 'b', name: 't2', input: {} },
      ],
    },
    { role: 'tool', toolCallId: 'a', name: 't1', content: 'one' },
    { role: 'tool', toolCallId: 'b', name: 't2', content: 'two', isError: true },
  ]);

  assert.equal(wire.length, 3, 'the two tool results must share a single user turn');
  assert.equal(wire[1].content[0].type, 'text');
  assert.equal(wire[1].content[1].type, 'tool_use');
  assert.equal(wire[2].role, 'user');
  assert.equal(wire[2].content.length, 2);
  assert.equal(wire[2].content[1].is_error, true);
});

test('openai wire format serializes tool arguments to a JSON string', () => {
  const wire = openaiWire([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't1', input: { x: 1 } }] },
    { role: 'tool', toolCallId: 'a', name: 't1', content: 'result' },
  ]);

  assert.equal(wire[1].tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(wire[1].content, null);
  assert.equal(wire[2].role, 'tool');
  assert.equal(wire[2].tool_call_id, 'a');
});

test('approval is requested before the tool-start event is emitted', async () => {
  // The chat CLI relies on this order: it tears down the spinner and any open
  // prose block inside `approve`, because by the time `tool-start` arrives the
  // readline prompt has already been drawn. Reordering core/chat.js would
  // silently corrupt the approval prompt, so pin the contract here.
  const order = [];
  const session = createChatSession({
    provider: fakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] },
      { text: 'done' },
    ]),
    model: 'test-model',
    tools: [
      {
        name: 'echo',
        description: 'echo',
        needsApproval: true,
        inputSchema: { type: 'object' },
        run: async () => 'ok',
      },
    ],
    approve: async () => {
      order.push('approve');
      return true;
    },
    onEvent: (evt) => {
      if (evt.type === 'tool-start' || evt.type === 'tool-denied') order.push(evt.type);
    },
  });

  await session.send('go');

  assert.deepEqual(order, ['approve', 'tool-start']);
});

test('a denied tool never emits tool-start', async () => {
  const order = [];
  const session = createChatSession({
    provider: fakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] },
      { text: 'done' },
    ]),
    model: 'test-model',
    tools: [
      {
        name: 'echo',
        description: 'echo',
        needsApproval: true,
        inputSchema: { type: 'object' },
        run: async () => assert.fail('a denied tool must not run'),
      },
    ],
    approve: async () => {
      order.push('approve');
      return false;
    },
    onEvent: (evt) => {
      if (evt.type === 'tool-start' || evt.type === 'tool-denied') order.push(evt.type);
    },
  });

  await session.send('go');

  assert.deepEqual(order, ['approve', 'tool-denied']);
});
