import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { TorisError, EXIT } from '../../core/errors.js';
import {
  resolveProfile,
  resolveRole,
  listProfiles,
  apiKeyEnvVar,
  readApiKey,
  AUTO_MODEL,
  API_PROVIDERS,
} from '../../core/models.js';
import { createProvider } from '../../providers/index.js';
import { createChatSession } from '../../core/chat.js';
import { createDefaultTools } from '../../core/tools.js';
import {
  discoverSkills,
  skillSearchPaths,
  renderSkillBriefing,
  BUILTIN_SKILL_DIR,
} from '../../core/skills.js';
import { c, printJson } from '../output.js';

/** Autonomy levels at or above this run mutating tools without asking. */
const AUTO_APPROVE_FROM = 3;

const SYSTEM_PROMPT = [
  "You are toris, a coding agent working inside a solo developer's repository.",
  'You have tools for reading, listing, writing files and running shell commands.',
  '',
  'Working rules:',
  '- Read a file before you edit it. Never guess its contents.',
  "- Verify your own work by running the project's tests or build.",
  '- Prefer the smallest change that actually solves the problem.',
  '- If a tool is denied, do not retry it. Explain the alternative.',
  '- Be concrete and brief. The operator is one person, not a committee.',
].join('\n');

/**
 * Pick the model for this chat: explicit flag, then the `chat` role in routing,
 * then a lone configured profile. Anything else is ambiguous, so we say so.
 */
function pickModel(config, flags) {
  if (typeof flags.profile === 'string') return resolveProfile(flags.profile, config);

  const profiles = listProfiles(config);
  if (profiles.length === 0) {
    throw new TorisError(
      'No model profiles are configured, so there is nothing to chat with.\n' +
        'Add one to your config under models.profiles, for example:\n' +
        '  "models": {\n' +
        '    "profiles": { "main": { "provider": "anthropic", "model": "<model-id>" } },\n' +
        '    "routing":  { "chat": "main" }\n' +
        '  }\n' +
        `Providers available for chat: ${API_PROVIDERS.join(', ')}.`,
      'E_UNKNOWN_PROFILE',
    );
  }

  try {
    return resolveRole('chat', config);
  } catch {
    if (profiles.length === 1) return resolveProfile(profiles[0], config);
    throw new TorisError(
      `Several profiles exist (${profiles.join(', ')}) but none is routed to "chat".\n` +
        'Set models.routing.chat, or pass --profile <name>.',
      'E_UNKNOWN_PROFILE',
    );
  }
}

/** Fail before the first token rather than after a confusing HTTP 401. */
function assertUsable(resolved) {
  if (!API_PROVIDERS.includes(resolved.provider)) {
    throw new TorisError(
      `Profile "${resolved.profile}" uses provider "${resolved.provider}", which is a CLI-backed ` +
        `adapter, not a chat transport. Chat needs one of: ${API_PROVIDERS.join(', ')}.`,
      'E_UNKNOWN_PROVIDER',
    );
  }
  if (!readApiKey(resolved.provider)) {
    throw new TorisError(
      `${apiKeyEnvVar(resolved.provider)} is not set, so "${resolved.profile}" cannot be used.\n` +
        `  export ${apiKeyEnvVar(resolved.provider)}=...`,
      'E_PROVIDER_AUTH',
    );
  }
  if (resolved.model === AUTO_MODEL) {
    throw new TorisError(
      `Profile "${resolved.profile}" has no model id ("auto" only works for CLI adapters).\n` +
        `Set models.profiles.${resolved.profile}.model to a concrete model id.`,
      'E_MODEL_REQUIRED',
    );
  }
}

const autonomyRank = (level) => Number(String(level ?? 'L2').replace(/^L/, '')) || 2;

/** Render a tool call compactly enough to judge it at a glance. */
function describeCall(call) {
  const preview = JSON.stringify(call.input ?? {});
  return `${call.name} ${preview.length > 160 ? `${preview.slice(0, 160)}…` : preview}`;
}

function buildApprover({ rl, autoApprove, log }) {
  return async (call) => {
    if (autoApprove) {
      log(c.dim(`  auto-approved: ${describeCall(call)}`));
      return true;
    }
    const answer = await rl.question(`${c.yellow('approve?')} ${describeCall(call)} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

const HELP = [
  '  /exit, /quit   leave the session',
  '  /clear         forget the transcript, keep the connection',
  '  /usage         tokens used so far',
  '  /model         which model is answering',
  '  /tools         list available tools',
  '  /skills        list loaded skill packages',
  '  /help          this list',
].join('\n');

/**
 * @param {{config:object, json:boolean}} ctx
 * @param {string[]} args
 * @param {Record<string,any>} flags
 */
export async function cmdChat(ctx, args, flags) {
  const { config, json } = ctx;
  const resolved = pickModel(config, flags);
  assertUsable(resolved);

  const provider = createProvider(resolved);
  const tools = flags['no-tools'] ? [] : createDefaultTools({ cwd: process.cwd() });

  const { skills, problems } = flags['no-skills']
    ? { skills: [], problems: [] }
    : await discoverSkills(
        skillSearchPaths({
          builtinDir: BUILTIN_SKILL_DIR,
          home: ctx.home,
          projectPath: process.cwd(),
        }),
      );
  const briefing = renderSkillBriefing(skills);
  const system = briefing ? `${SYSTEM_PROMPT}\n\n${briefing}` : SYSTEM_PROMPT;
  const autoApprove =
    Boolean(flags.yes) ||
    autonomyRank(flags.autonomy ?? config.defaultAutonomy) >= AUTO_APPROVE_FROM;

  const oneShot = args.length > 0;
  if (oneShot && json) {
    // Non-interactive JSON mode: no streaming, one clean object out.
    const session = createChatSession({
      provider,
      model: resolved.model,
      system,
      tools,
      maxTokens: resolved.maxTokens ?? undefined,
      approve: async () => autoApprove,
    });
    const result = await session.send(args.join(' '));
    printJson({
      ok: true,
      profile: resolved.profile,
      provider: resolved.provider,
      model: resolved.model,
      text: result.text,
      usage: result.usage,
    });
    return EXIT.OK;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const log = (line) => stdout.write(`${line}\n`);

  let streaming = false;
  const session = createChatSession({
    provider,
    model: resolved.model,
    system,
    tools,
    maxTokens: resolved.maxTokens ?? undefined,
    approve: buildApprover({ rl, autoApprove, log }),
    onEvent: (evt) => {
      if (evt.type === 'text') {
        streaming = true;
        stdout.write(evt.delta);
      } else if (evt.type === 'tool-start') {
        if (streaming) stdout.write('\n');
        streaming = false;
        log(c.dim(`  → ${describeCall(evt)}`));
      } else if (evt.type === 'tool-error') {
        log(c.red(`  ✗ ${evt.name}: ${evt.error}`));
      } else if (evt.type === 'tool-denied') {
        log(c.yellow(`  ✗ ${evt.name} denied`));
      }
    },
  });

  const askModel = async (text) => {
    try {
      await session.send(text);
    } catch (err) {
      log(c.red(`error  ${err.message}`));
    } finally {
      if (streaming) stdout.write('\n');
      streaming = false;
    }
  };

  if (oneShot) {
    await askModel(args.join(' '));
    rl.close();
    return EXIT.OK;
  }

  log(
    `${c.bold('toris chat')} ${c.dim(`· ${resolved.profile} · ${resolved.provider}/${resolved.model}`)}`,
  );
  log(
    c.dim(
      `${tools.length} tools · ${skills.length} skills · approvals ${autoApprove ? 'auto' : 'ask'} · /help for commands`,
    ),
  );
  for (const problem of problems) log(c.yellow(`  skill  ${problem.message}`));

  for (;;) {
    let line;
    try {
      line = (await rl.question(`\n${c.cyan('you ›')} `)).trim();
    } catch {
      break; // ctrl-d or closed stdin
    }
    if (line === '') continue;

    if (line.startsWith('/')) {
      const cmd = line.slice(1).toLowerCase();
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') log(HELP);
      else if (cmd === 'clear') {
        session.reset();
        log(c.dim('transcript cleared'));
      } else if (cmd === 'usage') {
        const u = session.usage;
        log(c.dim(`in ${u.inputTokens} · out ${u.outputTokens} · ${u.turns} model turns`));
      } else if (cmd === 'model') {
        log(c.dim(`${resolved.profile} → ${resolved.provider}/${resolved.model}`));
      } else if (cmd === 'tools') {
        log(
          tools.map((t) => `  ${t.name}${t.needsApproval ? c.yellow(' *') : ''}`).join('\n') ||
            '  (none)',
        );
      } else if (cmd === 'skills') {
        log(
          skills.map((s) => `  ${s.name}${c.dim(` — ${s.description}`)}`).join('\n') || '  (none)',
        );
      } else {
        log(c.dim(`unknown command "${line}". /help for the list.`));
      }
      continue;
    }

    await askModel(line);
  }

  rl.close();
  const u = session.usage;
  log(c.dim(`\n${u.inputTokens} in · ${u.outputTokens} out · ${u.turns} turns`));
  return EXIT.OK;
}
