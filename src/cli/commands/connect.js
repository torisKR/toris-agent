import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { saveConfig, configPath } from '../../core/config.js';
import { detectBinary } from '../../core/providers.js';
import {
  API_PROVIDERS,
  CLI_PROVIDERS,
  AUTO_MODEL,
  apiKeyEnvVar,
  readApiKey,
} from '../../core/models.js';
import { EXIT, TorisError, UsageError } from '../../core/errors.js';
import { line, c, keyValues, printJson } from '../output.js';

/** Profile name used when the operator just presses enter. */
export const DEFAULT_PROFILE_NAME = 'main';

/** Role that the wizard wires the new profile into. */
const CHAT_ROLE = 'chat';

/**
 * Every backend the wizard knows how to connect, in menu order.
 * `kind` decides the credential story: a `cli` entry reuses the login the
 * agent CLI already holds, an `api` entry needs a key in the environment.
 * @typedef {{provider:string, label:string, note:string, kind:'cli'|'api', bin:string|null, configKey:string|null}} CandidateSpec
 * @typedef {{provider:string, label:string, note:string, kind:'cli'|'api', bin:string|null, path:string|null, available:boolean, reason:string}} Candidate
 */
const CANDIDATES = Object.freeze([
  Object.freeze({
    provider: 'claude-cli',
    label: 'Claude CLI',
    note: '기존 로그인 재사용',
    kind: 'cli',
    bin: 'claude',
    configKey: 'claude',
  }),
  Object.freeze({
    provider: 'codex-cli',
    label: 'Codex CLI',
    note: '기존 로그인 재사용',
    kind: 'cli',
    bin: 'codex',
    configKey: 'codex',
  }),
  Object.freeze({
    provider: 'anthropic',
    label: 'Anthropic API',
    note: '환경변수 API 키 사용',
    kind: 'api',
    bin: null,
    configKey: null,
  }),
  Object.freeze({
    provider: 'openai',
    label: 'OpenAI API',
    note: '환경변수 API 키 사용',
    kind: 'api',
    bin: null,
    configKey: null,
  }),
]);

/** Provider ids the wizard accepts, for validation and error messages. */
export const CONNECTABLE_PROVIDERS = Object.freeze([...CLI_PROVIDERS, ...API_PROVIDERS]);

export const isCliProvider = (provider) => CLI_PROVIDERS.includes(provider);

/** The binary to probe: config may override it, defaults come from the catalogue. */
function candidateBin(spec, config) {
  const configured = config?.providers?.[spec.configKey]?.bin;
  return typeof configured === 'string' && configured.trim() !== '' ? configured : spec.bin;
}

/**
 * Probe every backend. Pure apart from the injected probes, so tests drive it
 * with a fake env and a fake `detect` instead of touching PATH.
 * @param {{env?:Record<string,string|undefined>, detect?:Function, config?:object}} [opts]
 * @returns {Candidate[]}
 */
export function detectCandidates({ env = process.env, detect = detectBinary, config = null } = {}) {
  return CANDIDATES.map((spec) => {
    if (spec.kind === 'cli') {
      const bin = candidateBin(spec, config);
      const path = detect(bin, { env }) ?? null;
      return Object.freeze({
        provider: spec.provider,
        label: spec.label,
        note: spec.note,
        kind: spec.kind,
        bin,
        path,
        available: path !== null,
        reason: path ?? `"${bin}" not on PATH`,
      });
    }
    const varName = apiKeyEnvVar(spec.provider);
    const hasKey = readApiKey(spec.provider, env) !== null;
    return Object.freeze({
      provider: spec.provider,
      label: spec.label,
      note: spec.note,
      kind: spec.kind,
      bin: null,
      path: null,
      available: hasKey,
      reason: hasKey ? `${varName} set` : `${varName} not set`,
    });
  });
}

/** Only available candidates are selectable; menu numbers follow this list. */
export const selectableCandidates = (candidates) => candidates.filter((one) => one.available);

/**
 * Resolve a typed menu answer to a candidate.
 * @returns {Candidate|null} null when the answer is not a valid choice
 */
export function pickCandidate(candidates, answer) {
  const selectable = selectableCandidates(candidates);
  const index = Number.parseInt(String(answer ?? '').trim(), 10);
  if (!Number.isInteger(index) || index < 1 || index > selectable.length) return null;
  return selectable[index - 1];
}

function assertKnownProvider(provider) {
  if (!CONNECTABLE_PROVIDERS.includes(provider)) {
    throw new UsageError(
      `Unknown provider "${provider}". Valid values for models.profiles.<name>.provider: ` +
        `${CONNECTABLE_PROVIDERS.join(', ')}.`,
    );
  }
}

/** Profile names become config keys, so keep them boring and explicit. */
function normalizeProfileName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (value === '') return DEFAULT_PROFILE_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new UsageError(
      `Invalid profile name "${value}". Use letters, digits, and ". _ : -" only ` +
        '(it becomes the key models.profiles.<name>).',
    );
  }
  return value;
}

/**
 * CLI providers default to the `auto` sentinel; API providers must be pinned by
 * the user, because product code never ships a model id.
 */
function normalizeModel(provider, model, profileName) {
  const value = typeof model === 'string' ? model.trim() : '';
  if (isCliProvider(provider)) return value === '' ? AUTO_MODEL : value;
  if (value === '' || value === AUTO_MODEL) {
    throw new TorisError(
      `Provider "${provider}" needs a concrete model id, so models.profiles.${profileName}.model ` +
        `cannot be empty or "${AUTO_MODEL}".\n` +
        `  Pass --model <model-id>, or set models.profiles.${profileName}.model in ` +
        'your config.',
      'E_MODEL_REQUIRED',
    );
  }
  return value;
}

/**
 * Build the config that connecting produces. Never mutates the input: every
 * container on the path to the change is copied, so a caller holding the old
 * object still sees the old profiles.
 * @param {object} config
 * @param {{name?:string, provider:string, model?:string}} choice
 * @returns {object} a fresh config
 */
export function buildConnectedConfig(config, { name, provider, model }) {
  assertKnownProvider(provider);
  const profileName = normalizeProfileName(name);
  const resolvedModel = normalizeModel(provider, model, profileName);
  const models = config?.models ?? {};
  return {
    ...config,
    models: {
      ...models,
      profiles: {
        ...(models.profiles ?? {}),
        [profileName]: { provider, model: resolvedModel },
      },
      routing: {
        ...(models.routing ?? {}),
        [CHAT_ROLE]: profileName,
      },
    },
  };
}

/** The profile `chat` currently routes to, or null when nothing is routed. */
export function currentChatRoute(config) {
  const target = config?.models?.routing?.[CHAT_ROLE];
  return typeof target === 'string' && target !== '' ? target : null;
}

/** Default stdio adapter; tests pass their own `{question, close, write}`. */
function createStdio() {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    question: (prompt) => rl.question(prompt),
    close: () => rl.close(),
    write: line,
  };
}

const YES = /^(y|yes|예|ㅇ)$/i;

/**
 * The interactive wizard. Exported so `toris chat` can run it inline when a
 * user lands on an empty config.
 *
 * @param {{config:object, home:string, io?:{question:Function, close?:Function, write?:Function}, env?:object, detect?:Function, save?:Function}} opts
 * @returns {Promise<{ok:boolean, cancelled:boolean, reason?:string, profile?:string, provider?:string, model?:string, config?:object}>}
 */
export async function runConnectWizard({
  config,
  home,
  io,
  env = process.env,
  detect = detectBinary,
  save = saveConfig,
} = {}) {
  const ownsIo = !io;
  const channel = io ?? createStdio();
  const write = channel.write ?? line;
  const cancelled = (reason) => ({ ok: false, cancelled: true, reason });

  // A closed stream (Ctrl-C, EOF) rejects the pending question. That is a
  // cancellation, not a crash: nothing has been written at that point.
  const ask = async (prompt) => {
    try {
      const answer = await channel.question(prompt);
      return typeof answer === 'string' ? answer : null;
    } catch {
      return null;
    }
  };

  try {
    const candidates = detectCandidates({ env, detect, config });
    const selectable = selectableCandidates(candidates);

    write(c.bold('toris connect'));
    write();

    let number = 0;
    for (const candidate of candidates) {
      const title = `${candidate.label} ${c.dim(`(${candidate.note})`)}`;
      if (candidate.available) {
        number += 1;
        write(`  ${c.cyan(String(number))}) ${title}  ${c.dim(candidate.reason)}`);
      } else {
        write(`  ${c.dim(`-) ${candidate.label} — ${candidate.reason}`)}`);
      }
    }
    write();

    if (selectable.length === 0) {
      throw new TorisError(
        'No backend is available to connect.\n' +
          `  Install the ${CANDIDATES.filter((one) => one.kind === 'cli')
            .map((one) => `"${one.bin}"`)
            .join(' or ')} CLI, or export ` +
          `${API_PROVIDERS.map((provider) => apiKeyEnvVar(provider)).join(' or ')}.`,
        'E_NO_BACKEND',
      );
    }

    const choiceAnswer = await ask(`Select a backend [1-${selectable.length}] (enter to cancel): `);
    if (choiceAnswer === null || choiceAnswer.trim() === '') return cancelled('no selection');

    const candidate = pickCandidate(candidates, choiceAnswer);
    if (!candidate) {
      throw new UsageError(
        `"${choiceAnswer.trim()}" is not one of the available choices (1-${selectable.length}).`,
      );
    }

    let model = '';
    if (candidate.kind === 'cli') {
      const pinned = await ask(
        `Model id for ${candidate.label} (enter for ${c.cyan(AUTO_MODEL)}): `,
      );
      if (pinned === null) return cancelled('interrupted');
      model = pinned.trim();
    } else {
      write(c.dim(`  ${candidate.label} needs an exact model id from the provider's own docs.`));
      const typed = await ask('Model id: ');
      if (typed === null) return cancelled('interrupted');
      model = typed.trim();
      if (model === '') {
        throw new TorisError(
          `Provider "${candidate.provider}" needs a concrete model id; nothing was entered.`,
          'E_MODEL_REQUIRED',
        );
      }
    }

    const nameAnswer = await ask(`Profile name (enter for ${c.cyan(DEFAULT_PROFILE_NAME)}): `);
    if (nameAnswer === null) return cancelled('interrupted');
    const profileName = normalizeProfileName(nameAnswer);

    const existingRoute = currentChatRoute(config);
    if (existingRoute && existingRoute !== profileName) {
      const confirm = await ask(
        `models.routing.chat currently points at "${existingRoute}". ` +
          `Repoint it to "${profileName}"? [y/N] `,
      );
      if (confirm === null || !YES.test(confirm.trim())) return cancelled('routing kept');
    }

    const next = buildConnectedConfig(config, {
      name: profileName,
      provider: candidate.provider,
      model,
    });
    await save(home, next);

    const saved = next.models.profiles[profileName];
    write();
    write(`${c.green('+')} Connected.`);
    keyValues([
      ['profile', profileName],
      ['provider', saved.provider],
      ['model', saved.model],
      ['config', configPath(home)],
    ]);
    write();
    write(`Next: ${c.cyan('toris chat')}`);

    return {
      ok: true,
      cancelled: false,
      profile: profileName,
      provider: saved.provider,
      model: saved.model,
      config: next,
    };
  } finally {
    if (ownsIo) channel.close?.();
  }
}

/** Flags arrive as `true` when written bare, so only real strings count. */
const flagString = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * `toris connect`
 * @param {{config:object, home:string, json:boolean}} ctx
 * @param {string[]} args
 * @param {Record<string,any>} flags
 */
export async function cmdConnect(ctx, args, flags = {}) {
  const provider = flagString(flags.provider);

  // Flags or --json mean "decide for me": no prompts, no TTY assumptions.
  if (provider === null && !ctx.json) {
    const result = await runConnectWizard({ config: ctx.config, home: ctx.home });
    if (result.cancelled) {
      line(c.dim(`Cancelled (${result.reason}). Nothing was written.`));
      return EXIT.OK;
    }
    return EXIT.OK;
  }

  if (provider === null) {
    throw new UsageError(
      'toris connect --json is non-interactive and needs --provider <id>. ' +
        `Valid ids: ${CONNECTABLE_PROVIDERS.join(', ')}.`,
    );
  }

  const name = flagString(flags.name) ?? DEFAULT_PROFILE_NAME;
  const next = buildConnectedConfig(ctx.config, {
    name,
    provider,
    model: flagString(flags.model) ?? '',
  });
  const profileName = normalizeProfileName(name);
  const saved = next.models.profiles[profileName];
  await saveConfig(ctx.home, next);

  if (ctx.json) {
    printJson({
      ok: true,
      profile: profileName,
      provider: saved.provider,
      model: saved.model,
      config: configPath(ctx.home),
    });
    return EXIT.OK;
  }

  line(`${c.green('+')} Connected.`);
  keyValues([
    ['profile', profileName],
    ['provider', saved.provider],
    ['model', saved.model],
    ['config', configPath(ctx.home)],
  ]);
  line();
  line(`Next: ${c.cyan('toris chat')}`);
  return EXIT.OK;
}
