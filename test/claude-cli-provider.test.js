import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  buildArgs,
  createClaudeCliProvider,
  createNdjsonParser,
  lastUserPrompt,
} from '../src/providers/claude-cli.js';

// --- fixtures ---------------------------------------------------------------

const line = (obj) => `${JSON.stringify(obj)}\n`;

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1' };

/** Real transcripts interleave 'thinking' blocks; only text should surface. */
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
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

const USER = [{ role: 'user', content: 'yo' }];

/** A stand-in for a ChildProcess: event emitter + two readable pipes. */
function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signalled = null;
  child.kill = (sig) => {
    child.signalled = sig;
    return true;
  };
  return child;
}

/**
 * @param {(child: any, index: number) => void} script driven once the generator
 *   is already awaiting, so nothing is written before we are listening.
 */
function fakeSpawn(script) {
  const calls = [];
  const impl = (bin, args, options) => {
    const child = mockChild();
    calls.push({ bin, args, options, child });
    queueMicrotask(() => script(child, calls.length - 1));
    return child;
  };
  impl.calls = calls;
  return impl;
}

/** Feed lines, then close, mimicking a finished CLI run. */
function drive(child, lines, { code = 0, stderr = '' } = {}) {
  for (const l of lines) child.stdout.write(l);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  setTimeout(() => child.emit('close', code), 0);
}

const happyPath = (child) =>
  drive(child, [line(INIT), line(assistant('ok')), line(resultOk('ok'))]);

async function collect(iterable) {
  const events = [];
  for await (const evt of iterable) events.push(evt);
  return events;
}

// --- pure helpers -----------------------------------------------------------

test('buildArgs: first turn appends the system prompt and omits --model for auto', () => {
  assert.deepEqual(buildArgs({ model: 'auto', system: 'be terse', prompt: 'yo' }), [
    '--append-system-prompt',
    'be terse',
    '-p',
    'yo',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
});

test('buildArgs: a falsy model also omits --model', () => {
  assert.equal(buildArgs({ model: null, prompt: 'yo' }).includes('--model'), false);
});

test('buildArgs: a concrete model is forwarded', () => {
  const args = buildArgs({ model: 'claude-x', prompt: 'yo' });
  assert.deepEqual(args.slice(0, 2), ['--model', 'claude-x']);
});

test('buildArgs: --resume precedes the prompt and suppresses the system prompt', () => {
  const args = buildArgs({ sessionId: 'sess-1', system: 'be terse', prompt: 'again' });
  assert.deepEqual(args, [
    '--resume',
    'sess-1',
    '-p',
    'again',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.equal(args.indexOf('--resume') < args.indexOf('-p'), true);
});

test('buildArgs: a blank system prompt is not sent', () => {
  assert.equal(
    buildArgs({ system: '   ', prompt: 'yo' }).includes('--append-system-prompt'),
    false,
  );
});

test('createNdjsonParser: buffers a line split across chunks and skips junk', () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"type":"a"'), []);
  assert.deepEqual(parser.push('}\nnot json\n{"type":"b"}\n'), [{ type: 'a' }, { type: 'b' }]);
  assert.deepEqual(parser.push('{"type":"c"}'), []);
  assert.deepEqual(parser.flush(), [{ type: 'c' }]);
});

test('lastUserPrompt: takes the newest user turn, ignoring later tool messages', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'second' },
    { role: 'tool', content: 'output' },
  ];
  assert.equal(lastUserPrompt(messages), 'second');
});

test('lastUserPrompt: throws when there is no user message', () => {
  assert.throws(() => lastUserPrompt([{ role: 'assistant', content: 'hi' }]), {
    code: 'E_INVALID_ARG',
  });
});

// --- spawn wiring -----------------------------------------------------------

test('spawns the configured bin with piped stdio and the caller env', async () => {
  const env = { PATH: '/usr/bin' };
  const spawnImpl = fakeSpawn(happyPath);
  const provider = createClaudeCliProvider({ bin: '/opt/claude', env, spawnImpl });

  await collect(provider.stream({ model: 'auto', messages: USER }));

  const call = spawnImpl.calls[0];
  assert.equal(call.bin, '/opt/claude');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.options.env, env);
  assert.equal(provider.name, 'claude-cli');
});

test('first turn passes the system prompt; the resumed turn passes --resume instead', async () => {
  const spawnImpl = fakeSpawn(happyPath);
  const provider = createClaudeCliProvider({ spawnImpl });

  const opts = { model: 'auto', system: 'be terse', messages: USER };
  await collect(provider.stream(opts));
  await collect(provider.stream(opts));

  assert.deepEqual(spawnImpl.calls[0].args, [
    '--append-system-prompt',
    'be terse',
    '-p',
    'yo',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.deepEqual(spawnImpl.calls[1].args, [
    '--resume',
    'sess-1',
    '-p',
    'yo',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
});

test('a pinned model is forwarded on every turn', async () => {
  const spawnImpl = fakeSpawn(happyPath);
  const provider = createClaudeCliProvider({ spawnImpl });

  await collect(provider.stream({ model: 'claude-x', messages: USER }));

  assert.equal(spawnImpl.calls[0].args.includes('--model'), true);
  assert.equal(spawnImpl.calls[0].args[spawnImpl.calls[0].args.indexOf('--model') + 1], 'claude-x');
});

// --- streaming ---------------------------------------------------------------

test('yields a text delta per text block, then one done event with usage', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [
      line(INIT),
      line(assistant('he')),
      line(assistant('llo')),
      line(resultOk('hello', 11, 7)),
    ]),
  );
  const provider = createClaudeCliProvider({ spawnImpl });

  const events = await collect(provider.stream({ model: 'auto', messages: USER }));

  assert.deepEqual(events, [
    { type: 'text', delta: 'he' },
    { type: 'text', delta: 'llo' },
    {
      type: 'done',
      text: 'hello',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 7 },
    },
  ]);
});

test('a JSON line split across two chunks is still parsed', async () => {
  const whole = line(assistant('split'));
  const cut = Math.floor(whole.length / 2);
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.write(line(INIT));
    child.stdout.write(whole.slice(0, cut));
    setTimeout(() => drive(child, [whole.slice(cut), line(resultOk('split'))]), 0);
  });
  const provider = createClaudeCliProvider({ spawnImpl });

  const events = await collect(provider.stream({ model: 'auto', messages: USER }));

  assert.deepEqual(events[0], { type: 'text', delta: 'split' });
  assert.equal(events.at(-1).text, 'split');
});

test('malformed and unknown lines are skipped', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [
      line(INIT),
      '{not json at all\n',
      '\n',
      line({ type: 'rate_limit_event' }),
      line(assistant('fine')),
      line(resultOk('fine')),
    ]),
  );
  const provider = createClaudeCliProvider({ spawnImpl });

  const events = await collect(provider.stream({ model: 'auto', messages: USER }));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: 'text', delta: 'fine' });
});

test('falls back to the result text when no assistant block was seen', async () => {
  const spawnImpl = fakeSpawn((child) => drive(child, [line(INIT), line(resultOk('from result'))]));
  const provider = createClaudeCliProvider({ spawnImpl });

  const events = await collect(provider.stream({ model: 'auto', messages: USER }));

  assert.deepEqual(events, [
    {
      type: 'done',
      text: 'from result',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ]);
});

test('missing usage defaults to zeros', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [line(INIT), line({ type: 'result', subtype: 'success', result: 'ok' })]),
  );
  const provider = createClaudeCliProvider({ spawnImpl });

  const [done] = await collect(provider.stream({ model: 'auto', messages: USER }));

  assert.deepEqual(done.usage, { inputTokens: 0, outputTokens: 0 });
});

test('complete() drains the stream and returns the final event', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [line(INIT), line(assistant('ok')), line(resultOk('ok', 3, 4))]),
  );
  const provider = createClaudeCliProvider({ spawnImpl });

  const completion = await provider.complete({ model: 'auto', messages: USER });

  assert.deepEqual(completion, {
    type: 'done',
    text: 'ok',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 4 },
  });
});

// --- failures ----------------------------------------------------------------

test('a non-zero exit reports the stderr tail', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [line(INIT)], { code: 2, stderr: 'boom: credentials expired' }),
  );
  const provider = createClaudeCliProvider({ bin: 'claude', spawnImpl });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.equal(err.code, 'E_PROVIDER_CLI');
    assert.match(err.message, /exited with code 2/);
    assert.match(err.message, /boom: credentials expired/);
    return true;
  });
});

test('only the last 500 characters of stderr are reported', async () => {
  const noise = `${'x'.repeat(900)}TAIL_MARKER`;
  const spawnImpl = fakeSpawn((child) => drive(child, [], { code: 1, stderr: noise }));
  const provider = createClaudeCliProvider({ spawnImpl });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.match(err.message, /TAIL_MARKER/);
    assert.equal(err.message.length < 700, true);
    return true;
  });
});

test('a spawn error names the bin and points at install/login', async () => {
  const spawnImpl = fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  });
  const provider = createClaudeCliProvider({ bin: 'claude', spawnImpl });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.equal(err.code, 'E_PROVIDER_CLI');
    assert.match(err.message, /"claude"/);
    assert.match(err.message, /ENOENT/);
    assert.match(err.message, /claude login/);
    return true;
  });
});

test('a clean exit with no result event is a stream error', async () => {
  const spawnImpl = fakeSpawn((child) => drive(child, [line(INIT), line(assistant('partial'))]));
  const provider = createClaudeCliProvider({ spawnImpl });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.equal(err.code, 'E_PROVIDER_STREAM');
    assert.match(err.message, /without a result event/);
    return true;
  });
});

test('a result event flagged is_error fails the turn', async () => {
  const spawnImpl = fakeSpawn((child) =>
    drive(child, [
      line(INIT),
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: sess-1'],
      }),
    ]),
  );
  const provider = createClaudeCliProvider({ spawnImpl });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.equal(err.code, 'E_PROVIDER_CLI');
    assert.match(err.message, /No conversation found/);
    return true;
  });
});

test('aborting the signal kills the child and cancels the turn', async () => {
  const controller = new AbortController();
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.write(line(INIT));
    setTimeout(() => controller.abort(), 0);
  });
  const provider = createClaudeCliProvider({ spawnImpl });

  await assert.rejects(
    collect(provider.stream({ model: 'auto', messages: USER, signal: controller.signal })),
    { code: 'E_CANCELLED' },
  );
  assert.equal(spawnImpl.calls[0].child.signalled, 'SIGTERM');
});

test('an already-aborted signal never spawns anything', async () => {
  const spawnImpl = fakeSpawn(happyPath);
  const provider = createClaudeCliProvider({ spawnImpl });

  await assert.rejects(
    collect(provider.stream({ model: 'auto', messages: USER, signal: AbortSignal.abort() })),
    { code: 'E_CANCELLED' },
  );
  assert.equal(spawnImpl.calls.length, 0);
});

test('a hung CLI is killed once timeoutMs elapses', async () => {
  const spawnImpl = fakeSpawn((child) => child.stdout.write(line(INIT)));
  const provider = createClaudeCliProvider({ spawnImpl, timeoutMs: 20 });

  await assert.rejects(collect(provider.stream({ model: 'auto', messages: USER })), (err) => {
    assert.equal(err.code, 'E_PROVIDER_CLI');
    assert.match(err.message, /did not finish within 20ms/);
    return true;
  });
  assert.equal(spawnImpl.calls[0].child.signalled, 'SIGTERM');
});
