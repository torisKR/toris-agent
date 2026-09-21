import { updateAgentProfile, writeAgentProfile } from '../core/agents.js';
import { HttpError } from './http.js';

function presentWritten(written) {
  const { file: _file, ...agent } = written;
  return { ok: true, written: true, agent, path: `.toris/agents/${agent.id}.json` };
}

function studioAgentWriteError(error) {
  if (error instanceof HttpError) throw error;
  if (error.code === 'E_AGENT_EXISTS') throw new HttpError(409, error.message);
  if (error.code === 'E_AGENT_NOT_FOUND') throw new HttpError(404, error.message);
  if (error.code === 'E_INVALID_AGENT') throw new HttpError(400, error.message);
  throw error;
}

/**
 * Opt-in Studio write: one project-local `.toris/agents/<id>.json`.
 * Invalid schema / missing project path is 400. Duplicate file is 409.
 * Does not write `~/.toris/agents/`.
 */
export async function createStudioAgentProfile(input, { projectPath } = {}) {
  try {
    return presentWritten(await writeAgentProfile(input, { projectPath }));
  } catch (error) {
    studioAgentWriteError(error);
  }
}

/**
 * Opt-in Studio update of one existing project-local `.toris/agents/<id>.json`.
 * Path id is immutable. Home/builtin (no project file) is 404. Invalid schema is 400.
 * Does not write `~/.toris/agents/`.
 */
export async function updateStudioAgentProfile(id, input, { projectPath } = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (Object.hasOwn(body, 'id') && body.id !== id) {
    throw new HttpError(400, `id is immutable; path id "${id}" does not match body id "${body.id}".`);
  }
  try {
    return presentWritten(await updateAgentProfile({ ...body, id }, { projectPath }));
  } catch (error) {
    studioAgentWriteError(error);
  }
}
