import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { stdin, stdout } from 'node:process';

import { TorisError, EXIT } from '../../core/errors.js';
import { AUTONOMY_LEVELS, autoApprovesTools } from '../../core/autonomy.js';
import {
  resolveProfile,
  resolveRole,
  listProfiles,
  apiKeyEnvVar,
  readApiKey,
  AUTO_MODEL,
  API_PROVIDERS,
  CLI_PROVIDERS,
} from '../../core/models.js';
import { detectBinary } from '../../core/providers.js';
import { createProvider } from '../../providers/index.js';
import { createChatSession } from '../../core/chat.js';
import { createDefaultTools } from '../../core/tools.js';
import {
  createStreamWriter,
  createSpinner,
  renderRule,
  renderPrompt,
  renderUserEcho,
} from '../tui/render.js';
import {
  discoverSkills,
  skillSearchPaths,
  renderSkillBriefing,
  BUILTIN_SKILL_DIR,
} from '../../core/skills.js';
import { renderBanner, renderTurnStatus, resolveWidth, countOf } from '../tui/banner.js';
import { parseSlashCommand, isQuitWord, renderSlashHelp } from '../tui/slash.js';
import { createInterruptPolicy } from '../tui/interrupt.js';
import { SYM } from '../tui/theme.js';
import { c, printJson } from '../output.js';

const require = createRequire(import.meta.url);

/** An aborted request is a deliberate interrupt, not a failure to report. */
const isAbort = (err) => err?.name === 'AbortError' || err?.code === 'ABORT_ERR';

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
        'Run `toris connect` to pick a backend (installed claude/codex CLI, or an API key),\n' +
        'or add one to your config under models.profiles, for example:\n' +
        '  "models": {\n' +
        '    "profiles": { "main": { "provider": "claude-cli", "model": "auto" } },\n' +
        '    "routing":  { "chat": "main" }\n' +
        '  }\n' +
        `Providers available for chat: ${[...API_PROVIDERS, ...CLI_PROVIDERS].join(', ')}.`,
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

/** Map a CLI provider id onto its configured binary name. */
function cliBinFor(provider, config) {
  const key = provider === 'claude-cli' ? 'claude' : 'codex';
  return config?.providers?.[key]?.bin ?? key;
}

/** Fail before the first token rather than after a confusing HTTP 401. */
function assertUsable(resolved, config) {
  if (CLI_PROVIDERS.includes(resolved.provider)) {
    // CLI-backed chat reuses the agent CLI's own login; no API key involved.
    const bin = cliBinFor(resolved.provider, config);
    if (!detectBinary(bin)) {
      throw new TorisError(
        `Profile "${resolved.profile}" uses "${resolved.provider}", but the "${bin}" binary ` +
          'is not on PATH. Install it (or fix providers.' +
          `${resolved.provider === 'claude-cli' ? 'claude' : 'codex'}.bin) and log in first.`,
        'E_PROVIDER_CLI',
      );
    }
    return;
  }
  if (!API_PROVIDERS.includes(resolved.provider)) {
    throw new TorisError(
      `Profile "${resolved.profile}" uses provider "${resolved.provider}", which chat does not ` +
        `support. Chat needs one of: ${[...API_PROVIDERS, ...CLI_PROVIDERS].join(', ')}.`,
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

/** Render a tool call compactly enough to judge it at a glance. */
function describeCall(call) {
  const preview = JSON.stringify(call.input ?? {});
  return `${call.name} ${preview.length > 160 ? `${preview.slice(0, 160)}…` : preview}`;
}

/**
 * `isAutoApproved` is read per call, not captured, because `/autonomy` can
 * retune approvals in the middle of a session.
 */
function buildApprover({ rl, isAutoApproved, log }) {
  return async (call) => {
    if (isAutoApproved()) {
      log(c.dim(`  auto-approved: ${describeCall(call)}`));
      return true;
    }
    const answer = await rl.question(`${c.yellow('approve?')} ${describeCall(call)} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

/**
 * @param {{config:object, json:boolean}} ctx
 * @param {string[]} args
 * @param {Record<string,any>} flags
 */
export async function cmdChat(ctx, args, flags) {
  const { json } = ctx;
  let { config } = ctx;

  // Zero profiles + a real terminal = onboard instead of erroring, the way
  // opencode/gemini-cli do. Non-TTY and --json keep the explicit error.
  if (listProfiles(config).length === 0 && stdin.isTTY && !json) {
    const { runConnectWizard } = await import('./connect.js');
    const connected = await runConnectWizard({ config, home: ctx.home });
    if (!connected?.ok || connected.cancelled) {
      stdout.write(`${c.dim('connect cancelled — run `toris connect` when ready')}\n`);
      return EXIT.USAGE;
    }
    config = connected.config;
  }

  const resolved = pickModel(config, flags);
  assertUsable(resolved, config);

  // CLI-backed providers run their own agent loop (tools, skills, approvals)
  // inside the spawned CLI; driving a second tool loop from toris would run
  // every action twice. Delegate instead.
  const isCliBacked = CLI_PROVIDERS.includes(resolved.provider);
  // Held as a value so `/model` can rebuild a transport with identical settings.
  const providerOptions = {
    bins: {
      'claude-cli': cliBinFor('claude-cli', config),
      'codex-cli': cliBinFor('codex-cli', config),
    },
    timeoutMs: config.providerTimeoutMs,
    // An interactive session asks the same CLI many questions, so it keeps one
    // process warm; a one-shot answer has nothing to amortise the boot over.
    warm: !json && args.length === 0,
  };
  const provider = createProvider(resolved, providerOptions);
  const tools = flags['no-tools'] || isCliBacked ? [] : createDefaultTools({ cwd: process.cwd() });

  const { skills, problems } =
    flags['no-skills'] || isCliBacked
      ? { skills: [], problems: [] }
      : await discoverSkills(
          skillSearchPaths({
            builtinDir: BUILTIN_SKILL_DIR,
            home: ctx.home,
            projectPath: process.cwd(),
          }),
        );
  const briefing = renderSkillBriefing(skills);
  const system = isCliBacked
    ? undefined
    : briefing
      ? `${SYSTEM_PROMPT}\n\n${briefing}`
      : SYSTEM_PROMPT;
  const autoApprove =
    Boolean(flags.yes) || autoApprovesTools(flags.autonomy ?? config.defaultAutonomy);

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

  const UNWRAPPED_WIDTH = 1_000_000;
  const isTty = Boolean(stdout.isTTY);

  // Piped output must stay verbatim so `toris chat "..." | grep` keeps working.
  // Only an interactive terminal gets wrapping, indentation and a spinner.
  const streamWidth = () => (isTty ? resolveWidth(stdout.columns) : UNWRAPPED_WIDTH);
  const streamGutter = isTty ? '  ' : '';
  // The answer is marked once, then merely indented: one glyph per response,
  // the way claude-code separates model prose from everything else.
  const streamFirstGutter = isTty ? `${c.accent(SYM.dot)} ` : '';

  const write = (chunk) => stdout.write(chunk);
  const spinner = createSpinner({ write, isTTY: isTty });

  // Slash commands retune a live session, so what they touch has to be mutable:
  // /model swaps the transport, /autonomy swaps the approval policy.
  let active = resolved;
  let isAutoApproved = autoApprove;
  let autonomyLevel = String(flags.autonomy ?? config.defaultAutonomy ?? 'L2').toUpperCase();
  /** Spend from models used earlier in this session, so /usage stays cumulative. */
  let carriedUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };

  const approver = buildApprover({ rl, isAutoApproved: () => isAutoApproved, log });

  /** @type {{push: (chunk: string) => void, end: () => void, isEmpty: () => boolean} | null} */
  let writer = null;

  // Width is sampled when a turn starts, so resizing between turns takes effect.
  const openWriter = () => {
    spinner.stop();
    writer ??= createStreamWriter({
      write,
      width: streamWidth(),
      gutter: streamGutter,
      firstGutter: streamFirstGutter,
    });
    return writer;
  };
  const closeWriter = () => {
    writer?.end();
    writer = null;
  };

  const onEvent = (evt) => {
    if (evt.type === 'text') {
      openWriter().push(evt.delta);
      return;
    }
    // Any non-text event interrupts the prose, so close the block first and
    // silence the spinner before writing a line of our own.
    closeWriter();
    spinner.stop();
    if (evt.type === 'tool-start') log(c.dim(`  ${SYM.arrow} ${describeCall(evt)}`));
    else if (evt.type === 'tool-error') log(c.red(`  ${SYM.cross} ${evt.name}: ${evt.error}`));
    else if (evt.type === 'tool-denied') log(c.yellow(`  ${SYM.cross} ${evt.name} denied`));
  };

  /** Sessions are rebuilt rather than mutated, so /model can hand over cleanly. */
  const makeSession = (target, wire) =>
    createChatSession({
      provider: wire,
      model: target.model,
      system,
      tools,
      maxTokens: target.maxTokens ?? undefined,
      // The approval prompt is drawn by readline and arrives BEFORE the
      // `tool-start` event, so the spinner and any open prose block have to be
      // torn down here — otherwise the spinner's line-erase eats the question.
      approve: (call) => {
        closeWriter();
        spinner.stop();
        return approver(call);
      },
      onEvent,
    });

  let session = makeSession(resolved, provider);
  /** The transport `session` is currently speaking through, so it can be torn
   *  down: a warm CLI-backed provider owns a child process. */
  let transport = provider;

  const totalUsage = () => {
    const live = session.usage;
    return {
      inputTokens: carriedUsage.inputTokens + live.inputTokens,
      outputTokens: carriedUsage.outputTokens + live.outputTokens,
      turns: carriedUsage.turns + live.turns,
    };
  };

  /** Non-null only while the model is answering; ctrl-c aborts it. */
  let generation = null;

  const askModel = async (text) => {
    generation = new AbortController();
    spinner.start('thinking');
    try {
      await session.send(text, { signal: generation.signal });
    } catch (err) {
      // Stop the spinner before printing, or its line-erase would wipe the message.
      spinner.stop();
      closeWriter();
      log(isAbort(err) ? c.yellow('  interrupted') : c.red(`error  ${err.message}`));
    } finally {
      generation = null;
      spinner.stop();
      closeWriter();
    }
  };

  if (oneShot) {
    await askModel(args.join(' '));
    rl.close();
    transport.dispose?.();
    return EXIT.OK;
  }

  const terminalWidth = () => resolveWidth(stdout.columns);
  const delegated = (value) => (isCliBacked ? 'delegated' : value);

  const showModel = () => log(c.dim(`${active.profile} → ${active.provider}/${active.model}`));

  const showAutonomy = () => {
    const level = AUTONOMY_LEVELS[autonomyLevel] ?? AUTONOMY_LEVELS.L2;
    log(
      c.dim(
        `${level.level} · ${level.label} · approvals ${delegated(isAutoApproved ? 'auto' : 'ask')}`,
      ),
    );
  };

  const setAutonomy = (value) => {
    const level = AUTONOMY_LEVELS[String(value).toUpperCase()];
    if (!level) {
      log(c.yellow(`  unknown autonomy "${value}". Use one of L1..L5.`));
      return;
    }
    autonomyLevel = level.level;
    isAutoApproved = Boolean(flags.yes) || autoApprovesTools(level.level);
    showAutonomy();
  };

  /**
   * Swap the answering model without losing the conversation: the transcript is
   * provider-neutral, so it replays into a fresh session untouched.
   */
  const switchModel = (name) => {
    let next;
    try {
      next = resolveProfile(name, config);
      assertUsable(next, config);
    } catch (err) {
      log(c.yellow(`  ${err.message}`));
      return;
    }
    if (CLI_PROVIDERS.includes(next.provider) !== isCliBacked) {
      // Tools and skills were wired for one backend kind at startup; pretending
      // otherwise would silently drop them.
      log(c.yellow('  that profile uses a different backend kind — restart toris to switch.'));
      return;
    }

    const history = session.history;
    carriedUsage = totalUsage();
    // The outgoing transport may hold a warm child; swapping without ending it
    // would leak a `claude` process for the rest of the session.
    transport.dispose?.();
    transport = createProvider(next, providerOptions);
    transport.prewarm?.();
    session = makeSession(next, transport);
    session.reset(history);
    active = next;
    showModel();
  };

  const listLines = (items) => (items.length > 0 ? items.join('\n') : '  (none)');

  /** @type {Record<string, (args: string[]) => void>} */
  const slashHandlers = {
    help: () => log(renderSlashHelp()),
    model: (rest) => (rest.length > 0 ? switchModel(rest[0]) : showModel()),
    autonomy: (rest) => (rest.length > 0 ? setAutonomy(rest[0]) : showAutonomy()),
    tools: () =>
      log(listLines(tools.map((t) => `  ${t.name}${t.needsApproval ? c.yellow(' *') : ''}`))),
    skills: () => log(listLines(skills.map((s) => `  ${s.name}${c.dim(` — ${s.description}`)}`))),
    usage: () => {
      const u = totalUsage();
      log(c.dim(`in ${u.inputTokens} · out ${u.outputTokens} · ${countOf(u.turns, 'model turn')}`));
    },
    clear: () => {
      session.reset();
      log(c.dim('transcript cleared'));
    },
  };

  const interrupts = createInterruptPolicy();
  let leaving = false;
  /** Lets a confirmed ctrl-c break out of the pending prompt. */
  let promptAbort = null;

  // Writing over a live prompt loses whatever was typed, so redraw it after.
  const notify = (text) => {
    stdout.write(`\n${text}\n`);
    rl.prompt(true);
  };

  rl.on('SIGINT', () => {
    const action = interrupts.press({
      isGenerating: generation !== null,
      hasInput: rl.line.trim() !== '',
    });
    if (action === 'cancel') {
      generation?.abort();
      return;
    }
    if (action === 'clear') {
      // ctrl-u then ctrl-k wipes the line on both sides of the cursor.
      rl.write(null, { ctrl: true, name: 'u' });
      rl.write(null, { ctrl: true, name: 'k' });
      return;
    }
    if (action === 'confirm') {
      notify(c.dim('press ctrl-c again to exit'));
      return;
    }
    leaving = true;
    promptAbort?.abort();
  });

  /**
   * Draw the input area: a dim rule to close the previous turn, then an accent
   * caret. Non-TTY output stays a bare prompt so piped transcripts are clean.
   */
  const readLine = async () => {
    promptAbort = new AbortController();
    if (isTty) stdout.write(`\n${renderRule(terminalWidth())}\n`);
    try {
      return await rl.question(isTty ? renderPrompt() : '> ', { signal: promptAbort.signal });
    } finally {
      promptAbort = null;
    }
  };

  /** Push what was just typed into the background, so the answer leads. */
  const echoSubmitted = (text) => {
    if (!isTty) return;
    const chunk = renderUserEcho(text, terminalWidth());
    if (chunk) stdout.write(chunk);
  };

  // Start the backend booting now: the banner, the skill warnings and the
  // operator's first message all happen while it comes up, so the first answer
  // does not begin with a cold start.
  transport.prewarm?.();

  for (const text of renderBanner({
    version: require('../../../package.json').version,
    profile: active.profile,
    provider: active.provider,
    model: active.model,
    cwd: process.cwd(),
    autonomy: autonomyLevel,
    approvals: delegated(isAutoApproved ? 'auto' : 'ask'),
    tools: delegated(tools.length),
    skills: delegated(skills.length),
    width: terminalWidth(),
  })) {
    log(text);
  }
  for (const problem of problems) log(c.yellow(`  skill  ${problem.message}`));

  for (;;) {
    let line;
    try {
      line = (await readLine()).trim();
    } catch {
      break; // ctrl-d, closed stdin, or a confirmed ctrl-c
    }
    if (leaving) break;
    if (line === '') continue;
    if (isQuitWord(line)) break;

    const slash = parseSlashCommand(line);
    if (slash) {
      if (slash.name === 'exit') break;
      const handler = slashHandlers[slash.name];
      if (handler) handler(slash.args);
      else log(c.dim(`unknown command "${slash.raw}". /help for the list.`));
      continue;
    }

    echoSubmitted(line);
    const startedAt = Date.now();
    await askModel(line);
    if (isTty) {
      log(
        renderTurnStatus({
          ...active,
          usage: totalUsage(),
          width: terminalWidth(),
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }
  }

  rl.close();
  transport.dispose?.();
  const u = totalUsage();
  log(c.dim(`\n${u.inputTokens} in · ${u.outputTokens} out · ${countOf(u.turns, 'turn')}`));
  return EXIT.OK;
}

// Chat onboards a fresh install itself (the connect wizard above), so the CLI
// entry point must not preempt it with a static first-run message.
cmdChat.handlesFirstRun = true;
