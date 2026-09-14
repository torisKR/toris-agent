/**
 * How an operator reaches the same local agent from a terminal or a browser.
 *
 * The TUI and Studio GUI are two doors onto one catalogue, so the URLs and
 * command lines live in one place. Product copy can import these instead of
 * restating `127.0.0.1:5824` in every surface.
 */

export const STUDIO_HOST = '127.0.0.1';
export const STUDIO_PORT = 5824;
export const STUDIO_AGENT_PATH = '/agent';

/** @param {number} [port] */
export const studioOrigin = (port = STUDIO_PORT) => `http://${STUDIO_HOST}:${port}`;

/** @param {number} [port] */
export const studioAgentUrl = (port = STUDIO_PORT) => `${studioOrigin(port)}${STUDIO_AGENT_PATH}`;

/**
 * One-screen directions for the `/studio` slash command and the GUI inspector.
 * @param {{running?:boolean, port?:number}} [info]
 */
export function renderStudioAccess({ running = false, port = STUDIO_PORT } = {}) {
  const gui = studioAgentUrl(port);
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
