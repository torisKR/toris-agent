import { resolveHome, loadConfig } from '../core/config.js';
import { Store } from '../core/store.js';
import { EXIT, UsageError, TorisError } from '../core/errors.js';
import { parseArgs } from './args.js';
import { setColor, errorLine, printJson, c } from './output.js';
import { printHelp } from './help.js';
import { cmdInit, cmdDoctor, cmdVersion } from './commands/setup.js';
import { cmdProject } from './commands/project.js';
import { cmdRun, cmdRuns, cmdInspect, cmdReceipt, cmdLogs, cmdCancel } from './commands/run.js';
import { cmdAgents, cmdSkills } from './commands/catalog.js';
import { cmdApprovals, cmdApprove, cmdReject } from './commands/approvals.js';
import { cmdDaemon } from './commands/daemon.js';

const COMMANDS = {
  init: cmdInit,
  doctor: cmdDoctor,
  project: cmdProject,
  run: cmdRun,
  runs: cmdRuns,
  inspect: cmdInspect,
  receipt: cmdReceipt,
  logs: cmdLogs,
  cancel: cmdCancel,
  approvals: cmdApprovals,
  approve: cmdApprove,
  reject: cmdReject,
  agents: cmdAgents,
  skills: cmdSkills,
  daemon: cmdDaemon,
  version: cmdVersion,
};

/** Commands that must not fail merely because config does not exist yet. */
const CONFIG_OPTIONAL = new Set(['init', 'doctor', 'version']);

export async function main(argv = process.argv.slice(2)) {
  let json = false;
  try {
    const { positionals, flags } = parseArgs(argv);
    json = Boolean(flags.json);
    if (flags['no-color'] || flags.json) setColor(false);

    if (flags.version && positionals.length === 0) {
      return await cmdVersion({ json });
    }
    const name = positionals[0];
    if (!name || flags.help) {
      if (json) { printJson({ usage: 'toris <command>', commands: Object.keys(COMMANDS) }); return EXIT.OK; }
      printHelp();
      return name ? EXIT.OK : EXIT.USAGE;
    }

    const command = COMMANDS[name];
    if (!command) {
      throw new UsageError(`Unknown command "${name}". Run \`toris --help\`.`);
    }

    const home = resolveHome(typeof flags.home === 'string' ? flags.home : undefined);
    let config;
    let configExists = false;
    try {
      ({ config, exists: configExists } = await loadConfig(home));
    } catch (err) {
      if (!CONFIG_OPTIONAL.has(name)) throw new TorisError(err.message, 'E_CONFIG');
      ({ config, exists: configExists } = { config: (await import('../core/config.js')).DEFAULT_CONFIG, exists: false });
    }

    const store = new Store(home);
    if (!CONFIG_OPTIONAL.has(name)) await store.init();

    const ctx = { home, config, configExists, store, json, verbose: Boolean(flags.verbose) };
    return await command(ctx, positionals.slice(1), flags);
  } catch (err) {
    const exitCode = err instanceof TorisError ? err.exitCode : EXIT.FAILURE;
    if (json) {
      printJson({ ok: false, error: { code: err.code ?? 'E_UNKNOWN', message: err.message } });
    } else {
      errorLine(`${c.red('error')} ${err.message}`);
      if (err instanceof UsageError) errorLine(c.dim('Run `toris --help` for usage.'));
      if (process.env.TORIS_DEBUG) errorLine(String(err.stack));
    }
    return exitCode;
  }
}
