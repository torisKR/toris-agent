import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import { EXIT, TorisError } from '../../core/errors.js';
import { detectInstall, fetchLatestVersion, planUpdate, PACKAGE_NAME } from '../../core/update.js';
import { printJson, line, c } from '../output.js';

const require = createRequire(import.meta.url);

const show = (command) => command.join(' ');

/** Run the upgrade with output attached, so the package manager's progress is visible. */
function runInstall(command) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, { stdio: 'inherit', shell: false });
    child.on('error', (err) => resolve({ ok: false, message: err.message }));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, message: `${bin} exited with ${code}` }),
    );
  });
}

/**
 * Upgrade toris in place. The version check is cheap and the install is not, so
 * we never shell out when there is nothing new to fetch.
 *
 * @param {{json:boolean}} ctx
 * @param {string[]} _args
 * @param {Record<string,any>} flags
 */
export async function cmdUpdate(ctx, _args, flags) {
  const current = require('../../../package.json').version;
  const install = detectInstall();

  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    throw new TorisError(err.message, 'E_REGISTRY');
  }

  const plan = planUpdate({ current, latest, install });

  if (plan.action === 'none') {
    if (ctx.json) {
      printJson({ ok: true, updated: false, current, latest, reason: plan.reason });
      return EXIT.OK;
    }
    line(`${c.green('OK')} ${PACKAGE_NAME} ${current} is ${plan.reason}.`);
    return EXIT.OK;
  }

  if (plan.action === 'manual') {
    if (ctx.json) {
      printJson({
        ok: true,
        updated: false,
        current,
        latest,
        reason: plan.reason,
        command: show(plan.command),
      });
      return EXIT.OK;
    }
    line(`${c.yellow('!')} ${current} -> ${c.bold(latest)} available, but not applied here:`);
    line(c.dim(`  ${plan.reason}`));
    line();
    line(`  ${c.cyan(show(plan.command))}`);
    return EXIT.OK;
  }

  if (flags.check) {
    if (ctx.json) {
      printJson({
        ok: true,
        updated: false,
        available: true,
        current,
        latest,
        command: show(plan.command),
      });
      return EXIT.OK;
    }
    line(`${c.yellow('!')} ${current} -> ${c.bold(latest)} available.`);
    line(c.dim('  run: toris update'));
    return EXIT.OK;
  }

  if (!ctx.json) {
    line(`${c.bold('toris update')} ${c.dim(`· ${current} -> ${latest}`)}`);
    line(c.dim(`  ${show(plan.command)}`));
    line();
  }

  const result = await runInstall(plan.command);
  if (!result.ok) {
    throw new TorisError(
      `Update failed: ${result.message}\n` +
        `Try it yourself:\n  ${show(plan.command)}\n` +
        'A permission error means the global prefix is not writable; a Node version ' +
        'manager (nvm, fnm, volta) avoids needing sudo.',
      'E_UPDATE_FAILED',
    );
  }

  if (ctx.json) {
    printJson({ ok: true, updated: true, current, latest, command: show(plan.command) });
    return EXIT.OK;
  }
  line();
  line(`${c.green('OK')} Updated to ${c.bold(latest)}. Verify with ${c.cyan('toris --version')}.`);
  return EXIT.OK;
}
