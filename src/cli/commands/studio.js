import { EXIT, TorisError, UsageError } from '../../core/errors.js';
import { createStudioServer } from '../../studio/server.js';
import { StudioServiceManager } from '../../studio/service/manager.js';
import { openLocalUrl, studioOrigin } from '../../core/access.js';
import { line, c, printJson } from '../output.js';

const SERVICE_COMMANDS = new Set(['install', 'status', 'restart', 'uninstall']);

async function runServiceCommand(ctx, positionals, deps) {
  const subcommand = positionals[1] || 'status';
  if (!SERVICE_COMMANDS.has(subcommand) || positionals.length > 2) {
    throw new UsageError(`Unknown studio service subcommand "${positionals.slice(1).join(' ')}"`);
  }
  const manager = deps.serviceManager || new StudioServiceManager({ torisHome: ctx.home });
  const result = await manager[subcommand]();
  if (ctx.json) (deps.printJson || printJson)(result);
  else (deps.output || line)(`${result.running ? c.green('RUNNING') : c.yellow('STOPPED')} ${result.label}`);
  return EXIT.OK;
}

async function openStudio(url, deps, output) {
  const opened = await (deps.openLocalUrl || openLocalUrl)(url);
  output(c.dim(opened.ok ? '      opened in browser' : `      browser: ${opened.error || 'unavailable'}`));
  return opened;
}

function printReady(output, label = 'READY') {
  const origin = studioOrigin();
  output(`${label === 'ATTACHED' ? c.yellow('ATTACHED') : c.green('READY')} Toris Studio ${origin}`);
  output(c.dim(`      agent GUI  ${origin}/agent`));
  output(c.dim('      design     http://127.0.0.1:5824/design'));
  output(c.dim('      patches    http://127.0.0.1:5824/patches'));
  output(c.dim('      knowledge  http://127.0.0.1:5824/knowledge'));
  output(c.dim('      daemon     http://127.0.0.1:5824/daemon'));
  output(c.dim('      agent TUI  toris   ·  /agent  ·  /studio'));
}

export async function cmdStudio(ctx, positionals, flags = {}, deps = {}) {
  if (positionals[0] === 'service') return await runServiceCommand(ctx, positionals, deps);
  if (positionals.length > 0) throw new UsageError(`Unknown studio subcommand "${positionals.join(' ')}"`);
  const create = deps.createStudioServer || createStudioServer;
  const signals = deps.signals || process;
  const output = deps.output || line;
  const studio = await create({ home: ctx.home, host: '127.0.0.1', port: 5824, cwd: ctx.cwd });
  try {
    await studio.listen();
  } catch (error) {
    await studio.close().catch(() => undefined);
    if (error.code === 'EADDRINUSE') {
      if (flags.open) {
        printReady(output, 'ATTACHED');
        await openStudio(studioOrigin(), deps, output);
        return EXIT.OK;
      }
      throw new TorisError('Toris Studio cannot start because 127.0.0.1:5824 is already in use.', 'E_STUDIO_IN_USE');
    }
    throw error;
  }

  printReady(output);
  if (flags.open) await openStudio(studioOrigin(), deps, output);
  return await new Promise((resolve, reject) => {
    let stopping = false;
    const cleanup = () => {
      signals.off('SIGINT', stop);
      signals.off('SIGTERM', stop);
    };
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      cleanup();
      try {
        await studio.close();
        resolve(EXIT.OK);
      } catch (error) {
        reject(error);
      }
    };
    signals.once('SIGINT', stop);
    signals.once('SIGTERM', stop);
    deps.onReady?.();
  });
}

cmdStudio.handlesFirstRun = true;
