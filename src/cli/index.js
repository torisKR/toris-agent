import { createRequire } from 'node:module';

import { resolveHome, loadConfig } from '../core/config.js';
import { listProfiles } from '../core/models.js';
import { Store } from '../core/store.js';
import { EXIT, UsageError, TorisError } from '../core/errors.js';
import { parseArgs } from './args.js';
import { setColor, errorLine, printJson, line, c } from './output.js';
import { printHelp } from './help.js';
import { needsOnboarding, renderOnboarding } from './tui/onboarding.js';
import { cmdInit, cmdDoctor, cmdVersion } from './commands/setup.js';
import { cmdProject } from './commands/project.js';
import { cmdRun, cmdRuns, cmdInspect, cmdReceipt, cmdLogs, cmdCancel } from './commands/run.js';
import { cmdAgents, cmdSkills, cmdAutonomy } from './commands/catalog.js';
import { cmdApprovals, cmdApprove, cmdReject } from './commands/approvals.js';
import { cmdDaemon } from './commands/daemon.js';
import { cmdChat } from './commands/chat.js';
import { cmdConnect } from './commands/connect.js';
import { cmdUpdate } from './commands/update.js';

const COMMANDS = {
  init: cmdInit,
  doctor: cmdDoctor,
  connect: cmdConnect,
  chat: cmdChat,
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
  autonomy: cmdAutonomy,
  daemon: cmdDaemon,
  update: cmdUpdate,
  version: cmdVersion,
};

/** Commands that must not fail merely because config does not exist yet. */
const CONFIG_OPTIONAL = new Set(['init', 'doctor', 'version', 'update']);

/** What a bare `toris` runs when a human is watching. */
const DEFAULT_INTERACTIVE_COMMAND = 'chat';

const require = createRequire(import.meta.url);
const torisVersion = () => require('../../package.json').version;

/** Both halves matter: a TUI needs somewhere to draw *and* someone to type. */
export const isInteractiveTerminal = (streams = process) =>
  Boolean(streams.stdin?.isTTY && streams.stdout?.isTTY);

/**
 * Decide what an invocation means before any I/O happens.
 *
 * A bare `toris` is ambiguous by design: at a terminal it should open the chat
 * TUI the way `claude` and `opencode` do, but in a pipe or in CI the same
 * command must keep its old help-and-fail contract — a prompt nobody can answer
 * is a hung build, which is far worse than a usage error.
 *
 * @param {{positionals:string[], flags:Record<string,any>, isInteractive:boolean}} input
 * @returns {{kind:'help', exitCode:number} | {kind:'command', name:string, isDefault:boolean}}
 */
export function resolveInvocation({ positionals, flags, isInteractive }) {
  const name = positionals[0];
  if (flags.help) return { kind: 'help', exitCode: name ? EXIT.OK : EXIT.USAGE };
  if (name) return { kind: 'command', name, isDefault: false };
  if (isInteractive && !flags.json) {
    return { kind: 'command', name: DEFAULT_INTERACTIVE_COMMAND, isDefault: true };
  }
  return { kind: 'help', exitCode: EXIT.USAGE };
}

/**
 * @param {string[]} argv
 * @param {{commands?:Record<string,Function>, isInteractive?:boolean}} [deps] Injection seam for tests.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  let json = false;
  try {
    const commands = deps.commands ?? COMMANDS;
    const isInteractive = deps.isInteractive ?? isInteractiveTerminal();
    const { positionals, flags } = parseArgs(argv);
    json = Boolean(flags.json);
    if (flags['no-color'] || flags.json) setColor(false);

    if (flags.version && positionals.length === 0) {
      return await cmdVersion({ json });
    }

    const invocation = resolveInvocation({ positionals, flags, isInteractive });
    if (invocation.kind === 'help') {
      if (json) {
        printJson({ usage: 'toris <command>', commands: Object.keys(commands) });
        return EXIT.OK;
      }
      printHelp();
      return invocation.exitCode;
    }

    const { name, isDefault } = invocation;
    const command = commands[name];
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
      ({ config, exists: configExists } = {
        config: (await import('../core/config.js')).DEFAULT_CONFIG,
        exists: false,
      });
    }

    // Typing the tool's name is how people discover it, so a first run teaches
    // instead of failing. Explicit `toris chat` still errors, because a script
    // that asked for chat by name wants a non-zero exit when it cannot run.
    // A command that onboards interactively by itself is left to do so.
    const firstRun =
      isDefault &&
      command.handlesFirstRun !== true &&
      needsOnboarding({ configExists, profileCount: listProfiles(config).length });
    if (firstRun) {
      for (const text of renderOnboarding({
        version: torisVersion(),
        configExists,
        profileCount: listProfiles(config).length,
        home,
      })) {
        line(text);
      }
      return EXIT.OK;
    }

    const store = new Store(home);
    if (!CONFIG_OPTIONAL.has(name)) await store.init();

    const ctx = {
      home,
      cwd: process.cwd(),
      config,
      configExists,
      store,
      json,
      verbose: Boolean(flags.verbose),
    };
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
