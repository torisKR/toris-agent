import { EXIT, UsageError } from '../../core/errors.js';
import { printJson, line, c } from '../output.js';

/**
 * v0.1.0 runs synchronously in the foreground; there is no background daemon
 * yet. These commands report that honestly instead of pretending to work.
 */
export async function cmdDaemon(ctx, positionals) {
  const sub = positionals[0] ?? 'status';
  if (!['start', 'stop', 'status'].includes(sub)) {
    throw new UsageError(`Unknown subcommand "daemon ${sub}". Try: start | stop | status`);
  }
  const payload = {
    running: false,
    supported: false,
    reason: 'v0.1.0 executes runs in the foreground; the background daemon ships in a later release.',
  };
  if (ctx.json) { printJson(payload); return EXIT.DAEMON_UNAVAILABLE; }
  line(`${c.yellow('WARN')} ${payload.reason}`);
  line(`Use ${c.cyan('toris run "<goal>"')} directly.`);
  return EXIT.DAEMON_UNAVAILABLE;
}
