/**
 * How an operator reaches the same local agent from a terminal or a browser.
 *
 * The TUI and Studio GUI are two doors onto one catalogue, so the URLs and
 * command lines live in one place. Product copy can import these instead of
 * restating `127.0.0.1:5824` in every surface.
 */

import { spawn } from 'node:child_process';

export const STUDIO_HOST = '127.0.0.1';
export const STUDIO_PORT = 5824;
export const STUDIO_AGENT_PATH = '/agent';
export const STUDIO_DESIGN_PATH = '/design';
export const STUDIO_PATCHES_PATH = '/patches';

/** @param {number} [port] */
export const studioOrigin = (port = STUDIO_PORT) => `http://${STUDIO_HOST}:${port}`;

/** @param {number} [port] */
export const studioAgentUrl = (port = STUDIO_PORT) => `${studioOrigin(port)}${STUDIO_AGENT_PATH}`;

/** @param {number} [port] */
export const studioDesignUrl = (port = STUDIO_PORT) => `${studioOrigin(port)}${STUDIO_DESIGN_PATH}`;

/** @param {number} [port] */
export const studioPatchesUrl = (port = STUDIO_PORT) => `${studioOrigin(port)}${STUDIO_PATCHES_PATH}`;

/**
 * One-screen directions for the `/studio` slash command and the GUI inspector.
 * @param {{running?:boolean, port?:number}} [info]
 */
export function renderStudioAccess({ running = false, port = STUDIO_PORT } = {}) {
  const gui = studioAgentUrl(port);
  return [
    `GUI  ${gui}`,
    `     ${studioDesignUrl(port)}`,
    `     ${studioPatchesUrl(port)}`,
    'TUI  toris',
    running ? '     already running' : '     toris studio --open    start and open the local GUI',
  ].join('\n');
}

/** Hostnames this opener will follow. Anything else stays in the terminal. */
const LOOPBACK_HOSTS = new Set([STUDIO_HOST, 'localhost', '::1']);

/** @param {unknown} value */
export function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** @param {string} [platform] */
export function openLocalCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/**
 * Open a loopback URL in the default browser. Never uses a shell, and never
 * follows a URL off 127.0.0.1 / localhost / ::1.
 *
 * Tests inject `opener` (or `spawn`) so this never shells out in CI.
 *
 * @param {string} url
 * @param {{opener?:(url:string)=>unknown, spawn?:typeof spawn, platform?:string}} [deps]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function openLocalUrl(url, deps = {}) {
  if (!isLoopbackHttpUrl(url)) {
    return Promise.resolve({ ok: false, error: 'only loopback URLs can be opened' });
  }
  if (typeof deps.opener === 'function') {
    return Promise.resolve()
      .then(() => deps.opener(url))
      .then((result) => (result && typeof result === 'object' && 'ok' in result ? result : { ok: true }))
      .catch((error) => ({ ok: false, error: error.message }));
  }
  const spawnFn = deps.spawn || spawn;
  const { command, args } = openLocalCommand(deps.platform);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawnFn(command, [...args, url], { stdio: 'ignore', detached: true, shell: false });
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }
    child.once('error', (error) => finish({ ok: false, error: error.message }));
    child.once('spawn', () => {
      child.unref?.();
      finish({ ok: true });
    });
  });
}

/**
 * The typed command that opens this agent in the TUI, so the GUI can show it.
 * @param {string} [agentId]
 */
export function tuiAgentHint(agentId = 'toris') {
  const id = String(agentId || 'toris');
  if (id === 'toris') return 'toris\n/agent';
  return `toris --agent ${id}\n/agent ${id}`;
}
