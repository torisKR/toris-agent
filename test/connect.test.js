import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cmdConnect,
  runConnectWizard,
  detectCandidates,
  selectableCandidates,
  pickCandidate,
  buildConnectedConfig,
  currentChatRoute,
  isCliProvider,
  CONNECTABLE_PROVIDERS,
  DEFAULT_PROFILE_NAME,
} from '../src/cli/commands/connect.js';
import { setColor } from '../src/cli/output.js';
import { EXIT } from '../src/core/errors.js';
import { AUTO_MODEL } from '../src/core/models.js';

setColor(false);

const EMPTY_CONFIG = Object.freeze({
  models: Object.freeze({ profiles: Object.freeze({}), routing: Object.freeze({}) }),
});

/** A detect stub: every bin in `found` resolves, everything else is missing. */
const detectOnly =
  (...found) =>
  (bin) =>
    found.includes(bin) ? `/usr/local/bin/${bin}` : null;
const detectNone = () => null;

/** Scripted stdin. Records prompts so tests can assert what was asked. */
function fakeIo(answers) {
  const queue = [...answers];
  const prompts = [];
  return {
    prompts,
    write() {},
    async question(prompt) {
      prompts.push(prompt);
      if (queue.length === 0) throw new Error('readline closed');
      return queue.shift();
    },
  };
}

/** Records writes instead of touching disk. */
function recordingSave() {
  const calls = [];
  const save = async (home, config) => {
    calls.push({ home, config });
    return config;
  };
  save.calls = calls;
  return save;
}

const scratchHome = () => mkdtemp(join(tmpdir(), 'toris-connect-'));

async function captureStdout(fn) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    const value = await fn();
    return { value, out };
  } finally {
    process.stdout.write = original;
  }
}

const byProvider = (candidates, provider) => candidates.find((one) => one.provider === provider);

// --- candidate detection -----------------------------------------------------

test('a CLI backend is available when its binary is on PATH', () => {
  const candidates = detectCandidates({ env: {}, detect: detectOnly('claude') });

  const claude = byProvider(candidates, 'claude-cli');
  assert.equal(claude.available, true);
  assert.equal(claude.kind, 'cli');
  assert.equal(claude.path, '/usr/local/bin/claude');
});

test('a missing binary is unavailable and the reason names the bin', () => {
  const candidates = detectCandidates({ env: {}, detect: detectNone });

  const codex = byProvider(candidates, 'codex-cli');
  assert.equal(codex.available, false);
  assert.match(codex.reason, /"codex" not on PATH/);
});

test('an API backend is available only when its key is in the injected env', () => {
  const candidates = detectCandidates({
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    detect: detectNone,
  });

  assert.equal(byProvider(candidates, 'anthropic').available, true);
  assert.equal(byProvider(candidates, 'openai').available, false);
  assert.match(byProvider(candidates, 'openai').reason, /OPENAI_API_KEY not set/);
});

test('a blank API key does not count as available', () => {
  const candidates = detectCandidates({ env: { OPENAI_API_KEY: '   ' }, detect: detectNone });

  assert.equal(byProvider(candidates, 'openai').available, false);
});

test('detection probes the binary configured under providers.<name>.bin', () => {
  const seen = [];
  const detect = (bin) => {
    seen.push(bin);
    return null;
  };

  detectCandidates({
    env: {},
    detect,
    config: { providers: { claude: { bin: '/opt/custom-claude' } } },
  });

  assert.ok(seen.includes('/opt/custom-claude'), `probed: ${seen.join(', ')}`);
  assert.ok(seen.includes('codex'), 'unconfigured providers keep their default bin');
});

test('detection reads the real environment and PATH by default', () => {
  const candidates = detectCandidates();

  assert.equal(candidates.length, CONNECTABLE_PROVIDERS.length);
  for (const candidate of candidates) assert.equal(typeof candidate.available, 'boolean');
});

// --- menu numbering ----------------------------------------------------------

test('menu numbers cover available backends only', () => {
  const candidates = detectCandidates({
    env: { OPENAI_API_KEY: 'sk-test' },
    detect: detectOnly('codex'),
  });

  const selectable = selectableCandidates(candidates);

  assert.deepEqual(
    selectable.map((one) => one.provider),
    ['codex-cli', 'openai'],
  );
  assert.equal(pickCandidate(candidates, '1').provider, 'codex-cli');
  assert.equal(pickCandidate(candidates, '2').provider, 'openai');
});

test('out-of-range, zero and non-numeric answers select nothing', () => {
  const candidates = detectCandidates({ env: {}, detect: detectOnly('claude') });

  for (const answer of ['0', '2', '', 'x', '-1', undefined]) {
    assert.equal(pickCandidate(candidates, answer), null, `answer: ${String(answer)}`);
  }
});

// --- immutable config construction -------------------------------------------

test('buildConnectedConfig leaves the original config object untouched', () => {
  const original = {
    version: 1,
    models: { profiles: { old: { provider: 'openai', model: 'x' } }, routing: { chat: 'old' } },
  };
  const snapshot = JSON.stringify(original);

  const next = buildConnectedConfig(original, {
    name: 'main',
    provider: 'claude-cli',
    model: '',
  });

  assert.equal(JSON.stringify(original), snapshot, 'input config must not be mutated');
  assert.notEqual(next, original);
  assert.notEqual(next.models, original.models);
  assert.notEqual(next.models.profiles, original.models.profiles);
  assert.notEqual(next.models.routing, original.models.routing);
});

test('connecting preserves existing profiles and unrelated config keys', () => {
  const original = {
    version: 1,
    defaultAutonomy: 'L3',
    models: { profiles: { old: { provider: 'openai', model: 'x' } }, routing: { review: 'old' } },
  };

  const next = buildConnectedConfig(original, {
    name: 'main',
    provider: 'claude-cli',
    model: '',
  });

  assert.deepEqual(next.models.profiles.old, { provider: 'openai', model: 'x' });
  assert.equal(next.models.routing.review, 'old', 'other roles survive');
  assert.equal(next.defaultAutonomy, 'L3');
  assert.equal(next.version, 1);
});

test('the new profile is written and chat is routed to it', () => {
  const next = buildConnectedConfig(EMPTY_CONFIG, {
    name: 'work',
    provider: 'anthropic',
    model: 'typed-by-user',
  });

  assert.deepEqual(next.models.profiles.work, {
    provider: 'anthropic',
    model: 'typed-by-user',
  });
  assert.equal(next.models.routing.chat, 'work');
});

test('an empty name falls back to the default profile name', () => {
  const next = buildConnectedConfig(EMPTY_CONFIG, {
    name: '  ',
    provider: 'codex-cli',
    model: '',
  });

  assert.ok(next.models.profiles[DEFAULT_PROFILE_NAME]);
  assert.equal(next.models.routing.chat, DEFAULT_PROFILE_NAME);
});

test('CLI providers default to the auto sentinel but accept a pin', () => {
  const auto = buildConnectedConfig(EMPTY_CONFIG, { provider: 'claude-cli', model: '' });
  const pinned = buildConnectedConfig(EMPTY_CONFIG, { provider: 'claude-cli', model: 'pinned-id' });

  assert.equal(auto.models.profiles.main.model, AUTO_MODEL);
  assert.equal(pinned.models.profiles.main.model, 'pinned-id');
  assert.equal(isCliProvider('claude-cli'), true);
  assert.equal(isCliProvider('anthropic'), false);
});

test('an API provider without a model fails and names the exact config key', () => {
  assert.throws(
    () => buildConnectedConfig(EMPTY_CONFIG, { name: 'main', provider: 'openai', model: '' }),
    (err) => {
      assert.equal(err.code, 'E_MODEL_REQUIRED');
      assert.match(err.message, /models\.profiles\.main\.model/);
      return true;
    },
  );
});

test('an API provider cannot be pinned to the auto sentinel', () => {
  assert.throws(
    () => buildConnectedConfig(EMPTY_CONFIG, { provider: 'anthropic', model: AUTO_MODEL }),
    /E_MODEL_REQUIRED|auto/,
  );
});

test('an unknown provider is a usage error listing the valid ids', () => {
  assert.throws(
    () => buildConnectedConfig(EMPTY_CONFIG, { provider: 'gemini', model: 'x' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /claude-cli/);
      assert.match(err.message, /anthropic/);
      return true;
    },
  );
});

test('an unusable profile name is rejected before anything is written', () => {
  assert.throws(
    () => buildConnectedConfig(EMPTY_CONFIG, { name: 'bad name!', provider: 'claude-cli' }),
    /Invalid profile name/,
  );
});

test('currentChatRoute reports the routed profile, or null', () => {
  assert.equal(currentChatRoute({ models: { routing: { chat: 'old' } } }), 'old');
  assert.equal(currentChatRoute(EMPTY_CONFIG), null);
  assert.equal(currentChatRoute(undefined), null);
});

// --- wizard ------------------------------------------------------------------

test('the wizard saves the profile chosen from the menu', async () => {
  const save = recordingSave();
  const io = fakeIo(['1', '', '']); // backend 1, auto model, default name

  const result = await runConnectWizard({
    config: EMPTY_CONFIG,
    home: '/tmp/home',
    io,
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.provider, 'claude-cli');
  assert.equal(result.model, AUTO_MODEL);
  assert.equal(result.profile, DEFAULT_PROFILE_NAME);
  assert.equal(save.calls.length, 1);
  assert.equal(save.calls[0].config.models.routing.chat, DEFAULT_PROFILE_NAME);
});

test('an empty menu answer cancels and writes nothing', async () => {
  const save = recordingSave();

  const result = await runConnectWizard({
    config: EMPTY_CONFIG,
    home: '/tmp/home',
    io: fakeIo(['']),
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.cancelled, true);
  assert.equal(save.calls.length, 0, 'cancelling must not write config');
});

test('a closed stream (Ctrl-C) cancels instead of throwing', async () => {
  const save = recordingSave();

  const result = await runConnectWizard({
    config: EMPTY_CONFIG,
    home: '/tmp/home',
    io: fakeIo([]), // question() throws immediately, as on Ctrl-C
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.cancelled, true);
  assert.equal(save.calls.length, 0);
});

test('declining the routing overwrite keeps the old route and writes nothing', async () => {
  const save = recordingSave();
  const config = {
    models: { profiles: { old: { provider: 'openai', model: 'x' } }, routing: { chat: 'old' } },
  };
  const io = fakeIo(['1', '', 'fresh', 'n']);

  const result = await runConnectWizard({
    config,
    home: '/tmp/home',
    io,
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.cancelled, true);
  assert.equal(save.calls.length, 0);
  assert.match(io.prompts.at(-1), /models\.routing\.chat currently points at "old"/);
});

test('confirming the routing overwrite repoints chat to the new profile', async () => {
  const save = recordingSave();
  const config = {
    models: { profiles: { old: { provider: 'openai', model: 'x' } }, routing: { chat: 'old' } },
  };

  const result = await runConnectWizard({
    config,
    home: '/tmp/home',
    io: fakeIo(['1', '', 'fresh', 'y']),
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.ok, true);
  assert.equal(save.calls[0].config.models.routing.chat, 'fresh');
  assert.ok(save.calls[0].config.models.profiles.old, 'the old profile survives');
});

test('re-connecting the already-routed profile does not ask to overwrite', async () => {
  const save = recordingSave();
  const config = {
    models: { profiles: { main: { provider: 'openai', model: 'x' } }, routing: { chat: 'main' } },
  };
  const io = fakeIo(['1', '', 'main']);

  const result = await runConnectWizard({
    config,
    home: '/tmp/home',
    io,
    env: {},
    detect: detectOnly('claude'),
    save,
  });

  assert.equal(result.ok, true);
  assert.equal(
    io.prompts.filter((prompt) => /Repoint/.test(prompt)).length,
    0,
    'no overwrite prompt when the route already points here',
  );
});

test('an API backend is asked for a model id and it is stored verbatim', async () => {
  const save = recordingSave();
  const io = fakeIo(['1', 'user-typed-id', 'api']);

  const result = await runConnectWizard({
    config: EMPTY_CONFIG,
    home: '/tmp/home',
    io,
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    detect: detectNone,
    save,
  });

  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'user-typed-id');
  assert.ok(
    io.prompts.some((prompt) => /Model id/.test(prompt)),
    'the wizard must ask for a model id',
  );
});

test('an API backend with no typed model fails without writing', async () => {
  const save = recordingSave();

  await assert.rejects(
    runConnectWizard({
      config: EMPTY_CONFIG,
      home: '/tmp/home',
      io: fakeIo(['1', '   ']),
      env: { OPENAI_API_KEY: 'sk-test' },
      detect: detectNone,
      save,
    }),
    (err) => {
      assert.equal(err.code, 'E_MODEL_REQUIRED');
      return true;
    },
  );
  assert.equal(save.calls.length, 0);
});

test('the wizard refuses to run when nothing is installed or exported', async () => {
  const save = recordingSave();

  await assert.rejects(
    runConnectWizard({
      config: EMPTY_CONFIG,
      home: '/tmp/home',
      io: fakeIo([]),
      env: {},
      detect: detectNone,
      save,
    }),
    (err) => {
      assert.equal(err.code, 'E_NO_BACKEND');
      return true;
    },
  );
  assert.equal(save.calls.length, 0);
});

// --- non-interactive command -------------------------------------------------

test('--provider writes the profile without prompting and returns OK', async () => {
  const home = await scratchHome();

  const { value } = await captureStdout(() =>
    cmdConnect({ config: EMPTY_CONFIG, home, json: false }, [], {
      provider: 'claude-cli',
      name: 'ci',
    }),
  );

  assert.equal(value, EXIT.OK);
  const written = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(written.models.profiles.ci, { provider: 'claude-cli', model: AUTO_MODEL });
  assert.equal(written.models.routing.chat, 'ci');
});

test('--json prints a machine-readable result and defaults the profile name', async () => {
  const home = await scratchHome();

  const { value, out } = await captureStdout(() =>
    cmdConnect({ config: EMPTY_CONFIG, home, json: true }, [], {
      provider: 'openai',
      model: 'typed-id',
    }),
  );

  assert.equal(value, EXIT.OK);
  const payload = JSON.parse(out);
  assert.equal(payload.ok, true);
  assert.equal(payload.profile, DEFAULT_PROFILE_NAME);
  assert.equal(payload.provider, 'openai');
  assert.equal(payload.model, 'typed-id');
  assert.match(payload.config, /config\.json$/);
});

test('non-interactive API provider without --model fails and names the key', async () => {
  const home = await scratchHome();

  await assert.rejects(
    cmdConnect({ config: EMPTY_CONFIG, home, json: true }, [], { provider: 'anthropic' }),
    (err) => {
      assert.equal(err.code, 'E_MODEL_REQUIRED');
      assert.match(err.message, /models\.profiles\.main\.model/);
      return true;
    },
  );
  await assert.rejects(readFile(join(home, 'config.json'), 'utf8'), /ENOENT/);
});

test('--json without --provider is a usage error, not a hung prompt', async () => {
  const home = await scratchHome();

  await assert.rejects(cmdConnect({ config: EMPTY_CONFIG, home, json: true }, [], {}), (err) => {
    assert.equal(err.code, 'E_USAGE');
    assert.match(err.message, /--provider/);
    return true;
  });
});

test('a bare --provider flag is treated as missing rather than as the value true', async () => {
  const home = await scratchHome();

  await assert.rejects(
    cmdConnect({ config: EMPTY_CONFIG, home, json: true }, [], { provider: true }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      return true;
    },
  );
});

test('non-interactive mode rejects an unknown provider id', async () => {
  const home = await scratchHome();

  await assert.rejects(
    cmdConnect({ config: EMPTY_CONFIG, home, json: true }, [], { provider: 'gemini' }),
    (err) => {
      assert.equal(err.code, 'E_USAGE');
      assert.match(err.message, /codex-cli/);
      return true;
    },
  );
});
