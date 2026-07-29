/**
 * First-run guidance for a bare `toris`.
 *
 * Someone who has just installed the tool and typed its name has not opted into
 * a stack trace. An unconfigured launch is the *expected* first experience, so
 * it exits 0 with the three things left to do rather than raising E_CONFIG.
 */

import { c } from '../output.js';
import { configPath } from '../../core/config.js';
import { shortenPath } from './banner.js';

/**
 * @param {{configExists:boolean, profileCount:number}} state
 * @returns {boolean} True when there is nothing to chat with yet.
 */
export function needsOnboarding({ configExists, profileCount }) {
  return !configExists || (profileCount ?? 0) === 0;
}

/**
 * The remaining setup steps, most-blocking first.
 * @param {{configExists:boolean, profileCount:number, home:string}} state
 * @returns {Array<{done:boolean, title:string, detail:string}>}
 */
export function onboardingSteps({ configExists, profileCount, home }) {
  return [
    {
      done: Boolean(configExists),
      title: 'toris init',
      detail: `writes ${shortenPath(configPath(home))}`,
    },
    {
      done: (profileCount ?? 0) > 0,
      title: 'toris connect',
      detail: 'or set models.profiles.<name> and models.routing.chat by hand',
    },
    {
      done: false,
      title: 'export ANTHROPIC_API_KEY=... (or OPENAI_API_KEY)',
      detail: 'keys live in the environment, never in the config file',
    },
  ];
}

/**
 * @param {{version:string, configExists:boolean, profileCount:number, home:string}} state
 * @returns {string[]} Lines ready to print, in order.
 */
export function renderOnboarding({ version, configExists, profileCount, home }) {
  const steps = onboardingSteps({ configExists, profileCount, home });
  const headline = configExists
    ? 'No model profile is configured, so there is nothing to chat with yet.'
    : 'Nothing is set up yet, so there is nothing to chat with.';

  return [
    `${c.bold('toris')} ${c.dim(version)}`,
    '',
    headline,
    '',
    ...steps.map(
      (step, i) =>
        `  ${step.done ? c.green('✓') : c.dim(String(i + 1))} ${step.title}\n` +
        `    ${c.dim(step.detail)}`,
    ),
    '',
    c.dim('Then run `toris` again. `toris doctor` checks all three.'),
  ];
}
