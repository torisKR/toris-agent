import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createWarmSession,
  encodeUserTurn,
  warmArgs,
  WARM_UNAVAILABLE,
} from '../src/providers/claude-cli-warm.js';
import { createClaudeCliProvider } from '../src/providers/claude-cli.js';

// --- fixtures ---------------------------------------------------------------

const line = (obj) => `${JSON.stringify(obj)}\n`;

const INIT = { type: 'system', subtype: 'init', session_id: 'warm-1' };

const partial = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

const assistant = (text) => ({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: '…' },
      { type: 'text', text },
    ],
  },
});

const resultOk = (text, inputTokens = 0, outputTokens = 0) => ({
  type: 'result',
  subtype: 'success',
  result: text,
  is_error: false,
  session_id: 'warm-1',
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

const USER = [{ role: 'user', content: 'yo' }];

/** A stand-in for a long-lived ChildProcess, with a writable stdin we can read. */
function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  // Attached at construction, because the session writes the first turn the
  // instant it spawns: a listener added later would miss it.
  child.stdin.on('data', (chunk) => {
    const raw = String(chunk);
    child.written.push(raw);
    child.respond?.(JSON.parse(raw).message.content[0].text, child);
  });
  child.signals = [];
  child.kill = (sig) => {
    child.signals.push(sig);
    return true;
  };
  child.unref = () => {};
  return child;
}

/**
 * @param {(child: any, index: number) => void} [script]
 * @param {{immediate?: boolean}} [opts] `immediate` runs the script while the
 *   child is being created, which is the only chance to install a `respond`
 *   hook before the session writes its first turn.
 */
function fakeSpawn(script = () => {}, { immediate = false } = {}) {
  const calls = [];
  const impl = (bin, args, options) => {
    const child = mockChild();
    calls.push({ bin, args, options, child });
    const run = () => script(child, calls.length - 1);
    if (immediate) run();
    else queueMicrotask(run);
    return child;
  };
  impl.calls = calls;
  return impl;
}

async function collect(iterable) {
  const events = [];
  for await (const evt of iterable) events.push(evt);
  return events;
}

/** Wait until the child has been handed a user turn, then reply with `lines`. */
async function replyOnce(child, lines) {
  for (let i = 0; i < 200 && child.written.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  for (const l of lines) child.stdout.write(l);
}

const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta);

// --- argv and framing -------------------------------------------------------

test('warm argv asks for stdin streaming, and omits --model for auto', () => {
  assert.deepEqual(warmArgs({ model: 'auto' }), [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--print',
    '--include-partial-messages',
  ]);
});

test('warm argv carries an explicit model and system prompt', () => {
  const args = warmArgs({ model: 'opus', system: 'be terse' });
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'be terse');
});

test('a user turn is one NDJSON line in the shape the CLI expects', () => {
  const encoded = encodeUserTurn('hello');
  assert.ok(encoded.endsWith('\n'), 'the CLI reads line by line');
  assert.equal(encoded.indexOf('\n'), encoded.length - 1, 'exactly one line');
  assert.deepEqual(JSON.parse(encoded), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
});

test('an embedded newline cannot break the framing', () => {
  const encoded = encodeUserTurn('one\ntwo');
  assert.equal(encoded.indexOf('\n'), encoded.length - 1);
  assert.equal(JSON.parse(encoded).message.content[0].text, 'one\ntwo');
});

// --- warm session behaviour -------------------------------------------------

test('the child boots before the first turn is asked for', () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn });

  assert.equal(warm.prewarm(), true);
  assert.equal(spawn.calls.length, 1, 'boot overlaps with the user typing');
  assert.equal(warm.prewarm(), false, 'a second prewarm does not spawn again');
  assert.equal(spawn.calls.length, 1);
  warm.dispose();
});

test('a warm turn streams partial deltas and ends on the result event', async () => {
  const spawn = fakeSpawn((child) =>
    replyOnce(child, [
      line(INIT),
      line(partial('he')),
      line(partial('llo')),
      line(assistant('hello')),
      line(resultOk('hello', 7, 3)),
    ]),
  );
  const warm = createWarmSession({ spawnImpl: spawn });

  const events = await collect(warm.turn({ prompt: 'yo' }));

  assert.deepEqual(texts(events), ['he', 'llo'], 'token deltas reach the caller');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'hello', 'the completed block is not replayed on top');
  assert.deepEqual(done.usage, { inputTokens: 7, outputTokens: 3 });
  warm.dispose();
});

test('a CLI without partial messages still streams its assistant blocks', async () => {
  const spawn = fakeSpawn((child) =>
    replyOnce(child, [line(INIT), line(assistant('whole')), line(resultOk('whole'))]),
  );
  const warm = createWarmSession({ spawnImpl: spawn });

  const events = await collect(warm.turn({ prompt: 'yo' }));

  assert.deepEqual(texts(events), ['whole']);
  assert.equal(events.at(-1).text, 'whole');
  warm.dispose();
});

test('a second turn reuses the same process instead of paying boot again', async () => {
  const spawn = fakeSpawn(
    (child) => {
      child.respond = (prompt) => {
        child.stdout.write(line(assistant(`re: ${prompt}`)));
        child.stdout.write(line(resultOk(`re: ${prompt}`)));
      };
    },
    { immediate: true },
  );
  const warm = createWarmSession({ spawnImpl: spawn });

  const first = await collect(warm.turn({ prompt: 'one' }));
  const second = await collect(warm.turn({ prompt: 'two' }));

  assert.equal(spawn.calls.length, 1, 'one process served both turns');
  assert.equal(first.at(-1).text, 're: one');
  assert.equal(second.at(-1).text, 're: two');
  warm.dispose();
});

test('the session id is reported so a cold fallback resumes the same chat', async () => {
  const seen = [];
  const spawn = fakeSpawn((child) => replyOnce(child, [line(INIT), line(resultOk(''))]));
  const warm = createWarmSession({ spawnImpl: spawn, onSessionId: (id) => seen.push(id) });

  await collect(warm.turn({ prompt: 'yo' }));

  assert.ok(seen.includes('warm-1'));
  warm.dispose();
});

test('a child that dies before answering asks the caller to fall back', async () => {
  const spawn = fakeSpawn((child) => {
    child.stderr.write('unknown option --input-format');
    setTimeout(() => child.emit('close', 1), 0);
  });
  const warm = createWarmSession({ spawnImpl: spawn });

  const err = await collect(warm.turn({ prompt: 'yo' })).then(
    () => null,
    (e) => e,
  );

  assert.equal(err?.code, WARM_UNAVAILABLE, 'an old CLI is a fallback, not a failure');
  assert.match(err.message, /unknown option/, 'the reason survives for diagnosis');
  warm.dispose();
});

test('a child that dies mid-answer is a real error, not a silent retry', async () => {
  const spawn = fakeSpawn((child) =>
    replyOnce(child, [line(partial('half'))]).then(() =>
      setTimeout(() => child.emit('close', 1), 0),
    ),
  );
  const warm = createWarmSession({ spawnImpl: spawn });

  const events = [];
  const err = await (async () => {
    try {
      for await (const evt of warm.turn({ prompt: 'yo' })) events.push(evt);
      return null;
    } catch (e) {
      return e;
    }
  })();

  assert.deepEqual(texts(events), ['half'], 'what was printed stays printed');
  assert.notEqual(err?.code, WARM_UNAVAILABLE, 'retrying would print the answer twice');
  assert.equal(err?.code, 'E_PROVIDER_STREAM');
  warm.dispose();
});

test('a failed turn is reported rather than swallowed', async () => {
  const spawn = fakeSpawn((child) =>
    replyOnce(child, [
      line({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }),
    ]),
  );
  const warm = createWarmSession({ spawnImpl: spawn });

  await assert.rejects(collect(warm.turn({ prompt: 'yo' })), /rate limited/);
  warm.dispose();
});

test('abort interrupts the turn with SIGINT rather than tearing down the session', async () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn });
  const ac = new AbortController();

  const running = collect(warm.turn({ prompt: 'yo', signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();

  await assert.rejects(running, (err) => err.code === 'E_CANCELLED');
  assert.deepEqual(spawn.calls[0].child.signals, ['SIGINT'], 'the turn is cancelled, not killed');
  warm.dispose();
});

test('an already-aborted signal never reaches the CLI', async () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn });

  await assert.rejects(
    collect(warm.turn({ prompt: 'yo', signal: AbortSignal.abort() })),
    (err) => err.code === 'E_CANCELLED',
  );
  assert.equal(spawn.calls.length, 0);
  warm.dispose();
});

test('a turn that outruns its timeout is killed and reported', async () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn, timeoutMs: 5 });

  await assert.rejects(collect(warm.turn({ prompt: 'yo' })), /did not finish within 5ms/);
  assert.ok(spawn.calls[0].child.signals.includes('SIGTERM'));
  warm.dispose();
});

test('turns are serialised: a second turn cannot jump an in-flight one', async () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn });

  const first = collect(warm.turn({ prompt: 'one' }));
  await new Promise((r) => setTimeout(r, 5));

  await assert.rejects(collect(warm.turn({ prompt: 'two' })), (err) => {
    assert.equal(err.code, WARM_UNAVAILABLE);
    return true;
  });

  spawn.calls[0].child.stdout.write(line(resultOk('done')));
  await first;
  warm.dispose();
});

test('dispose ends the child, so no claude process is orphaned', async () => {
  const spawn = fakeSpawn();
  const warm = createWarmSession({ spawnImpl: spawn });
  warm.prewarm();

  warm.dispose();

  assert.deepEqual(spawn.calls[0].child.signals, ['SIGTERM']);
  assert.equal(warm.isDisabled(), true);
  await assert.rejects(
    collect(warm.turn({ prompt: 'yo' })),
    (err) => err.code === WARM_UNAVAILABLE,
  );
});

// --- provider integration ---------------------------------------------------

test('the provider serves a warm turn without spawning per turn', async () => {
  const spawn = fakeSpawn(
    (child) => {
      child.respond = () => {
        child.stdout.write(line(partial('hi')));
        child.stdout.write(line(resultOk('hi', 1, 2)));
      };
    },
    { immediate: true },
  );
  const provider = createClaudeCliProvider({ warm: true, spawnImpl: spawn });

  await collect(provider.stream({ messages: USER }));
  await collect(provider.stream({ messages: USER }));

  assert.equal(spawn.calls.length, 1, 'the CLI booted once for two turns');
  assert.ok(spawn.calls[0].args.includes('--input-format'));
  provider.dispose();
});

test('the provider falls back to a cold turn when the CLI is too old', async () => {
  const spawn = fakeSpawn((child, index) => {
    if (index === 0) {
      // The warm child rejects the streaming flags outright.
      child.stderr.write('error: unknown option --input-format');
      setTimeout(() => child.emit('close', 1), 0);
      return;
    }
    child.stdout.write(line(INIT));
    child.stdout.write(line(assistant('cold ok')));
    child.stdout.write(line(resultOk('cold ok')));
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 0);
  });
  const provider = createClaudeCliProvider({ warm: true, spawnImpl: spawn });

  const events = await collect(provider.stream({ messages: USER }));

  assert.deepEqual(texts(events), ['cold ok'], 'the answer arrives exactly once');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(spawn.calls[1].args.includes('-p'), 'the second spawn is the per-turn path');
  provider.dispose();
});

test('a fallback happens once, not on every later turn', async () => {
  const spawn = fakeSpawn((child, index) => {
    if (index === 0) {
      setTimeout(() => child.emit('close', 1), 0);
      return;
    }
    child.stdout.write(line(assistant('cold')));
    child.stdout.write(line(resultOk('cold')));
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 0);
  });
  const provider = createClaudeCliProvider({ warm: true, spawnImpl: spawn });

  await collect(provider.stream({ messages: USER }));
  await collect(provider.stream({ messages: USER }));

  assert.equal(spawn.calls.length, 3, 'one dead warm child, then two cold turns');
  assert.ok(
    spawn.calls.slice(1).every((call) => !call.args.includes('--input-format')),
    'the warm path is not retried once it is ruled out',
  );
  provider.dispose();
});

test('a warm child that dies is replaced, not abandoned', async () => {
  const spawn = fakeSpawn(
    (child) => {
      child.respond = () => {
        child.stdout.write(line(resultOk('answered')));
        setTimeout(() => child.emit('close', 1), 0);
      };
    },
    { immediate: true },
  );
  const provider = createClaudeCliProvider({ warm: true, spawnImpl: spawn });

  await collect(provider.stream({ messages: USER }));
  await new Promise((r) => setTimeout(r, 5));
  const second = await collect(provider.stream({ messages: USER }));

  assert.equal(second.at(-1).text, 'answered');
  assert.equal(spawn.calls.length, 2, 'a fresh warm child, rather than giving up');
  assert.ok(spawn.calls[1].args.includes('--input-format'), 'still the warm path');
  provider.dispose();
});

test('a cold turn after a warm one resumes the same conversation', async () => {
  const spawn = fakeSpawn(
    (child, index) => {
      // The first child answers and dies; its replacement will not start at
      // all, which is what finally sends the provider down the cold path.
      if (index === 0) {
        child.respond = () => {
          child.stdout.write(line(INIT));
          child.stdout.write(line(resultOk('first')));
          setTimeout(() => child.emit('close', 1), 0);
        };
        return;
      }
      if (index === 1) {
        setTimeout(() => child.emit('close', 1), 0);
        return;
      }
      child.stdout.write(line(assistant('second')));
      child.stdout.write(line(resultOk('second')));
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 0);
    },
    { immediate: true },
  );
  const provider = createClaudeCliProvider({ warm: true, spawnImpl: spawn });

  await collect(provider.stream({ messages: USER }));
  await new Promise((r) => setTimeout(r, 5));
  const second = await collect(provider.stream({ messages: USER }));

  assert.deepEqual(texts(second), ['second'], 'the answer arrives once, cold');
  const coldArgs = spawn.calls[2].args;
  assert.equal(coldArgs[0], '--resume');
  assert.equal(coldArgs[1], 'warm-1', 'the warm session id carries over');
  provider.dispose();
});

test('warm is off unless asked for, so batch callers keep per-turn isolation', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.write(line(assistant('ok')));
    child.stdout.write(line(resultOk('ok')));
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 0);
  });
  const provider = createClaudeCliProvider({ spawnImpl: spawn });

  assert.equal(provider.prewarm(), false);
  await collect(provider.stream({ messages: USER }));

  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].args.includes('-p'));
  assert.doesNotThrow(() => provider.dispose());
});
