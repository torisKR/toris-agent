import { writeAgentProfile } from '../core/agents.js';
import { HttpError } from './http.js';

/**
 * Opt-in Studio write: one project-local `.toris/agents/<id>.json`.
 * Invalid schema / missing project path is 400. Duplicate file is 409.
 * Does not write `~/.toris/agents/`.
 */
export async function createStudioAgentProfile(input, { projectPath } = {}) {
  try {
    const written = await writeAgentProfile(input, { projectPath });
    const { file: _file, ...agent } = written;
    return { ok: true, written: true, agent, path: `.toris/agents/${agent.id}.json` };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.code === 'E_AGENT_EXISTS') throw new HttpError(409, error.message);
    if (error.code === 'E_INVALID_AGENT') throw new HttpError(400, error.message);
    throw error;
  }
}
