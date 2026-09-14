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

/** @param {number} [port] */
export const studioOrigin = (port = STUDIO_PORT) => `http://${STUDIO_HOST}:${port}`;

/**
 * @param {number} [port]
 * @param {string} [agentId]
 */
export function studioAgentUrl(port = STUDIO_PORT, agentId = 'toris') {
  const base = `${studioOrigin(port)}${STUDIO_AGENT_PATH}`;
  const id = String(agentId || 'toris');
  if (id === 'toris') return base;
  return `${base}?id=${encodeURIComponent(id)}`;
}

/**
 * One-screen directions for the `/studio` slash command and the GUI inspector.
 * @param {{running?:boolean, port?:number, agentId?:string}} [info]
 */
export function renderStudioAccess({ running = false, port = STUDIO_PORT, agentId = 'toris' } = {}) {
  const gui = studioAgentUrl(port, agentId);
  return [
    `GUI  ${gui}`,
    'TUI  toris',
    running ? '     already running' : '     toris studio    start the local GUI',
  ].join('\n');
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

/** @param {string} platform */
export function openLocalCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/** @param {unknown} value */
export function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === STUDIO_HOST || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Open a loopback URL in the default browser. Never uses a shell, and never
 * follows a URL off 127.0.0.1 / localhost.
 *
 * @param {string} url
 * @param {{spawn?:typeof spawn, platform?:string}} [deps]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function openLocalUrl(url, deps = {}) {
  if (!isLoopbackHttpUrl(url)) {
    return Promise.resolve({ ok: false, error: 'only loopback URLs can be opened' });
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
