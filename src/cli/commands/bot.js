import { EXIT, TorisError, UsageError } from '../../core/errors.js';
import { loadProjects } from './project.js';
import { line, c, printJson } from '../output.js';
import {
  connectSlackSocket,
  describeBotBindings,
  pollTelegramOnce,
} from '../../bot/runtime.js';

export async function cmdBot(ctx, positionals, flags, deps = {}) {
  if (positionals.length > 0) {
    throw new UsageError(`Unknown bot subcommand "${positionals.join(' ')}"`);
  }
  const env = deps.env || process.env;
  const botCtx = {
    ...ctx,
    env,
    cwd: ctx.cwd,
    projects: await loadProjects(ctx).catch(() => []),
  };
  const bindings = describeBotBindings(ctx.config, env);
  if (!bindings.telegram && !bindings.slack) {
    throw new TorisError(
      'No bot channel is configured. Set TORIS_TELEGRAM_BOT_TOKEN and/or TORIS_SLACK_BOT_TOKEN + TORIS_SLACK_APP_TOKEN, then rerun `toris bot`.',
      'E_BOT_CONFIG',
    );
  }

  if (ctx.json) {
    printJson({ ok: true, bindings });
  } else {
    line(`${c.green('READY')} toris bot`);
    if (bindings.telegram) line(c.dim('  telegram long-poll'));
    if (bindings.slack) line(c.dim('  slack socket mode'));
    line(c.dim(`  workspace ${bindings.workspace || ctx.cwd}`));
    line(c.dim('  /run /patches /apply /discard /status'));
  }

  const fetchImpl = deps.fetchImpl || fetch;
  let offset = 0;
  let slack = null;
  if (bindings.slack) {
    slack = await connectSlackSocket(botCtx, { fetchImpl, webSocket: deps.webSocket });
  }

  const signals = deps.signals || process;
  return await new Promise((resolve, reject) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        slack?.close?.();
        resolve(EXIT.OK);
      } catch (error) {
        reject(error);
      }
    };
    signals.once?.('SIGINT', stop);
    signals.once?.('SIGTERM', stop);
    deps.onReady?.({ stop, bindings });

    const loop = async () => {
      while (!stopping && bindings.telegram) {
        try {
          offset = await pollTelegramOnce(botCtx, offset, { fetchImpl, timeout: 25 });
        } catch (error) {
          if (stopping) break;
          line(`${c.yellow('WARN')} telegram ${error.message}`);
          await new Promise((wait) => setTimeout(wait, 2000));
        }
      }
    };
    if (bindings.telegram) loop().catch(reject);
  });
}

cmdBot.handlesFirstRun = true;
