import { EXIT, TorisError, UsageError } from '../../core/errors.js';
import { createStudioServer } from '../../studio/server.js';
import { line, c } from '../output.js';

export async function cmdStudio(ctx, positionals, _flags, deps = {}) {
  if (positionals.length > 0) throw new UsageError(`Unknown studio subcommand "${positionals.join(' ')}"`);
  const create = deps.createStudioServer || createStudioServer;
  const signals = deps.signals || process;
  const output = deps.output || line;
  const studio = await create({ home: ctx.home, host: '127.0.0.1', port: 5824 });
  try {
    await studio.listen();
  } catch (error) {
    await studio.close().catch(() => undefined);
    if (error.code === 'EADDRINUSE') {
      throw new TorisError('Toris Studio cannot start because 127.0.0.1:5824 is already in use.', 'E_STUDIO_IN_USE');
    }
    throw error;
  }

  output(`${c.green('READY')} Toris Studio http://127.0.0.1:5824`);
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
