import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  buildArgs,
  buildPrompt,
  parseEventLine,
  readLines,
  createCodexCliProvider,
} from '../src/providers/codex-cli.js';

/**
 * Fake child process factory. `script(child)` runs once the provider has
 * attached its listeners, and drives stdout/stderr/close however a test needs.
 */
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    calls.push({ bin, args, options, child });
    setImmediate(() => script(child, calls.length - 1));
    return child;
  };
  return { spawnImpl, calls };
}

/** Emit JSONL lines then exit cleanly. */
function emitLines(child, lines, code = 0) {
  child.stdout.end(lines.map((l) => `${l}\n`).join(''));
  child.stderr.end('');
  child.emit('close', code);
}

const SESSION = '019fad93-3966-7d73-bb89-8d493bd72280';
const startedLine = `{"type":"thread.started","thread_id":"${SESSION}"}`;
const messageLine = (text, id = 'item_0') =>
  JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const completedLine = (input = 21906, output = 6) =>
  JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: input,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
    },
  });

async function drain(iterator) {
  const events = [];
  for await (const evt of iterator) events.push(evt);
  return events;
}

// ---------------------------------------------------------------- buildArgs

test('buildArgs builds a first-turn exec invocation', () => {
  assert.deepEqual(buildArgs({ prompt: 'hello' }), ['exec', '--json', '--', 'hello']);
});

test('buildArgs pins the model when one is requested', () => {
  assert.deepEqual(buildArgs({ model: 'gpt-5-codex', prompt: 'hi' }), [
    'exec',
    '--json',
    '-m',
    'gpt-5-codex',
    '--',
    'hi',
  ]);
});

test('buildArgs omits the model flag for the auto sentinel', () => {
  assert.deepEqual(buildArgs({ model: 'auto', prompt: 'hi' }), ['exec', '--json', '--', 'hi']);
});

test('buildArgs resumes a captured session, with the id before the prompt', () => {
  assert.deepEqual(buildArgs({ sessionId: SESSION, prompt: 'next', model: 'gpt-5-codex' }), [
    'exec',
    'resume',
    '--json',
    '-m',
    'gpt-5-codex',
    '--',
    SESSION,
    'next',
  ]);
});

test('buildArgs puts the prompt after --, so a leading dash is not a flag', () => {
  const args = buildArgs({ prompt: '--help me' });
  assert.equal(args.at(-1), '--help me');
  assert.equal(args.at(-2), '--');
});

// -------------------------------------------------------------- buildPrompt

test('buildPrompt prepends the system text as a preamble on the first turn', () => {
  const prompt = buildPrompt({
    system: 'You are toris.',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(prompt, '<system>\nYou are toris.\n</system>\n\nhi');
});

test('buildPrompt replays the transcript when there is no session to resume', () => {
  const prompt = buildPrompt({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'tool', content: 'ignored' },
      { role: 'user', content: 'second' },
    ],
  });
  assert.match(prompt, /<user>\nfirst\n<\/user>/);
  assert.match(prompt, /<assistant>\nreply\n<\/assistant>/);
  assert.match(prompt, /<user>\nsecond\n<\/user>/);
  assert.doesNotMatch(prompt, /ignored/);
});

test('buildPrompt sends only the newest user turn once a session exists', () => {
  const prompt = buildPrompt({
    system: 'You are toris.',
    sessionId: SESSION,
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
  });
  assert.equal(prompt, 'second');
});

test('buildPrompt flattens content blocks', () => {
  const prompt = buildPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'block one' },
          { type: 'image', source: {} },
        ],
      },
    ],
  });
  assert.equal(prompt, 'block one');
});

// ----------------------------------------------------------- parseEventLine

test('parseEventLine recognises the verified codex event shapes', () => {
  assert.deepEqual(parseEventLine(startedLine), { kind: 'session', sessionId: SESSION });
  assert.deepEqual(parseEventLine(messageLine('PONG')), { kind: 'text', delta: 'PONG' });
  assert.deepEqual(parseEventLine(completedLine(10, 3)), {
    kind: 'done',
    usage: { inputTokens: 10, outputTokens: 3 },
  });
});

test('parseEventLine skips malformed, empty and uninteresting lines', () => {
  assert.equal(parseEventLine('not json at all'), null);
  assert.equal(parseEventLine('{"type":"item.completed"'), null);
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   '), null);
  assert.equal(parseEventLine('null'), null);
  assert.equal(parseEventLine('{"type":"turn.started"}'), null);
  // codex emits notice items that are not part of the answer
  assert.equal(
    parseEventLine('{"type":"item.completed","item":{"id":"i","type":"error","message":"notice"}}'),
    null,
  );
});

test('parseEventLine defaults missing usage counters to zero', () => {
  assert.deepEqual(parseEventLine('{"type":"turn.completed"}'), {
    kind: 'done',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
});

// ---------------------------------------------------------------- readLines

test('readLines rejoins a record split across chunk boundaries', async () => {
  const source = new PassThrough();
  const collected = drain(readLines(source));
  source.write('{"a":');
  source.write('1}\n{"b":2}\n{"c"');
  source.write(':3}');
  source.end();
  assert.deepEqual(await collected, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

// ------------------------------------------------------------------- stream

test('stream yields text deltas then exactly one done event', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    emitLines(child, [
      startedLine,
      messageLine('Hello '),
      messageLine('world', 'item_1'),
      completedLine(21906, 6),
    ]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  assert.equal(provider.name, 'codex-cli');

  const events = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

  assert.deepEqual(
    events.filter((e) => e.type === 'text'),
    [
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'world' },
    ],
  );
  const done = events.filter((e) => e.type === 'done');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0], {
    type: 'done',
    text: 'Hello world',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 21906, outputTokens: 6 },
  });
  assert.equal(calls[0].bin, 'codex');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('stream buffers JSONL records split across stdout chunks', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    const payload = [startedLine, messageLine('chunked'), completedLine(5, 2)]
      .map((l) => `${l}\n`)
      .join('');
    // Deliberately cut mid-object, several times.
    child.stdout.write(payload.slice(0, 30));
    child.stdout.write(payload.slice(30, 95));
    child.stdout.end(payload.slice(95));
    child.stderr.end('');
    child.emit('close', 0);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  const events = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.text, 'chunked');
  assert.deepEqual(done.usage, { inputTokens: 5, outputTokens: 2 });
});

test('stream skips malformed lines without failing the turn', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    emitLines(child, [
      startedLine,
      'not json',
      '{"type":"item.completed"',
      '{"type":"turn.started"}',
      messageLine('survived'),
      completedLine(1, 1),
    ]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  const events = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(events.find((e) => e.type === 'done').text, 'survived');
});

test('stream resumes with the captured session id on the second turn', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    emitLines(child, [startedLine, messageLine('ok'), completedLine()]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  const messages = [{ role: 'user', content: 'first' }];
  await drain(provider.stream({ messages, system: 'sys' }));

  const followUp = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
  ];
  await drain(provider.stream({ messages: followUp, system: 'sys' }));

  assert.deepEqual(calls[0].args, ['exec', '--json', '--', '<system>\nsys\n</system>\n\nfirst']);
  assert.deepEqual(calls[1].args, ['exec', 'resume', '--json', '--', SESSION, 'second']);
});

test('stream falls back to a transcript replay when no session id was captured', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    // No thread.started event -> nothing to resume with.
    emitLines(child, [messageLine('ok'), completedLine()]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await drain(provider.stream({ messages: [{ role: 'user', content: 'first' }] }));
  await drain(
    provider.stream({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    }),
  );

  assert.equal(calls[1].args[0], 'exec');
  assert.notEqual(calls[1].args[1], 'resume');
  assert.match(calls[1].args.at(-1), /<user>\nsecond\n<\/user>/);
});

test('stream never mutates the caller inputs', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    emitLines(child, [startedLine, messageLine('ok'), completedLine()]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  const messages = [{ role: 'user', content: 'first' }];
  const snapshot = structuredClone(messages);
  await drain(provider.stream({ messages }));
  assert.deepEqual(messages, snapshot);
});

// ------------------------------------------------------------------- errors

test('stream raises E_PROVIDER_CLI with the stderr tail on a non-zero exit', async () => {
  const noise = 'x'.repeat(700);
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.end('');
    child.stderr.end(`${noise}boom: model unavailable`);
    child.emit('close', 3);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await assert.rejects(
    () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    (e) => {
      assert.equal(e.code, 'E_PROVIDER_CLI');
      assert.match(e.message, /exited with code 3/);
      assert.match(e.message, /boom: model unavailable/);
      // tail is capped, so the head of the noise is dropped
      assert.ok(e.message.length < 700);
      return true;
    },
  );
});

test('stream names the binary when it is not installed', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.end('');
    child.stderr.end('');
    child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
  });
  const provider = createCodexCliProvider({ spawnImpl, bin: 'nope' });

  await assert.rejects(
    () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    (e) => {
      assert.equal(e.code, 'E_PROVIDER_CLI');
      assert.match(e.message, /Could not run "nope"/);
      return true;
    },
  );
});

test('stream raises E_PROVIDER_STREAM when the terminal event never arrives', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    emitLines(child, [startedLine, messageLine('partial')]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await assert.rejects(
    () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    (e) => {
      assert.equal(e.code, 'E_PROVIDER_STREAM');
      assert.match(e.message, /without a terminal event/);
      return true;
    },
  );
});

test('stream surfaces a reported turn failure', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    emitLines(child, [
      startedLine,
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}',
    ]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await assert.rejects(
    () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    (e) => {
      assert.equal(e.code, 'E_PROVIDER_CLI');
      assert.match(e.message, /usage limit reached/);
      return true;
    },
  );
});

test('stream kills the child and reports cancellation when the signal aborts', async () => {
  const controller = new AbortController();
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.write(`${startedLine}\n`);
    controller.abort();
    setImmediate(() => {
      child.stdout.end('');
      child.stderr.end('');
      child.emit('close', 143);
    });
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await assert.rejects(
    () =>
      drain(
        provider.stream({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
      ),
    (e) => {
      assert.equal(e.code, 'E_CANCELLED');
      assert.match(e.message, /cancelled/);
      return true;
    },
  );
  assert.equal(calls[0].child.killed, true);
});

test('stream enforces the turn timeout', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.write(`${startedLine}\n`);
    setTimeout(() => {
      child.stdout.end('');
      child.stderr.end('');
      child.emit('close', 143);
    }, 30);
  });
  const provider = createCodexCliProvider({ spawnImpl, timeoutMs: 5 });

  await assert.rejects(
    () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    (e) => {
      assert.equal(e.code, 'E_PROVIDER_CLI');
      assert.match(e.message, /timeout/);
      return true;
    },
  );
});

// ----------------------------------------------------------------- complete

test('complete drains the stream and returns the done event', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    emitLines(child, [
      startedLine,
      messageLine('Hi '),
      messageLine('there', 'item_1'),
      completedLine(12, 4),
    ]);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(result, {
    type: 'done',
    text: 'Hi there',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 12, outputTokens: 4 },
  });
});

test('complete propagates provider errors', async () => {
  const { spawnImpl } = fakeSpawn((child) => {
    child.stdout.end('');
    child.stderr.end('nope');
    child.emit('close', 1);
  });
  const provider = createCodexCliProvider({ spawnImpl });

  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), {
    code: 'E_PROVIDER_CLI',
  });
});
